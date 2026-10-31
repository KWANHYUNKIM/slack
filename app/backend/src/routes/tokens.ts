import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { ERR } from '../utils/errorCodes.js';
import {
  ALLOWED_SCOPES,
  MAX_ACTIVE_TOKENS,
  READ_SCOPES,
  generateToken,
  toTokenView,
} from '../services/accessTokenService.js';
import {
  verifySecondFactor, restoreRecoveryCode, isMfaVerifyLocked, recordMfaVerifyFailure, clearMfaVerifyFailures,
} from '../services/mfaService.js';

// 개인 액세스 토큰 관리(mcp-1). 로그인 세션(JWT)으로만 다룬다.
// authMiddleware는 JWT만 받으므로 PAT로 PAT를 만들거나 지울 수 없다.
const router = Router();

const TOKEN_TARGET = 'personal_access_token';

const nameSchema = z.string().trim().min(1).max(100)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), { message: 'Name cannot contain control characters' });

const createSchema = z.object({
  name: nameSchema,
  scopes: z.array(z.string().refine((s) => ALLOWED_SCOPES.includes(s), { message: 'Unknown scope' }))
    .min(1).max(ALLOWED_SCOPES.length).default([...READ_SCOPES]),
  // null이면 만료 없음. 기본 30일.
  expiresInDays: z.number().int().min(1).max(365).nullable().default(30),
  // 2FA 사용자는 발급할 때 코드를 다시 확인한다(E7b). 훔친 세션만으로 오래 사는 토큰을 만들지 못하게.
  code: z.string().trim().min(1).max(32).optional(),
}).strict();

const updateSchema = z.object({ name: nameSchema }).strict();

const activeWhere = (userId: number) => ({ userId, revokedAt: null });

// GET /tokens - 내 토큰 목록(폐기된 것은 빼고, 만료된 것은 expired로 표시)
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.personalAccessToken.findMany({
      where: activeWhere(req.user!.userId),
      orderBy: { id: 'desc' },
    });
    res.json({ items: rows.map(toTokenView), nextCursor: null });
  } catch (error) {
    logError('List tokens error', error);
    res.status(500).json({ error: 'Failed to list tokens' });
  }
});

// POST /tokens - 발급. 응답의 token(원문)은 이때 한 번만 내려가고 다시 볼 수 없다.
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { name, scopes, expiresInDays, code } = createSchema.parse(req.body);
    const userId = req.user!.userId;

    const now = new Date();
    // 만료된 토큰은 쓸 수 없으므로 상한에서 뺀다(폐기하지 않아도 새로 만들 수 있게).
    const usableWhere = { ...activeWhere(userId), OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
    const LIMIT = { error: 'Too many tokens', code: ERR.TOKEN_LIMIT_REACHED };

    const me = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabledAt: true } });
    let verified: Awaited<ReturnType<typeof verifySecondFactor>> | null = null;
    if (me?.mfaEnabledAt) {
      if (!code) {
        res.status(403).json({ error: 'Two-factor code required', code: ERR.MFA_CODE_REQUIRED });
        return;
      }
      if (isMfaVerifyLocked(userId)) {
        res.status(429).json({ error: 'Too many failed attempts. Try again later.', code: ERR.AUTH_TOO_MANY_ATTEMPTS });
        return;
      }
      // 상한에 닿았으면 코드를 확인하기 전에 거부한다(복구 코드를 헛되이 쓰지 않게). 최종 판정은 아래 트랜잭션이 한다.
      if ((await prisma.personalAccessToken.count({ where: usableWhere })) >= MAX_ACTIVE_TOKENS) {
        res.status(409).json(LIMIT);
        return;
      }
      verified = await verifySecondFactor(userId, code);
      if (!verified.ok) {
        // 키가 없어 확인할 수 없는 것은 사용자의 실패가 아니다
        if (verified.reason === 'unavailable') {
          res.status(503).json({ error: 'Two-factor authentication is not available on this server', code: ERR.MFA_UNAVAILABLE });
          return;
        }
        recordMfaVerifyFailure(userId);
        // 401은 프런트에서 로그아웃으로 처리되므로 403으로 답한다
        res.status(403).json({ error: 'Invalid authentication code', code: ERR.MFA_INVALID_CODE });
        return;
      }
      clearMfaVerifyFailures(userId);
    }

    const { token, publicId, tokenHash } = generateToken();
    // 동시 발급이 상한을 넘지 않게 사용자 행을 잠그고 그 안에서 세고 만든다.
    let row;
    try {
      row = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
        const activeCount = await tx.personalAccessToken.count({ where: usableWhere });
        if (activeCount >= MAX_ACTIVE_TOKENS) return null;
        return tx.personalAccessToken.create({
          data: {
            userId,
            name,
            publicId,
            tokenHash,
            scopes: [...new Set(scopes)],
            expiresAt: expiresInDays === null ? null : new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000),
          },
        });
      });
    } catch (error) {
      if (verified?.ok && verified.method === 'recovery') await restoreRecoveryCode(userId, verified.consumed);
      throw error;
    }
    if (!row) {
      // 확인 뒤에 상한에 닿았으면(동시 발급) 이번에 쓴 복구 코드를 되돌린다
      if (verified?.ok && verified.method === 'recovery') await restoreRecoveryCode(userId, verified.consumed);
      res.status(409).json(LIMIT);
      return;
    }
    if (verified?.ok && verified.method === 'recovery') {
      void writeAuditLog({ action: 'mfa.recovery_used', actorId: userId, targetType: 'user', targetId: userId, details: `remaining=${verified.remaining}; purpose=token_create` });
    }

    // 원문과 해시는 감사 로그에 남기지 않는다. 기록은 기다리지 않는다(실패는 writeAuditLog가 logError로 남긴다).
    void writeAuditLog({
      action: 'token.create',
      actorId: userId,
      targetType: TOKEN_TARGET,
      targetId: row.id,
      targetName: row.name,
      details: JSON.stringify({ scopes: row.scopes, expiresAt: row.expiresAt }),
    });

    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ ...toTokenView(row), token });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid body', details: error.issues });
      return;
    }
    logError('Create token error', error);
    res.status(500).json({ error: 'Failed to create token' });
  }
});

// PATCH /tokens/:id - 이름 바꾸기. 범위와 만료는 바꿀 수 없다(바꾸려면 새로 발급).
router.patch('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid token ID' });
      return;
    }
    const { name } = updateSchema.parse(req.body);
    // 남의 토큰과 없는 토큰을 같은 404로 답한다
    const result = await prisma.personalAccessToken.updateMany({
      where: { id, ...activeWhere(req.user!.userId) },
      data: { name },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id } });
    res.json(toTokenView(row));
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid body', details: error.issues });
      return;
    }
    logError('Update token error', error);
    res.status(500).json({ error: 'Failed to update token' });
  }
});

// DELETE /tokens/:id - 폐기. 행은 감사용으로 남기고 revokedAt만 채운다. 바로 /mcp에서 401이 된다.
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid token ID' });
      return;
    }
    const userId = req.user!.userId;
    const result = await prisma.personalAccessToken.updateMany({
      where: { id, ...activeWhere(userId) },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    void writeAuditLog({
      action: 'token.revoke',
      actorId: userId,
      targetType: TOKEN_TARGET,
      targetId: id,
    });

    const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id } });
    res.json(toTokenView(row));
  } catch (error) {
    logError('Revoke token error', error);
    res.status(500).json({ error: 'Failed to revoke token' });
  }
});

export default router;
