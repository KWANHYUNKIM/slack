import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config.js';

/**
 * Key for the API rate limiter: one bucket per user for normal login tokens,
 * otherwise one per IP.
 *
 * Scoped tokens (`purpose` claim, e.g. file-download) and tokens without
 * `tokenVersion` are not valid login tokens, so they must not pick a user
 * bucket (otherwise anyone holding such a token could burn another user's quota).
 * No DB lookup here: this runs on every request.
 */
export function rateLimitKey(req: Pick<Request, 'headers' | 'ip'>): string {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET, { algorithms: ['HS256'] }) as any;
      if (decoded.userId && !decoded.purpose && decoded.tokenVersion !== undefined) {
        return `user:${decoded.userId}`;
      }
    } catch {}
  }
  // ipKeyGenerator groups IPv6 addresses by /56 subnet so one host can't dodge the limit with many addresses
  return req.ip ? ipKeyGenerator(req.ip) : 'unknown';
}
