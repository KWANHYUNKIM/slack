import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, JwtPayload } from '../types.js';
import { JWT_SECRET } from '../config.js';
import prisma from '../db.js';
import { logError } from '../utils/logger.js';
import { ERR } from '../utils/errorCodes.js';
import { checkSession } from '../services/sessionService.js';
import { isMfaPolicyEnforced } from '../services/mfaService.js';

// Short-lived cache for tokenVersion checks to avoid a DB round-trip on every request.
// TTL is 5 seconds — revoked tokens may work for up to 5s after revocation.
// Disabled in test to avoid stale state between tests that bypass the API.
const TOKEN_CACHE_TTL = process.env.NODE_ENV === 'test' ? 0 : 5_000;
const tokenCache = new Map<number, { tokenVersion: number; role: string; deactivatedAt: Date | null; mfaEnabled: boolean; expiresAt: number }>();

// Periodically evict expired entries to prevent unbounded growth.
// Without this, entries accumulate forever (only skipped on read, never deleted).
if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tokenCache) {
      if (entry.expiresAt < now) tokenCache.delete(key);
    }
  }, 10 * 60 * 1000).unref();
}

export function invalidateTokenCache(userId: number) {
  tokenCache.delete(userId);
}

export function clearTokenCache() {
  tokenCache.clear();
}

export type AccessTokenResult =
  | { ok: true; user: JwtPayload & { role: string } }
  | { ok: false };

/**
 * HTTP 미들웨어와 Socket.io 핸드셰이크가 함께 쓰는 access token 검증.
 * - 잘못된 토큰(서명, 만료, 형식, 폐기, 비활성 계정)은 `{ ok: false }`를 돌려준다.
 * - DB 조회 같은 서버 오류는 throw한다. 호출한 쪽이 기록하고 서버 오류로 응답한다.
 * 실패 사유는 호출한 쪽에 주지 않는다(인증 상태 열거 방지).
 */
export async function validateAccessToken(token: string): Promise<AccessTokenResult> {
  let decoded: JwtPayload & { purpose?: string };
  try {
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload & { purpose?: string };
  } catch {
    return { ok: false };
  }

  // Reject scoped tokens (e.g. file-download) from being used as general auth
  if (decoded.purpose) return { ok: false };

  // Validate tokenVersion against DB to support server-side revocation.
  if (decoded.tokenVersion === undefined) return { ok: false };

  // 서명이 맞아도 형식이 이상하면 DB 조회 전에 거부한다.
  if (!Number.isInteger(decoded.userId) || decoded.userId <= 0) return { ok: false };
  if (typeof decoded.tokenVersion !== 'number' || !Number.isFinite(decoded.tokenVersion)) return { ok: false };

  const now = Date.now();
  let cached = tokenCache.get(decoded.userId);
  if (!cached || cached.expiresAt < now) {
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { tokenVersion: true, role: true, deactivatedAt: true, mfaEnabledAt: true },
    });
    if (!user) return { ok: false };
    cached = {
      tokenVersion: user.tokenVersion, role: user.role, deactivatedAt: user.deactivatedAt,
      mfaEnabled: user.mfaEnabledAt !== null, expiresAt: now + TOKEN_CACHE_TTL,
    };
    tokenCache.set(decoded.userId, cached);
  }

  if (cached.tokenVersion !== decoded.tokenVersion) return { ok: false };
  if (cached.deactivatedAt) return { ok: false };

  // 세션이 있는 토큰(E7)은 세션이 살아 있어야 한다. sid 없는 토큰(세션 도입 전 발급)은 tokenVersion 규칙만 따르고 만료되면 사라진다.
  if (decoded.sid !== undefined) {
    if (typeof decoded.sid !== 'string' || decoded.sid.length === 0 || decoded.sid.length > 32) return { ok: false };
    if (!(await checkSession(decoded.sid, decoded.userId))) return { ok: false };
  }

  // 조직이 2FA를 필수로 했는데 아직 등록하지 않았으면 표시한다. 어디까지 허용할지는 호출한 쪽이 정한다(HTTP는 등록 API만, 소켓은 거부).
  const mfaEnrollmentRequired = !cached.mfaEnabled && (await isMfaPolicyEnforced());

  return { ok: true, user: { ...decoded, role: cached.role, ...(mfaEnrollmentRequired ? { mfaEnrollmentRequired: true } : {}) } };
}

/** 2FA 등록이 필요한 사용자에게도 열어 두는 경로: 2FA 상태·등록 API와 로그아웃 */
function isMfaEnrollmentPath(fullPath: string): boolean {
  return fullPath === '/users/me/2fa' || fullPath.startsWith('/users/me/2fa/') || fullPath === '/auth/logout';
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided', code: ERR.AUTH_NO_TOKEN });
    return;
  }

  const token = authHeader.split(' ')[1];

  // 서버 오류(DB 등)는 401로 삼키지 않는다. 기록하고 500을 내며, 응답 본문에 내부 정보는 넣지 않는다.
  let result: AccessTokenResult;
  try {
    result = await validateAccessToken(token);
  } catch (error) {
    logError('Auth middleware error', error);
    res.status(500).json({ error: 'Internal server error', code: ERR.INTERNAL_ERROR });
    return;
  }

  if (!result.ok) {
    // All failures return the same generic message to prevent
    // authentication state enumeration (OWASP).
    res.status(401).json({ error: 'Invalid token', code: ERR.AUTH_INVALID_TOKEN });
    return;
  }

  if (result.user.mfaEnrollmentRequired && !isMfaEnrollmentPath(req.baseUrl + req.path)) {
    res.status(403).json({ error: 'Two-factor authentication enrollment required', code: ERR.MFA_ENROLLMENT_REQUIRED });
    return;
  }

  req.user = result.user;
  next();
}
