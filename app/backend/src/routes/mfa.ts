import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';
import { ERR } from '../utils/errorCodes.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { rotateSessions } from '../services/sessionRotation.js';
import {
  isMfaAvailable, getMfaStatus, startMfaSetup, enableMfa, clearMfa, verifySecondFactor, getRequireMfa,
  isMfaVerifyLocked, recordMfaVerifyFailure, clearMfaVerifyFailures, isMfaPolicyEnforced, regenerateRecoveryCodes,
} from '../services/mfaService.js';

// 내 2단계 인증(E7b). /users/me/2fa 아래에 /users보다 먼저 붙는다.
// 조직이 2FA를 필수로 했는데 아직 등록하지 않은 사용자도 이 경로는 쓸 수 있다(authMiddleware의 허용 목록).
const router = Router();
router.use(authMiddleware);

const TOO_MANY = { error: 'Too many failed attempts. Try again later.', code: ERR.AUTH_TOO_MANY_ATTEMPTS };
const UNAVAILABLE = { error: 'Two-factor authentication is not available on this server', code: ERR.MFA_UNAVAILABLE };
// 틀린 코드는 401이 아니라 403으로 답한다(로그인된 화면에서 401은 로그아웃으로 처리된다).
const INVALID_CODE = { error: 'Invalid authentication code', code: ERR.MFA_INVALID_CODE };

const codeSchema = z.string().trim().min(1).max(32);

/**
 * 비밀번호와 2단계 코드(TOTP 또는 복구 코드)를 다시 확인한다(끄기, 복구 코드 재발급).
 * 틀린 입력은 모두 실패로 세고(다른 재확인과 같은 limiter), 비밀번호가 틀리면 코드는 확인하지 않는다(복구 코드를 헛되이 쓰지 않게).
 * 성공하면 실패 횟수를 비운다. 실패면 보낼 응답을 돌려준다.
 */
async function reauthenticate(
  userId: number,
  passwordHash: string,
  password: string,
  code: string,
): Promise<{ ok: true; method: 'totp' | 'recovery' } | { ok: false; status: number; body: { error: string; code: string } }> {
  if (!(await bcrypt.compare(password, passwordHash))) {
    recordMfaVerifyFailure(userId);
    return { ok: false, status: 403, body: { error: 'Current password is incorrect', code: ERR.AUTH_CURRENT_PASSWORD_INCORRECT } };
  }
  const result = await verifySecondFactor(userId, code);
  if (!result.ok) {
    // 키가 없어 TOTP를 확인할 수 없는 것은 사용자의 실패로 세지 않는다
    if (result.reason === 'unavailable') return { ok: false, status: 503, body: UNAVAILABLE };
    recordMfaVerifyFailure(userId);
    return { ok: false, status: 403, body: INVALID_CODE };
  }
  clearMfaVerifyFailures(userId);
  return { ok: true, method: result.method };
}

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
    const { token, revokedOthers } = await rotateSessions(req, userId, req.user!.sid);
    await writeAuditLog({ action: 'mfa.enabled', actorId: userId, targetType: 'user', targetId: userId, details: `revokedSessions=${revokedOthers}` });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: true, recoveryCodes: result.recoveryCodes, revokedSessions: revokedOthers, token });
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
    // 조직이 필수로 했으면 끌 수 없다(기기를 잃었으면 관리자 초기화를 쓴다)
    if (await isMfaPolicyEnforced()) {
      res.status(403).json({ error: 'Two-factor authentication is required by your organization', code: ERR.MFA_REQUIRED_BY_POLICY });
      return;
    }
    const re = await reauthenticate(userId, user.password, password, code);
    if (!re.ok) {
      res.status(re.status).json(re.body);
      return;
    }

    await clearMfa(userId);
    const { token, revokedOthers } = await rotateSessions(req, userId, req.user!.sid);
    await writeAuditLog({
      action: 'mfa.disabled', actorId: userId, targetType: 'user', targetId: userId,
      details: `method=${re.method}; revokedSessions=${revokedOthers}`,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ enabled: false, revokedSessions: revokedOthers, token });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('2FA disable error', error);
    res.status(500).json({ error: 'Failed to disable 2FA', code: ERR.INTERNAL_ERROR });
  }
});

// POST /users/me/2fa/recovery-codes - 복구 코드를 새 10개로 바꾼다(E7c). 기존 코드는 모두 무효가 된다.
// 끄기와 같은 재확인(비밀번호 + 현재 TOTP 또는 복구 코드)과 같은 시도 제한을 쓴다. 세션은 건드리지 않는다.
router.post('/recovery-codes', async (req: AuthRequest, res: Response) => {
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
    const re = await reauthenticate(userId, user.password, password, code);
    if (!re.ok) {
      res.status(re.status).json(re.body);
      return;
    }

    const recoveryCodes = await regenerateRecoveryCodes(userId);
    if (!recoveryCodes) {
      res.status(400).json({ error: 'Two-factor authentication is not enabled', code: ERR.MFA_NOT_ENABLED });
      return;
    }
    // 코드 원문은 감사 로그에 남기지 않는다
    await writeAuditLog({ action: 'mfa.recovery_regenerated', actorId: userId, targetType: 'user', targetId: userId, details: `method=${re.method}` });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ recoveryCodes, recoveryCodesRemaining: recoveryCodes.length });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('2FA recovery codes error', error);
    res.status(500).json({ error: 'Failed to regenerate recovery codes', code: ERR.INTERNAL_ERROR });
  }
});

export default router;
