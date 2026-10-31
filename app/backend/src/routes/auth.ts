import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { authMiddleware, invalidateTokenCache } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';
import { kickUser, kickSession } from '../websocket/index.js';
import { BCRYPT_ROUNDS, displayNameSchema, emailSchema, newPasswordSchema } from '../utils/authSchemas.js';
import { ERR } from '../utils/errorCodes.js';
import { joinDefaultChannels } from '../services/defaultChannelService.js';
import { createSessionToken, revokeUserSessions, revokeSession } from '../services/sessionService.js';
import { writeAuditLog, hashEmailForAudit, throttleUnknownLogin } from '../utils/auditLog.js';
import {
  createMfaChallenge, findMfaChallenge, claimMfaChallengeAttempt, consumeMfaChallenge,
  verifySecondFactor, restoreRecoveryCode, isMfaPolicyEnforced, MFA_CHALLENGE_TTL_MS,
} from '../services/mfaService.js';
import { createAttemptLimiter, type AttemptOutcome } from '../utils/attemptLimiter.js';

const router = Router();
const isTest = process.env.NODE_ENV === 'test';

const registerSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
  name: displayNameSchema,
  inviteCode: z.string().max(64).optional(),
});

const loginSchema = z.object({
  email: z.string().email().transform(e => e.toLowerCase()),
  password: z.string().min(1).max(72),
});

// Account lockout: 이메일당 10번 실패하면 15분 잠근다. 비밀번호와 2FA 코드 실패가 같은 카운터를 쓴다.
const loginAttempts = createAttemptLimiter<string>({ max: 10, lockMs: 15 * 60 * 1000, maxEntries: 10_000 });

/** 잠김이 시작되는 순간 한 번만 기록한다(이후 429 시도는 기록하지 않아 폭주로 쌓이지 않는다) */
function auditLoginLocked(email: string, userId: number | null): void {
  void writeAuditLog({
    action: 'auth.login_locked', actorId: null, targetType: 'user',
    ...(userId ? { targetId: userId } : {}), details: `emailHash=${hashEmailForAudit(email)}`,
  });
}

function recordFailedLogin(email: string, userId: number | null): void {
  if (loginAttempts.recordFailure(email)) auditLoginLocked(email, userId);
}

const isLoginLocked = (email: string) => loginAttempts.isLocked(email);

