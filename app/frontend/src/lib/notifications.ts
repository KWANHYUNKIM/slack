import { isMyDndNow } from '@/stores/useStatusStore';
import { getDesktop, readDesktopNotificationsEnabled, shouldShowNotification } from '@/lib/desktop';

/**
 * 메시지 알림 (웹: 서비스 워커 알림, 데스크톱: 네이티브 알림).
 * 표시 조건(포커스·숨김, 방해 금지, 권한·설정)은 여기서만 판단한다. 호출부는 "보낼 만한 메시지인지"만 본다.
 */

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 지금 알림을 띄울 수 있는지 */
export function canShowNotification(): boolean {
  const isDesktop = !!getDesktop();
  return shouldShowNotification({
    isDesktop,
    desktopEnabled: isDesktop && readDesktopNotificationsEnabled(safeLocalStorage()),
    windowFocused: document.hasFocus(),
    documentHidden: document.hidden,
    dnd: isMyDndNow(),
    webPermissionGranted: typeof Notification !== 'undefined' && Notification.permission === 'granted',
    hasServiceWorker: !!navigator.serviceWorker?.controller,
  });
}

/** 조건을 만족하면 메시지 알림을 띄운다 */
export function showMessageNotification({ title, body, url }: { title: string; body: string; url: string }): void {
  if (!canShowNotification()) return;
  const desktop = getDesktop();
  if (desktop) {
    desktop.notify({ title, body, path: url });
    return;
  }
  navigator.serviceWorker.ready
    .then((reg) => {
      reg.showNotification(title, {
        body,
        icon: '/favicon-192.png',
        badge: '/favicon-192.png',
        data: { url },
      });
    })
    .catch(() => {});
}
