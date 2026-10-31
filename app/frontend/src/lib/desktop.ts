/**
 * 데스크톱 앱(Electron 셸, app/desktop) 연동. preload가 window.desktop을 넣어 줄 때만 동작하고,
 * 웹 브라우저에서는 window.desktop이 없어서 기존 웹 동작(서비스 워커 알림)을 그대로 쓴다.
 * API 모양은 app/desktop/src/preload/preload.ts와 같아야 한다.
 * 이 파일은 다른 모듈을 import하지 않는다(node --test scripts/desktop.test.ts로 검사).
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

/** 데스크톱 알림 켜기/끄기 설정(localStorage). 값이 없으면 켜짐 */
export const DESKTOP_NOTIFICATIONS_KEY = 'desktopNotifications';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem'>;

export function readDesktopNotificationsEnabled(storage: ReadableStorage | null | undefined): boolean {
  try {
    return storage?.getItem(DESKTOP_NOTIFICATIONS_KEY) !== 'off';
  } catch {
    return true; // 저장소를 못 읽으면 기본값
  }
}

export function writeDesktopNotificationsEnabled(storage: WritableStorage | null | undefined, enabled: boolean): void {
  try {
    storage?.setItem(DESKTOP_NOTIFICATIONS_KEY, enabled ? 'on' : 'off');
  } catch {
    // 저장소를 못 쓰면(사생활 보호 모드 등) 이번 세션만 반영되지 않는다
  }
}

export interface NotificationContext {
  /** 데스크톱 앱인지 */
  isDesktop: boolean;
  /** 데스크톱 알림 설정 */
  desktopEnabled: boolean;
  /** 앱 창에 포커스가 있는지 (데스크톱 판단 기준) */
  windowFocused: boolean;
  /** 탭이 보이지 않는지 (웹 판단 기준) */
  documentHidden: boolean;
  /** 방해 금지 중인지 */
  dnd: boolean;
  /** 웹: 알림 권한이 granted인지 */
  webPermissionGranted: boolean;
  /** 웹: 서비스 워커가 페이지를 제어하는지 */
  hasServiceWorker: boolean;
}

/**
 * 메시지 알림을 띄울지 정한다.
 * - 공통: 방해 금지 중이면 띄우지 않는다.
 * - 데스크톱: 설정이 켜져 있고 창에 포커스가 없을 때 (다른 앱을 보고 있으면 창이 보여도 알린다)
 * - 웹: 탭이 숨겨져 있고, 권한과 서비스 워커가 있을 때 (기존 동작 그대로)
 */
export function shouldShowNotification(ctx: NotificationContext): boolean {
  if (ctx.dnd) return false;
  if (ctx.isDesktop) return ctx.desktopEnabled && !ctx.windowFocused;
  return ctx.documentHidden && ctx.webPermissionGranted && ctx.hasServiceWorker;
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