// POST /auth/register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name, inviteCode } = registerSchema.parse(req.body);

    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser) {
      // Perform dummy hash to normalize timing (prevent user-enumeration via response time)
      await bcrypt.hash(password, BCRYPT_ROUNDS);
      res.status(400).json({ error: 'Unable to complete registration', code: ERR.AUTH_REGISTRATION_FAILED });
      return;
    }

    // Require invite code — no open registration (relaxed in test env for convenience)
    if (!inviteCode && !isTest) {
      res.status(400).json({ error: 'An invite is required to register', code: ERR.INVITE_REQUIRED });
      return;
    }

    // Pre-validate invite code format (early rejection before hashing)
    if (inviteCode) {
      const invite = await prisma.inviteLink.findUnique({ where: { code: inviteCode } });
      if (!invite) {
        res.status(400).json({ error: 'Invalid invite code', code: ERR.INVITE_INVALID });
        return;
      }
      if (invite.expiresAt && invite.expiresAt < new Date()) {
        res.status(400).json({ error: 'Invite code has expired', code: ERR.INVITE_EXPIRED });
        return;
      }
      if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
        res.status(400).json({ error: 'Invite code has reached its usage limit', code: ERR.INVITE_EXHAUSTED });
        return;
      }
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Use transaction to atomically validate invite + create user + increment useCount
    const user = await prisma.$transaction(async (tx) => {
      let assignedRole: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST' = 'MEMBER';

      if (inviteCode) {
        // Atomic check-and-increment: a single UPDATE with WHERE conditions
        // eliminates the race window between findUnique and update that existed
        // under READ COMMITTED isolation (two concurrent registrations could
        // both read useCount=0 with maxUses=1, both pass the check, both increment).
        const claimed = await tx.$queryRaw<Array<{ id: number; role: string }>>`
          UPDATE "InviteLink"
          SET "useCount" = "useCount" + 1
          WHERE "code" = ${inviteCode}
            AND ("expiresAt" IS NULL OR "expiresAt" >= NOW())
            AND ("maxUses" IS NULL OR "useCount" < "maxUses")
          RETURNING id, role
        `;
        if (claimed.length === 0) {
          throw new Error('INVITE_INVALID');
        }
        // Cap self-service registration to MEMBER/GUEST — OWNER/ADMIN require admin action
        const inviteRole = claimed[0].role;
        assignedRole = (inviteRole === 'MEMBER' || inviteRole === 'GUEST') ? inviteRole as 'MEMBER' | 'GUEST' : 'MEMBER';
      }

      return tx.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          role: assignedRole,
        },
        select: {
          id: true,
          name: true,
          role: true,
          createdAt: true,
        },
      });
    });

    // Auto-join default channels — guests get NO auto-join (admin assigns channels)
    if (user.role !== 'GUEST') {
      try {
        await joinDefaultChannels(prisma, user.id);
      } catch (error) {
        // Non-critical: don't fail registration if auto-join fails
        logError('Default channel join error', error);
      }
    }

    const { token } = await createSessionToken({ id: user.id, tokenVersion: 0 }, req);
    // 조직이 2FA를 필수로 했으면 새 사용자도 등록 화면부터 간다
    const mfaEnrollmentRequired = await isMfaPolicyEnforced();

    res.status(201).json({ user, token, ...(mfaEnrollmentRequired ? { mfaEnrollmentRequired: true } : {}) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    if (error instanceof Error && error.message === 'INVITE_INVALID') {
      res.status(400).json({ error: 'Invite code is no longer valid', code: ERR.INVITE_INVALID });
      return;
    }
    // Handle unique constraint violation (concurrent registration race).
    // Return the same status + message as the normal existing-email path
    // so concurrent requests can't differentiate "email already existed"
    // (400) from "email just now taken by a racing request" (was 500).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      res.status(400).json({ error: 'Unable to complete registration', code: ERR.AUTH_REGISTRATION_FAILED });
      return;
    }
    logError('Register error', error);
    res.status(500).json({ error: 'Failed to register user', code: ERR.INTERNAL_ERROR });
  }
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    // Check account lockout
    if (isLoginLocked(email)) {
      res.status(429).json({ error: 'Account temporarily locked. Try again later.', code: ERR.AUTH_ACCOUNT_LOCKED });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true, email: true, name: true, avatar: true, role: true,
        password: true, deactivatedAt: true, tokenVersion: true, createdAt: true, locale: true, timeZone: true,
        mfaEnabledAt: true,
      },
    });
    if (!user) {
      // Dummy bcrypt to normalize response time (prevent timing-based email enumeration)
      await bcrypt.compare(password, '$2b$10$invalidhashfortimingpadding.padding');
      recordFailedLogin(email, null);
      // 이메일 원문은 남기지 않고 해시만 남긴다(사용자를 특정할 수 없으니 actorId는 비운다)
      // 공격자가 마음대로 만들 수 있는 기록이라 emailHash당 15분에 한 건만 남기고, 그 사이 시도 횟수는 count로 합친다
      const emailHash = hashEmailForAudit(email);
      const logCount = throttleUnknownLogin(emailHash);
      if (logCount !== null) {
        void writeAuditLog({ action: 'auth.login_failed', actorId: null, targetType: 'user', details: `reason=unknown_user; emailHash=${emailHash}; count=${logCount}` });
      }
      res.status(401).json({ error: 'Invalid credentials', code: ERR.AUTH_INVALID_CREDENTIALS });
      return;
    }

    // Block deactivated accounts — still run bcrypt to prevent timing enumeration
    const validPassword = await bcrypt.compare(password, user.password);
    if (user.deactivatedAt) {
      void writeAuditLog({ action: 'auth.login_failed', actorId: user.id, targetType: 'user', targetId: user.id, details: 'reason=deactivated' });
      res.status(401).json({ error: 'Invalid credentials', code: ERR.AUTH_INVALID_CREDENTIALS });
      return;
    }
    if (!validPassword) {
      recordFailedLogin(email, user.id);
      void writeAuditLog({ action: 'auth.login_failed', actorId: user.id, targetType: 'user', targetId: user.id, details: 'reason=bad_password' });
      res.status(401).json({ error: 'Invalid credentials', code: ERR.AUTH_INVALID_CREDENTIALS });
      return;
    }

    // 2FA 사용자: 비밀번호만으로는 세션을 만들지 않고 5분짜리 1회용 mfaToken을 준다.
    // 실패 카운터는 2단계까지 끝나야 비운다(비밀번호를 아는 공격자가 코드를 맞히는 동안 잠금이 풀리지 않게).
    if (user.mfaEnabledAt) {
      const { mfaToken } = await createMfaChallenge({ id: user.id, tokenVersion: user.tokenVersion });
      res.json({ mfaRequired: true, mfaToken, expiresIn: Math.floor(MFA_CHALLENGE_TTL_MS / 1000) });
      return;
    }

    // Clear failed attempts on successful login
    loginAttempts.clear(email);
    void writeAuditLog({ action: 'auth.login', actorId: user.id, targetType: 'user', targetId: user.id });

    await sendLoginSuccess(req, res, user);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('Login error', error);
    res.status(500).json({ error: 'Failed to login', code: ERR.INTERNAL_ERROR });
  }
});

