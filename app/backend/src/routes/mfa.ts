import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware, invalidateTokenCache } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';
import { ERR } from '../utils/errorCodes.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { kickSession } from '../websocket/index.js';
import { revokeUserSessions } from '../services/sessionService.js';
import {
  isMfaAvailable, getMfaStatus, startMfaSetup, enableMfa, clearMfa, verifySecondFactor, getRequireMfa,
  isMfaVerifyLocked, recordMfaVerifyFailure, clearMfaVerifyFailures,
} from '../services/mfaService.js';

// 내 2단계 인증(E7b). /users/me/2fa 아래에 /users보다 먼저 붙는다.
// 조직이 2FA를 필수로 했는데 아직 등록하지 않은 사용자도 이 경로는 쓸 수 있다(authMiddleware의 허용 목록).
const router = Router();
router.use(authMiddleware);

const TOO_MANY = { error: 'Too many failed attempts. Try again later.', code: ERR.AUTH_TOO_MANY_ATTEMPTS };
const UNAVAILABLE = { error: 'Two-factor authentication is not available on this server', code: ERR.MFA_UNAVAILABLE };
// 틀린 코드는 401이 아니라 400으로 답한다(로그인된 화면에서 401은 로그아웃으로 처리된다).
const INVALID_CODE = { error: 'Invalid authentication code', code: ERR.MFA_INVALID_CODE };

const codeSchema = z.string().trim().min(1).max(32);

// GET /users/me/2fa - 내 2FA 상태. available은 서버에 암호화 키가 있는지, required는 조직 정책이다.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const status = await getMfaStatus(req.user!.userId);
    res.json({
      enabled: status.enabled,
      enabledAt: status.enabledAt,
      recoveryCodesRemaining: status.recoveryCodesRemaining,
      available: isMfaAvailable(),
      required: await getRequireMfa(),
    });
  } catch (error) {
    logError('Get 2FA status error', error);
    res.status(500).json({ error: 'Failed to get 2FA status', code: ERR.INTERNAL_ERROR });
  }
});

// POST /users/me/2fa/setup - 새 비밀을 만든다. QR은 프런트가 otpauthUri로 로컬에서 그린다(외부 QR 서비스 금지).
// 다시 부르면 이전 등록 대기 비밀은 버려진다.
router.post('/setup', async (req: AuthRequest, res: Response) => {
  try {
    if (!isMfaAvailable()) {
      res.status(503).json(UNAVAILABLE);
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { id: true, email: true, mfaEnabledAt: true } });
    if (!user) {
      res.status(404).json({ error: 'User not found', code: ERR.NOT_FOUND });
      return;
    }
    if (user.mfaEnabledAt) {
      res.status(409).json({ error: 'Two-factor authentication is already enabled', code: ERR.MFA_ALREADY_ENABLED });
      return;
    }
    const { secret, otpauthUri } = await startMfaSetup(user);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ secret, otpauthUri });
  } catch (error) {
    logError('2FA setup error', error);
    res.status(500).json({ error: 'Failed to start 2FA setup', code: ERR.INTERNAL_ERROR });
  }
});

// POST /users/me/2fa/enable - 현재 비밀번호와 인증 앱 코드를 확인하고 켠다. 복구 코드 10개는 이 응답에서 한 번만 보여 준다.
// 비밀번호를 다시 받는 이유: 훔친 세션만으로 2FA를 켜 계정 주인을 잠그지 못하게 한다.
// 켜면 이 기기를 뺀 다른 세션을 모두 폐기한다(2FA 없이 열려 있던 세션을 남기지 않는다).
router.post('/enable', async (req: AuthRequest, res: Response) => {
  try {
    const { password, code } = z.object({ password: z.string().min(1).max(72), code: codeSchema }).strict().parse(req.body);
    const userId = req.user!.userId;
    if (isMfaVerifyLocked(userId)) {
      res.status(429).json(TOO_MANY);
      return;
    }
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
    if (!me || !(await bcrypt.compare(password, me.password))) {
      recordMfaVerifyFailure(userId);
      res.status(403).json({ error: 'Current password is incorrect', code: ERR.AUTH_CURRENT_PASSWORD_INCORRECT });
      return;
    }
    const result = await enableMfa(userId, code);
    if (!result.ok) {
      switch (result.reason) {
        case 'unavailable':
          res.status(503).json(UNAVAILABLE);
          return;
        case 'already_enabled':
          res.status(409).json({ error: 'Two-factor authentication is already enabled', code: ERR.MFA_ALREADY_ENABLED });
          return;
        case 'no_pending':
          res.status(400).json({ error: 'Start setup first', code: ERR.MFA_SETUP_NOT_STARTED });
          return;
        default:
          recordMfaVerifyFailure(userId);
          res.status(400).json(INVALID_CODE);
          return;
      }
    }
    clearMfaVerifyFailures(userId);
    // 필수 정책 판단(mfaEnabled)이 바로 바뀌도록 인증 캐시를 비운다
    invalidateTokenCache(userId);
    const revoked = await revokeUserSessions(userId, req.user!.sid);
    revoked.forEach((sid) => kickSession(userId, sid));
    await writeAuditLog({ action: 'mfa.enabled', actorId: userId, targetType: 'user', targetId: userId, details: `revokedSessions=${revoked.length}` });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: true, recoveryCodes: result.recoveryCodes, revokedSessions: revoked.length });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('2FA enable error', error);
    res.status(500).json({ error: 'Failed to enable 2FA', code: ERR.INTERNAL_ERROR });
  }
});

// POST /users/me/2fa/disable - 비밀번호와 코드(TOTP 또는 복구 코드)가 둘 다 맞아야 끈다.
router.post('/disable', async (req: AuthRequest, res: Response) => {
  try {
    const { password, code } = z.object({ password: z.string().min(1).max(72), code: codeSchema }).strict().parse(req.body);
    const userId = req.user!.userId;
    if (isMfaVerifyLocked(userId)) {
      res.status(429).json(TOO_MANY);
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { password: true, mfaEnabledAt: true } });
    if (!user?.mfaEnabledAt) {
      res.status(400).json({ error: 'Two-factor authentication is not enabled', code: ERR.MFA_NOT_ENABLED });
      return;
    }
    // 비밀번호가 틀리면 코드는 확인하지 않는다(복구 코드를 헛되이 쓰지 않게)
    if (!(await bcrypt.compare(password, user.password))) {
      recordMfaVerifyFailure(userId);
      res.status(403).json({ error: 'Current password is incorrect', code: ERR.AUTH_CURRENT_PASSWORD_INCORRECT });
      return;
    }
    const result = await verifySecondFactor(userId, code);
    if (!result.ok) {
      recordMfaVerifyFailure(userId);
      if (result.reason === 'unavailable') res.status(503).json(UNAVAILABLE);
      else res.status(403).json(INVALID_CODE);
      return;
    }
    clearMfaVerifyFailures(userId);
    await clearMfa(userId);
    invalidateTokenCache(userId);
    await writeAuditLog({ action: 'mfa.disabled', actorId: userId, targetType: 'user', targetId: userId, details: `method=${result.method}` });
    res.json({ enabled: false });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('2FA disable error', error);
    res.status(500).json({ error: 'Failed to disable 2FA', code: ERR.INTERNAL_ERROR });
  }
});

export default router;
