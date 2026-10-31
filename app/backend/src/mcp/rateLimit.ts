import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { AuthRequest } from '../types.js';

// /mcp 전용 rate limit(mcp.md 5절). 일반 API(apiLimiter)와 버킷을 나눈다.

/**
 * 인증 실패(401)만 IP 단위로 센다. 토큰 추측(무차별 대입)을 늦춘다.
 * 405(GET /mcp)나 토큰 단위 429처럼 인증은 통과한 응답까지 세면 정상 클라이언트가 IP째 잠기므로 401만 실패로 본다.
 */
export function createMcpAuthFailureLimiter(max = 30) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later' },
    keyGenerator: (req: Request) => (req.ip ? ipKeyGenerator(req.ip) : 'unknown'),
  });
}

/** 인증 뒤에 토큰 단위로 센다. 같은 사용자가 토큰을 여러 개 써도 토큰마다 따로 제한된다. */
export function createMcpTokenLimiter(max = 120) {
  return rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' },
    keyGenerator: (req: Request) => `pat:${(req as AuthRequest).accessToken?.tokenId ?? 'none'}`,
  });
}
