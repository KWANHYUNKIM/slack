// 배포 환경 설정(TRUST_PROXY, PUBLIC_URL)을 해석한다. app.ts와 테스트가 함께 쓴다.

type Env = Record<string, string | undefined>;

/**
 * TRUST_PROXY 해석. 기본값 0(프록시를 신뢰하지 않음).
 * 숫자(홉 수), true/false, 또는 Express가 받는 문자열(예: "loopback", CIDR 목록)을 허용한다.
 */
export function parseTrustProxy(value: string | undefined): number | boolean | string {
  const v = (value ?? '').trim();
  if (v === '') return 0;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  return v;
}

/** PUBLIC_URL의 scheme이 http이면 true. 비어 있거나 https면 false(기본은 https 전제). */
export function isHttpPublicUrl(env: Env): boolean {
  const url = (env.PUBLIC_URL ?? '').trim().toLowerCase();
  return url.startsWith('http://');
}

/** http 운영 모드(LAN 시험용)에서는 HTTPS 강제 헤더(HSTS, upgrade-insecure-requests)와 secure 쿠키를 끈다. */
export function useSecureTransport(env: Env): boolean {
  return !isHttpPublicUrl(env);
}
