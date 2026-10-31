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
    keyGenerator: (req: Request) => {
      const token = (req as AuthRequest).accessToken;
      return token?.rateKey ?? `pat:${token?.tokenId ?? 'none'}`;
    },
  });
}

/**
 * 호출 횟수 저장소. express-rate-limit의 Store.increment와 같은 모양(totalHits, resetTime)이라
 * 다중 인스턴스에서는 Redis 같은 공유 저장소 구현으로 바꿔 끼울 수 있다.
 */
export interface WriteRateStore {
  /** key의 창 안 호출 수를 1 올리고 현재 값을 돌려준다. 창이 지났으면 1부터 다시 센다. */
  increment(key: string, windowMs: number): Promise<{ totalHits: number; resetTime: Date }> | { totalHits: number; resetTime: Date };
  resetAll?(): void;
}

/**
 * 기본 저장소: 프로세스 메모리의 고정 창.
 * 인스턴스가 여러 개면 인스턴스마다 따로 세므로 실제 한도가 인스턴스 수만큼 커진다(docs/architecture/mcp.md 5절).
 */
export class MemoryWriteStore implements WriteRateStore {
  private readonly hits = new Map<string, { totalHits: number; resetAt: number }>();

  increment(key: string, windowMs: number, now = Date.now()) {
    if (this.hits.size > 1000) {
      for (const [k, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(k);
    }
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { totalHits: 0, resetAt: now + windowMs };
      this.hits.set(key, entry);
    }
    entry.totalHits += 1;
    return { totalHits: entry.totalHits, resetTime: new Date(entry.resetAt) };
  }

  resetAll(): void {
    this.hits.clear();
  }
}

/**
 * 쓰기 도구 전용 호출 제한(토큰 단위, 기본 분당 30). 읽기까지 합친 HTTP 단위 제한(분당 120)보다 낮다.
 * 도구 호출은 JSON-RPC 본문 안에 있어 HTTP 미들웨어로는 구분할 수 없으므로 도구 실행 직전에 센다.
 */
export class WriteRateLimiter {
  constructor(
    public max = 30,
    private readonly windowMs = 60_000,
    private readonly store: WriteRateStore = new MemoryWriteStore(),
  ) {}

  /** 허용되면 null, 막히면 다시 시도할 때까지 남은 초. 숫자는 PAT id, 문자열은 버킷 키 그대로(OAuth는 `oauth:<계열>`). */
  async consume(key: number | string): Promise<number | null> {
    const { totalHits, resetTime } = await this.store.increment(typeof key === 'number' ? `pat:${key}` : key, this.windowMs);
    if (totalHits <= this.max) return null;
    return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
  }

  reset(): void {
    this.store.resetAll?.();
  }
}

export const mcpWriteLimiter = new WriteRateLimiter();
