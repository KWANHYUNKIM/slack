/**
 * preload와 main 사이 IPC 채널 화이트리스트와 인자 검증 (순수 함수).
 * preload는 sandbox라 이 파일을 require하지 못한다. 같은 이름을 preload.ts에도 적고,
 * ipcContract.test.ts가 두 목록이 같은지 검사한다.
 */

/** 서버 페이지(window.desktop)가 보내는 채널 */
export const DESKTOP_CHANNELS = {
  notify: 'desktop:notify',
  setBadge: 'desktop:set-badge',
  changeServer: 'desktop:change-server',
} as const;

/** main이 서버 페이지로 보내는 채널 */
export const DESKTOP_EVENTS = {
  navigate: 'desktop:navigate',
} as const;

/** 서버 주소 입력 화면(window.setupApi)이 보내는 채널 */
export const SETUP_CHANNELS = {
  getState: 'setup:get-state',
  submit: 'setup:submit',
  reset: 'setup:reset',
  cancel: 'setup:cancel',
} as const;

export const ALL_CHANNELS: readonly string[] = [
  ...Object.values(DESKTOP_CHANNELS),
  ...Object.values(DESKTOP_EVENTS),
  ...Object.values(SETUP_CHANNELS),
];

export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_LENGTH = 500;
export const MAX_PATH_LENGTH = 512;
export const MAX_BADGE_COUNT = 9999;

export interface NotifyPayload {
  title: string;
  body: string;
  /** 알림을 눌렀을 때 앱 안에서 이동할 경로 ("/c/12" 같은 같은 origin 경로) */
  path: string | null;
}

/** 앱 안 경로: "/"로 시작하고 "//"(프로토콜 상대 URL)나 "/\"가 아니며 제어 문자가 없다 */
export function isSafeInAppPath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return false;
  return !/[\u0000-\u001f\u007f\\]/.test(value);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** desktop:notify 인자 검증. 틀리면 null(무시한다) */
export function parseNotifyPayload(raw: unknown): NotifyPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { title, body, path } = raw as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim()) return null;
  if (body !== undefined && typeof body !== 'string') return null;
  if (path !== undefined && path !== null && !isSafeInAppPath(path)) return null;
  return {
    title: clip(title, MAX_TITLE_LENGTH),
    body: clip(body ?? '', MAX_BODY_LENGTH),
    path: (path as string | null | undefined) ?? null,
  };
}

/** desktop:set-badge 인자 검증. 0 이상 정수만, 상한에서 자른다. 틀리면 null */
export function parseBadgeCount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null;
  return Math.min(raw, MAX_BADGE_COUNT);
}
