/**
 * 데스크톱 셸의 보안 판단을 모은 순수 함수 (electron을 import하지 않는다 → node --test로 검사).
 * 규칙 출처: docs/security/nodejs-security.md 9절
 */

/** 서버 주소 입력 화면을 띄우는 앱 내부 스킴 (file:// 대신 쓴다) */
export const SETUP_SCHEME = 'app';
export const SETUP_HOST = 'setup';
export const SETUP_URL = `${SETUP_SCHEME}://${SETUP_HOST}/index.html`;

export type ServerUrlError = 'empty' | 'invalid' | 'scheme' | 'credentials' | 'insecure';
export type ServerUrlResult = { ok: true; origin: string } | { ok: false; error: ServerUrlError };

const MAX_SERVER_URL_LENGTH = 2048;

/** 192.168.x, 10.x, 172.16~31.x, 127.x, localhost, *.local 같은 내부망 주소인지 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * 사용자가 입력한 서버 주소를 origin 하나로 정규화한다.
 * - 스킴이 없으면 https://를 붙인다.
 * - http/https만 받는다. 아이디·비밀번호가 든 주소는 거부한다.
 * - http는 내부망(localhost, 사설 IP, .local)에서만 허용한다. 공용 주소는 https만.
 * - 경로, 쿼리, 해시는 버리고 origin만 저장한다(허용 origin이 정확히 하나가 되도록).
 */
export function normalizeServerUrl(input: unknown): ServerUrlResult {
  if (typeof input !== 'string') return { ok: false, error: 'invalid' };
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'empty' };
  if (trimmed.length > MAX_SERVER_URL_LENGTH || /\s/.test(trimmed)) return { ok: false, error: 'invalid' };

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  // "localhost:3000"은 스킴처럼 보이지만 호스트:포트다
  const looksLikeHostPort = /^[a-z0-9.-]+:\d+(\/|$)/i.test(trimmed);
  const candidate = hasScheme && !looksLikeHostPort ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'scheme' };
  if (url.username || url.password) return { ok: false, error: 'credentials' };
  if (!url.hostname) return { ok: false, error: 'invalid' };
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) return { ok: false, error: 'insecure' };
  return { ok: true, origin: url.origin };
}

/** 문자열 URL의 origin. 해석이 안 되거나 불투명(origin "null")하면 null */
export function originOf(rawUrl: string): string | null {
  try {
    const origin = new URL(rawUrl).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** 저장한 서버 origin과 정확히 같은 곳으로만 앱 안 이동을 허용한다 */
export function isAllowedNavigation(targetUrl: string, serverOrigin: string | null): boolean {
  if (!serverOrigin) return false;
  return originOf(targetUrl) === serverOrigin;
}

/** 서버 주소 입력 화면(app://setup/...)인지 */
export function isSetupPageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${SETUP_SCHEME}:` && url.host === SETUP_HOST;
  } catch {
    return false;
  }
}

/** shell.openExternal에 넘겨도 되는 주소인지: http/https만, 아이디·비밀번호 없는 것 */
export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * window.open, target=_blank 처리. 새 Electron 창은 만들지 않는다.
 * http(s)면 기본 브라우저로 열고, 나머지(file:, javascript:, 커스텀 스킴 등)는 버린다.
 */
export type WindowOpenDecision = 'open-external' | 'deny';
export function decideWindowOpen(targetUrl: string): WindowOpenDecision {
  return isSafeExternalUrl(targetUrl) ? 'open-external' : 'deny';
}

/**
 * will-navigate에서 막은 이동의 처리. 서버 origin이면 그대로 두고,
 * 다른 http(s) 주소면 브라우저로 넘기고, 그 밖은 버린다.
 */
export type NavigationDecision = 'allow' | 'open-external' | 'deny';
export function decideNavigation(targetUrl: string, serverOrigin: string | null): NavigationDecision {
  if (isAllowedNavigation(targetUrl, serverOrigin)) return 'allow';
  return isSafeExternalUrl(targetUrl) ? 'open-external' : 'deny';
}

/** 서버 페이지에 허용하는 권한. 나머지(위치, MIDI, HID, 화면 녹화 등)는 모두 거부한다. */
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media', // 허들(음성·영상 통화)의 마이크·카메라
  'clipboard-sanitized-write',
  'fullscreen',
]);

export function isPermissionAllowed(
  permission: string,
  requestingUrl: string,
  serverOrigin: string | null,
  mediaTypes: readonly string[] = [],
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  if (!isAllowedNavigation(requestingUrl, serverOrigin)) return false;
  if (permission === 'media') return mediaTypes.every((t) => t === 'audio' || t === 'video');
  return true;
}

/**
 * app:// 요청 경로를 내부 파일 이름으로 바꾼다. 허용 목록에 있는 파일만 내준다(경로 조작 차단).
 */
export const SETUP_ASSETS: Readonly<Record<string, string>> = {
  '/index.html': 'index.html',
  '/setup.css': 'setup.css',
  '/setup.js': 'setup.js',
};

export function resolveSetupAsset(rawUrl: string): string | null {
  if (!isSetupPageUrl(rawUrl)) return null;
  const { pathname } = new URL(rawUrl);
  return Object.prototype.hasOwnProperty.call(SETUP_ASSETS, pathname) ? SETUP_ASSETS[pathname] : null;
}