/** 세션을 만들고 로그인 응답을 보낸다(비밀번호만, 또는 2단계까지 통과). */
async function sendLoginSuccess(
  req: Request,
  res: Response,
  user: {
    id: number; email: string; name: string; avatar: string | null; role: string; createdAt: Date;
    locale: string | null; timeZone: string | null; tokenVersion: number; mfaEnabledAt: Date | null;
  },
): Promise<void> {
  const { token } = await createSessionToken({ id: user.id, tokenVersion: user.tokenVersion }, req);
  const mfaEnrollmentRequired = !user.mfaEnabledAt && (await isMfaPolicyEnforced());
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      role: user.role,
      createdAt: user.createdAt,
      locale: user.locale,
      timeZone: user.timeZone,
    },
    token,
    ...(mfaEnrollmentRequired ? { mfaEnrollmentRequired: true } : {}),
  });
}

const login2faSchema = z.object({
  mfaToken: z.string().min(1).max(100),
  code: z.string().trim().min(1).max(32),
});

const MFA_TOKEN_EXPIRED = { error: 'Login session expired. Sign in again.', code: ERR.MFA_TOKEN_INVALID };

// POST /auth/login/2fa - 로그인 2단계. TOTP 6자리 또는 복구 코드를 받는다. 실패는 비밀번호 실패와 같은 잠금 카운터를 쓴다.
router.post('/login/2fa', async (req: Request, res: Response) => {
  try {
    const { mfaToken, code } = login2faSchema.parse(req.body);
    const challenge = await findMfaChallenge(mfaToken);
    if (!challenge) {
      res.status(401).json(MFA_TOKEN_EXPIRED);
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: challenge.userId },
      select: {
        id: true, email: true, name: true, avatar: true, role: true,
        deactivatedAt: true, tokenVersion: true, createdAt: true, locale: true, timeZone: true, mfaEnabledAt: true,
      },
    });
    // 대기 중에 비활성화, 비밀번호 변경·강제 로그아웃(tokenVersion), 2FA 초기화가 있었으면 처음부터 다시 하게 한다
    if (!user || user.deactivatedAt || user.tokenVersion !== challenge.tokenVersion || !user.mfaEnabledAt) {
      await consumeMfaChallenge(challenge.id);
      res.status(401).json(MFA_TOKEN_EXPIRED);
      return;
    }
    // 검증 전에 이메일 잠금 자리를 잡는다(실패 수 + 검증 중인 수가 10 미만일 때만). 동시에 수십 건이 와도 한도를 넘겨 검증하지 않고,
    // 실패는 결과가 나온 뒤에만 세서 맞는 코드가 잠금이나 login_locked 기록을 만들지 않는다. 대기당 5회는 claim이 따로 막는다.
    if (!loginAttempts.reserve(user.email)) {
      res.status(429).json({ error: 'Account temporarily locked. Try again later.', code: ERR.AUTH_ACCOUNT_LOCKED });
      return;
    }
    let outcome: AttemptOutcome = 'neutral';
    let result: Awaited<ReturnType<typeof verifySecondFactor>>;
    try {
      if (!(await claimMfaChallengeAttempt(challenge.id))) {
        res.status(401).json(MFA_TOKEN_EXPIRED);
        return;
      }

      result = await verifySecondFactor(user.id, code);
      if (!result.ok) {
        // 키가 없어 TOTP를 확인할 수 없는 것은 잠금 실패로 세지 않는다(대기 시도 수는 이미 썼다)
        if (result.reason !== 'unavailable') outcome = 'failure';
        // 코드 원문은 남기지 않는다
        const reason = result.reason === 'bad_recovery_code' ? 'bad_recovery_code' : 'bad_totp';
        void writeAuditLog({ action: 'auth.login_failed', actorId: user.id, targetType: 'user', targetId: user.id, details: `reason=${reason}` });
        res.status(401).json({
          error: 'Invalid authentication code',
          code: result.reason === 'unavailable' ? ERR.MFA_UNAVAILABLE : ERR.MFA_INVALID_CODE,
        });
        return;
      }
      // 같은 대기로 다른 요청이 먼저 성공했으면 세션을 하나 더 만들지 않는다. 이번에 쓴 복구 코드는 되돌린다.
      if (!(await consumeMfaChallenge(challenge.id))) {
        if (result.method === 'recovery') await restoreRecoveryCode(user.id, result.consumed);
        res.status(401).json(MFA_TOKEN_EXPIRED);
        return;
      }
      outcome = 'success';
    } finally {
      if (loginAttempts.release(user.email, outcome)) auditLoginLocked(user.email, user.id);
    }

    if (result.method === 'recovery') {
      void writeAuditLog({ action: 'mfa.recovery_used', actorId: user.id, targetType: 'user', targetId: user.id, details: `remaining=${result.remaining}` });
    }
    void writeAuditLog({ action: 'auth.login', actorId: user.id, targetType: 'user', targetId: user.id, details: `mfa=${result.method}` });

    await sendLoginSuccess(req, res, user);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('Login 2FA error', error);
    res.status(500).json({ error: 'Failed to login', code: ERR.INTERNAL_ERROR });
  }
});

