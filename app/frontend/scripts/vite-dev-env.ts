// 개발 서버 환경 변수 해석. vite.config.ts와 playwright 설정이 함께 쓴다.
// VITE_DEV_API_TARGET: 프록시 대상 백엔드 주소(http(s)://host:port). 기본값은 로컬 백엔드 :3000.
// VITE_DEV_PORT: 개발 서버 포트. 기본값은 5173.
// 잘못된 값은 시작 시 오류로 멈춘다. 조용히 기본값으로 바꾸면 다른 백엔드에 붙었는지 알 수 없기 때문이다.

export const DEFAULT_DEV_API_TARGET = 'http://localhost:3000';
export const DEFAULT_DEV_PORT = 5173;

// 스킴, 호스트(도메인·IPv4·[IPv6]), 명시적 포트, 선택적 끝 슬래시만 허용한다. 경로·쿼리·계정 정보는 막는다.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const API_TARGET_PATTERN = /^(https?):\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\/?$/;

export function resolveDevApiTarget(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_DEV_API_TARGET;
  const match = API_TARGET_PATTERN.exec(value);
  if (!match) {
    throw new Error(`VITE_DEV_API_TARGET 형식이 잘못됐다: "${value}" (http(s)://host:port 형식만 허용)`);
  }
  const [, scheme, host, rawPort] = match;
  // 개발 프록시는 이 컴퓨터의 백엔드에만 붙는다(외부 호스트로 API를 보내지 않게, CLAUDE.md 17)
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(`VITE_DEV_API_TARGET 호스트는 localhost, 127.0.0.1, [::1]만 허용한다: "${value}"`);
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`VITE_DEV_API_TARGET 포트가 범위(1-65535)를 벗어났다: "${value}"`);
  }
  return `${scheme}://${host}:${port}`;
}

export function resolveDevPort(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_DEV_PORT;
  const port = Number(value);
  if (!/^\d{1,5}$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`VITE_DEV_PORT은 1-65535 사이 정수여야 한다: "${value}"`);
  }
  return port;
}

// 프록시 대상 URL에서 백엔드가 들을 포트를 꺼낸다(playwright가 PORT 환경 변수로 넘긴다).
// resolveDevApiTarget이 돌려준 값은 항상 ":포트"로 끝나므로 URL 파서의 기본 포트(80) 처리를 피해 마지막 콜론 뒤를 읽는다.
export function devApiTargetPort(target: string): number {
  return Number(target.slice(target.lastIndexOf(':') + 1));
}
