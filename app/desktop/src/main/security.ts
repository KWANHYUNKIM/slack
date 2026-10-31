import { shell, type Session, type WebContents } from 'electron';
import { decideNavigation, decideWindowOpen, isAllowedNavigation, isPermissionAllowed, isSafeExternalUrl } from './policy';

/**
 * 모든 webContents와 세션에 보안 처리를 건다 (docs/security/nodejs-security.md 9절).
 * getServerOrigin은 지금 저장된 서버 origin을 돌려준다(서버를 바꾸면 바로 반영되게 함수로 받는다).
 */

function openExternal(url: string): void {
  if (!isSafeExternalUrl(url)) return;
  shell.openExternal(url).catch(() => {});
}

export interface SecurityHooks {
  getServerOrigin: () => string | null;
  /** 메인 프레임이 다른 origin으로 리다이렉트되려 할 때 */
  onBlockedRedirect: (contents: WebContents, targetUrl: string) => void;
}

export function hardenWebContents(contents: WebContents, hooks: SecurityHooks): void {
  // 새 창은 만들지 않는다. http(s)면 기본 브라우저로 연다.
  contents.setWindowOpenHandler(({ url }) => {
    if (decideWindowOpen(url) === 'open-external') openExternal(url);
    return { action: 'deny' };
  });

  // 링크 클릭, location 변경: 서버 origin 밖이면 막고 http(s)는 브라우저로 넘긴다
  contents.on('will-navigate', (event) => {
    const decision = decideNavigation(event.url, hooks.getServerOrigin());
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'open-external') openExternal(event.url);
  });

  // iframe 안 이동도 서버 origin으로 제한한다(메인 프레임은 위 will-navigate가 처리)
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return;
    if (!isAllowedNavigation(event.url, hooks.getServerOrigin())) event.preventDefault();
  });

  // 서버 리다이렉트가 다른 origin으로 가면 멈춘다(허용 origin은 하나뿐)
  contents.on('will-redirect', (event) => {
    if (isAllowedNavigation(event.url, hooks.getServerOrigin())) return;
    event.preventDefault();
    if (event.isMainFrame) hooks.onBlockedRedirect(contents, event.url);
  });

  // <webview>는 쓰지 않는다
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

export function hardenSession(session: Session, getServerOrigin: () => string | null): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    const requestingUrl = details.requestingUrl || contents.getURL();
    callback(isPermissionAllowed(permission, requestingUrl, getServerOrigin(), mediaTypes));
  });

  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return isPermissionAllowed(permission, requestingOrigin, getServerOrigin());
  });

  // USB, HID, 시리얼 장치 접근은 모두 거부한다
  session.setDevicePermissionHandler(() => false);
}
