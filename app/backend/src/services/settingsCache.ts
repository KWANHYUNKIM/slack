import prisma from '../db.js';

// 조직 설정(WorkspaceSetting) 중 요청마다 보는 정책 값의 공용 캐시. 2FA 필수(E7b)와 OAuth 앱 허용(mcp-4)이 함께 쓴다.
// 인증 미들웨어가 요청마다 부르므로 5초만 캐시하고, 값을 바꾸는 쪽은 invalidateSettingsCache로 바로 비운다.
// 인스턴스가 여러 개면 다른 인스턴스에는 최대 5초 늦게 반영된다. 토큰 발급처럼 늦으면 안 되는 판단은 캐시를 쓰지 않고
// 트랜잭션 안에서 행을 다시 읽는다(oauthService). E1에서 조직·워크스페이스 설정이 나뉘면 이 모듈에서 키를 나눈다.

export interface PolicySettings {
  requireMfa: boolean;
  allowOAuthApps: boolean;
}

const DEFAULTS: PolicySettings = { requireMfa: false, allowOAuthApps: true };
const TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 5_000;
let cache: { value: PolicySettings; cachedUntil: number } | null = null;

export async function getPolicySettings(): Promise<PolicySettings> {
  const now = Date.now();
  if (cache && cache.cachedUntil > now) return cache.value;
  const row = await prisma.workspaceSetting.findUnique({ where: { id: 1 }, select: { requireMfa: true, allowOAuthApps: true } });
  const value = row ?? DEFAULTS;
  cache = { value: { requireMfa: value.requireMfa, allowOAuthApps: value.allowOAuthApps }, cachedUntil: now + TTL_MS };
  return cache.value;
}

export function invalidateSettingsCache(): void {
  cache = null;
}
