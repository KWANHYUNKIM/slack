// OAuth 동의 화면(mcp-4)으로 돌아올 주소. 로그인 안 한 상태로 동의 화면에 오면 여기에 적어 두고 로그인 화면으로 보낸다.
// 로그인이 끝나면 '/' 대신 이 주소로 간다. 탭을 닫으면 사라지게 sessionStorage에 둔다.
// 동의 화면 경로만 받는다(다른 주소를 넣어 로그인 뒤 엉뚱한 곳으로 보내지 못하게).

export const OAUTH_CONSENT_PATH = '/oauth-consent';
const KEY = 'oauthReturnTo';

const isConsentPath = (v: string) => v.startsWith(`${OAUTH_CONSENT_PATH}?`) && !v.includes('//');

export function rememberOAuthReturn(pathWithQuery: string): void {
  if (isConsentPath(pathWithQuery)) sessionStorage.setItem(KEY, pathWithQuery);
}

/** 로그인 뒤 갈 곳. 없으면 null. 동의 화면이 열리면 clearOAuthReturn으로 지운다. */
export function peekOAuthReturn(): string | null {
  const v = sessionStorage.getItem(KEY);
  return v && isConsentPath(v) ? v : null;
}

export function clearOAuthReturn(): void {
  sessionStorage.removeItem(KEY);
}
