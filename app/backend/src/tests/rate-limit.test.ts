import express from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { JWT_SECRET } from '../config.js';
import { rateLimitKey } from '../middleware/rateLimitKey.js';

/**
 * Rate limit tests use a standalone Express app with a low limit (3 req/window)
 * to verify keying behavior without needing 120+ requests.
 */

function createTestApp(max: number) {
  const app = express();
  app.set('trust proxy', 1);

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
    keyGenerator: rateLimitKey,
  });

  app.use('/api', limiter, (_req, res) => {
    res.json({ ok: true });
  });

  return app;
}

function signToken(userId: number) {
  return jwt.sign({ userId, tokenVersion: 0 }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Rate Limiting', () => {
  describe('per-user keying (authenticated)', () => {
    it('should rate limit per user, not per IP', async () => {
      const app = createTestApp(3);
      const tokenA = signToken(1);
      const tokenB = signToken(2);

      // User A: 3 requests should succeed
      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/api').set('Authorization', `Bearer ${tokenA}`);
        expect(res.status).toBe(200);
      }

      // User A: 4th request should be rate limited
      const blocked = await request(app).get('/api').set('Authorization', `Bearer ${tokenA}`);
      expect(blocked.status).toBe(429);

      // User B: should NOT be affected by User A's limit
      const userB = await request(app).get('/api').set('Authorization', `Bearer ${tokenB}`);
      expect(userB.status).toBe(200);
    });
  });

  describe('per-IP keying (unauthenticated)', () => {
    it('should rate limit by IP when no auth token is provided', async () => {
      const app = createTestApp(3);

      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/api');
        expect(res.status).toBe(200);
      }

      const blocked = await request(app).get('/api');
      expect(blocked.status).toBe(429);
      expect(blocked.body.error).toBe('Too many requests, please try again later');
    });
  });

  describe('bucket isolation', () => {
    it('should keep authenticated and unauthenticated buckets separate', async () => {
      const app = createTestApp(3);
      const token = signToken(99);

      // Exhaust the unauthenticated (IP) bucket
      for (let i = 0; i < 3; i++) {
        await request(app).get('/api');
      }
      const ipBlocked = await request(app).get('/api');
      expect(ipBlocked.status).toBe(429);

      // Authenticated user should still have their own bucket
      const authed = await request(app).get('/api').set('Authorization', `Bearer ${token}`);
      expect(authed.status).toBe(200);
    });

    it('should fall back to IP keying for invalid tokens', async () => {
      const app = createTestApp(3);

      // Use an invalid token — should key by IP
      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/api').set('Authorization', 'Bearer invalid.token.here');
        expect(res.status).toBe(200);
      }

      const blocked = await request(app).get('/api').set('Authorization', 'Bearer invalid.token.here');
      expect(blocked.status).toBe(429);
    });
  });
});

describe('rateLimitKey', () => {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('uses user:<id> for a normal login token', () => {
    expect(rateLimitKey({ headers: bearer(signToken(7)), ip: '1.2.3.4' })).toBe('user:7');
  });

  it('falls back to the IP for a file-download (purpose) token', () => {
    const token = jwt.sign({ userId: 7, tokenVersion: 0, purpose: 'file-download' }, JWT_SECRET, { expiresIn: '5m' });
    expect(rateLimitKey({ headers: bearer(token), ip: '1.2.3.4' })).toBe('1.2.3.4');
  });

  it('falls back to the IP when tokenVersion is missing', () => {
    const token = jwt.sign({ userId: 7 }, JWT_SECRET, { expiresIn: '1h' });
    expect(rateLimitKey({ headers: bearer(token), ip: '1.2.3.4' })).toBe('1.2.3.4');
  });

  it('falls back to the IP for an invalid token or no header', () => {
    expect(rateLimitKey({ headers: bearer('garbage'), ip: '1.2.3.4' })).toBe('1.2.3.4');
    expect(rateLimitKey({ headers: {}, ip: '1.2.3.4' })).toBe('1.2.3.4');
    expect(rateLimitKey({ headers: {}, ip: undefined })).toBe('unknown');
  });

  it('keys an IPv4-mapped IPv6 address the same as the plain IPv4 address', () => {
    expect(rateLimitKey({ headers: {}, ip: '::ffff:1.2.3.4' })).toBe(rateLimitKey({ headers: {}, ip: '1.2.3.4' }));
  });

  it('groups IPv6 addresses in the same /56 and separates different /56s', () => {
    const a = rateLimitKey({ headers: {}, ip: '2001:db8:1234:5600::1' });
    const b = rateLimitKey({ headers: {}, ip: '2001:db8:1234:56ff:ffff::2' });
    const c = rateLimitKey({ headers: {}, ip: '2001:db8:1234:5700::1' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
