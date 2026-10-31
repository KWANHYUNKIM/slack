import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, JwtPayload } from '../types.js';
import { JWT_SECRET } from '../config.js';
import prisma from '../db.js';
import { logError } from '../utils/logger.js';

// Short-lived cache for tokenVersion checks to avoid a DB round-trip on every request.
// TTL is 5 seconds — revoked tokens may work for up to 5s after revocation.
// Disabled in test to avoid stale state between tests that bypass the API.
const TOKEN_CACHE_TTL = process.env.NODE_ENV === 'test' ? 0 : 5_000;
const tokenCache = new Map<number, { tokenVersion: number; role: string; deactivatedAt: Date | null; expiresAt: number }>();

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

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }

  const token = authHeader.split(' ')[1];

  // JWT 검증 실패(서명, 만료, 형식 오류)는 잘못된 토큰이므로 401이다.
  let decoded: JwtPayload & { purpose?: string };
  try {
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload & { purpose?: string };
  } catch {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  // 여기서부터의 실패(DB 조회 등)는 서버 오류다. 401로 삼키면 진단이 안 되므로 기록하고 500을 낸다.
  // 응답 본문에는 내부 정보를 넣지 않는다.
  let cached: { tokenVersion: number; role: string; deactivatedAt: Date | null; expiresAt: number };
  try {
    // Reject scoped tokens (e.g. file-download) from being used as general auth
    if (decoded.purpose) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    // Validate tokenVersion against DB to support server-side revocation.
    // All failures return the same generic message to prevent
    // authentication state enumeration (OWASP).
    if (decoded.tokenVersion === undefined) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const now = Date.now();
    const existing = tokenCache.get(decoded.userId);
    if (!existing || existing.expiresAt < now) {
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { tokenVersion: true, role: true, deactivatedAt: true },
      });
      if (!user) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
      cached = { tokenVersion: user.tokenVersion, role: user.role, deactivatedAt: user.deactivatedAt, expiresAt: now + TOKEN_CACHE_TTL };
      tokenCache.set(decoded.userId, cached);
    } else {
      cached = existing;
    }

    if (cached.tokenVersion !== decoded.tokenVersion) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    if (cached.deactivatedAt) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
  } catch (error) {
    logError('Auth middleware error', error);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  req.user = { ...decoded, role: cached.role };
  next();
}
