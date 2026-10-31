/**
 * 데스크톱 앱(Electron 셸, app/desktop) 연동. preload가 window.desktop을 넣어 줄 때만 동작하고,
 * 웹 브라우저에서는 window.desktop이 없어서 기존 웹 동작(서비스 워커 알림)을 그대로 쓴다.
 * API 모양은 app/desktop/src/preload/preload.ts와 같아야 한다.
 */

export interface DesktopNotifyPayload {
  title: string;
  body?: string;
  /** 알림을 눌렀을 때 앱 안에서 이동할 경로 ("/c/12") */
  path?: string | null;
}

export interface DesktopApi {
  apiVersion: number;
  platform: string;
  notify(payload: DesktopNotifyPayload): void;
  setBadgeCount(count: number): void;
  changeServer(): void;
  onNavigate(callback: (path: string) => void): () => void;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

/** 데스크톱 앱 안에서 실행 중이면 API를, 아니면 null을 돌려준다 */
export function getDesktop(): DesktopApi | null {
  if (typeof window === 'undefined') return null;
  const api = window.desktop;
  return api && typeof api === 'object' && api.apiVersion >= 1 ? api : null;
}

/** 알림을 띄울 수 있는지: 데스크톱이면 항상, 웹이면 권한과 서비스 워커가 있을 때 */
export function canShowNotification(): boolean {
  if (getDesktop()) return true;
  return typeof Notification !== 'undefined' && Notification.permission === 'granted' && !!navigator.serviceWorker?.controller;
}

/** 메시지 알림. 데스크톱이면 네이티브 알림, 웹이면 서비스 워커 알림 */
export function showMessageNotification({ title, body, url }: { title: string; body: string; url: string }): void {
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

interface BadgeSource {
  channels: readonly { mentionCount: number }[];
  directMessages: readonly { unreadCount: number }[];
  groupDMs: readonly { unreadCount: number }[];
}

/** 독·작업 표시줄 배지 숫자: 채널 멘션 + 1:1 DM 안 읽음 + 그룹 DM 안 읽음 */
export function computeBadgeCount({ channels, directMessages, groupDMs }: BadgeSource): number {
  const sum = (items: readonly number[]) => items.reduce((acc, n) => acc + (Number.isFinite(n) && n > 0 ? n : 0), 0);
  return (
    sum(channels.map((c) => c.mentionCount)) +
    sum(directMessages.map((d) => d.unreadCount)) +
    sum(groupDMs.map((g) => g.unreadCount))
  );
}