// POST /auth/logout - 이 기기의 세션을 폐기한다(sid 없는 옛 토큰은 서버가 끊을 것이 없다). 로그아웃 사실은 감사 로그에 남긴다.
router.post('/logout', authMiddleware, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const sid = req.user!.sid;
  if (sid) {
    try {
      await revokeSession(userId, sid);
      kickSession(userId, sid);
    } catch (error) {
      logError('Logout session revoke error', error);
    }
  }
  await writeAuditLog({ action: 'auth.logout', actorId: userId, targetType: 'user', targetId: userId });
  res.json({ message: 'Logged out' });
});

// POST /auth/change-password
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: newPasswordSchema,
});

// Brute-force protection for password change (keyed on userId, not email,
// since this endpoint is authenticated).  Without this, an attacker with
// a stolen JWT can dictionary-attack the currentPassword at 120 req/min.
const passwordChangeAttempts = createAttemptLimiter<number>({ max: 5, lockMs: 15 * 60 * 1000, maxEntries: 10_000 });

router.post('/change-password', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    // Check lockout before any DB or bcrypt work
    if (passwordChangeAttempts.isLocked(userId)) {
      res.status(429).json({ error: 'Too many failed attempts. Try again later.', code: ERR.AUTH_TOO_MANY_ATTEMPTS });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found', code: ERR.NOT_FOUND });
      return;
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      passwordChangeAttempts.recordFailure(userId);
      // 401은 프런트가 자동 로그아웃하는 신호이므로, 입력이 틀린 것은 400으로 답한다(토큰은 그대로 유효)
      res.status(400).json({ error: 'Current password is incorrect', code: ERR.AUTH_CURRENT_PASSWORD_INCORRECT });
      return;
    }

    // Clear failed attempts on success
    passwordChangeAttempts.clear(userId);

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Increment tokenVersion to invalidate all existing sessions
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
      },
      select: { id: true, tokenVersion: true },
    });

    // Invalidate cached auth so the revoked token is rejected immediately
    invalidateTokenCache(userId);

    // Immediately disconnect all WebSocket connections for this user
    // (don't wait for the 5-minute periodic revalidation — the password
    // change may be in response to a compromised account)
    kickUser(userId);

    // Issue a fresh token with the new tokenVersion
    // 세션 행도 함께 정리한다(tokenVersion이 이미 이전 토큰을 막지만, 목록에 죽은 기기가 남지 않게 한다)
    await revokeUserSessions(userId);
    const { token } = await createSessionToken({ id: updated.id, tokenVersion: updated.tokenVersion }, req);

    void writeAuditLog({ action: 'auth.password_changed', actorId: userId, targetType: 'user', targetId: userId });

    res.json({ message: 'Password changed successfully', token });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('Change password error', error);
    res.status(500).json({ error: 'Failed to change password', code: ERR.INTERNAL_ERROR });
  }
});

// GET /auth/invite/:code - Validate invite code (public, no auth required)
router.get('/invite/:code', async (req: Request, res: Response) => {
  try {
    const code = req.params.code as string;
    if (!code || code.length > 64) {
      res.status(400).json({ error: 'Invalid invite code', code: ERR.INVITE_INVALID });
      return;
    }

    const invite = await prisma.inviteLink.findUnique({
      where: { code },
      select: { role: true, expiresAt: true, maxUses: true, useCount: true },
    });

    if (!invite) {
      res.status(404).json({ error: 'Invite not found', code: ERR.INVITE_NOT_FOUND });
      return;
    }

    if (invite.expiresAt && invite.expiresAt < new Date()) {
      res.status(410).json({ error: 'Invite expired', code: ERR.INVITE_EXPIRED });
      return;
    }

    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
      res.status(410).json({ error: 'Invite exhausted', code: ERR.INVITE_EXHAUSTED });
      return;
    }

    res.json({ valid: true, role: invite.role });
  } catch (error) {
    logError('Validate invite error', error);
    res.status(500).json({ error: 'Failed to validate invite', code: ERR.INTERNAL_ERROR });
  }
});

export default router;
