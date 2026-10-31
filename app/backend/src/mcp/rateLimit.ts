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

/**
 * 쓰기 도구 전용 호출 제한(토큰 단위 고정 창, 기본 분당 30). 읽기까지 합친 HTTP 단위 제한(분당 120)보다 낮다.
 * 도구 호출은 JSON-RPC 본문 안에 있어 HTTP 미들웨어로는 구분할 수 없으므로 도구 실행 직전에 센다.
 * 상태는 프로세스 메모리에 둔다(인스턴스가 여러 개면 인스턴스마다 제한된다).
 */
export class WriteRateLimiter {
  private readonly hits = new Map<number, { count: number; resetAt: number }>();

  constructor(public max = 30, private readonly windowMs = 60_000) {}

  /** 허용되면 null, 막히면 다시 시도할 때까지 남은 초 */
  consume(tokenId: number, now = Date.now()): number | null {
    if (this.hits.size > 1000) {
      for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    }
    const entry = this.hits.get(tokenId);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(tokenId, { count: 1, resetAt: now + this.windowMs });
      return null;
    }
    if (entry.count >= this.max) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    entry.count += 1;
    return null;
  }

  reset(): void {
    this.hits.clear();
  }
}

export const mcpWriteLimiter = new WriteRateLimiter();
