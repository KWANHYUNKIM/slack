import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBadgeCount,
  DESKTOP_NOTIFICATIONS_KEY,
  getDesktop,
  readDesktopNotificationsEnabled,
  shouldShowNotification,
  writeDesktopNotificationsEnabled,
  type DesktopApi,
  type NotificationContext,
} from '../src/lib/desktop.ts';

const g = globalThis as unknown as { window?: { desktop?: unknown } };

function fakeDesktop(): DesktopApi {
  return {
    apiVersion: 1,
    platform: 'darwin',
    notify: () => {},
    setBadgeCount: () => {},
    changeServer: () => {},
    onNavigate: () => () => {},
  };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test('웹(window.desktop 없음)에서는 데스크톱 기능을 쓰지 않는다', () => {
  g.window = {};
  assert.equal(getDesktop(), null);
  delete g.window;
  assert.equal(getDesktop(), null);
});

test('모양이 다른 window.desktop은 무시한다', () => {
  g.window = { desktop: { apiVersion: 0 } };
  assert.equal(getDesktop(), null);
  g.window = { desktop: 'x' };
  assert.equal(getDesktop(), null);
  const api = fakeDesktop();
  g.window = { desktop: api };
  assert.equal(getDesktop(), api);
  delete g.window;
});

test('데스크톱 알림 설정 CRUD: 기본 켜짐 → 끔 → 조회 → 켬 → 지움(기본값) 반복', () => {
  const storage = memoryStorage();
  for (let round = 0; round < 3; round += 1) {
    assert.equal(readDesktopNotificationsEnabled(storage), true); // 값 없음 = 켜짐
    writeDesktopNotificationsEnabled(storage, false);
    assert.equal(storage.getItem(DESKTOP_NOTIFICATIONS_KEY), 'off');
    assert.equal(readDesktopNotificationsEnabled(storage), false);
    writeDesktopNotificationsEnabled(storage, true);
    assert.equal(readDesktopNotificationsEnabled(storage), true);
    writeDesktopNotificationsEnabled(storage, false);
    storage.removeItem(DESKTOP_NOTIFICATIONS_KEY);
  }
  // 알 수 없는 값, 저장소 없음, 읽기 오류는 기본값(켜짐)
  storage.setItem(DESKTOP_NOTIFICATIONS_KEY, 'garbage');
  assert.equal(readDesktopNotificationsEnabled(storage), true);
  assert.equal(readDesktopNotificationsEnabled(null), true);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readDesktopNotificationsEnabled(broken), true);
  assert.doesNotThrow(() => writeDesktopNotificationsEnabled(broken, false));
});

const desktopCtx: NotificationContext = {
  isDesktop: true,
  desktopEnabled: true,
  windowFocused: false,
  documentHidden: false,
  dnd: false,
  webPermissionGranted: false,
  hasServiceWorker: false,
};
const webCtx: NotificationContext = {
  isDesktop: false,
  desktopEnabled: false,
  windowFocused: false,
  documentHidden: true,
  dnd: false,
  webPermissionGranted: true,
  hasServiceWorker: true,
};

test('알림 조건(데스크톱): 창에 포커스가 없고 설정이 켜져 있고 방해 금지가 아닐 때', () => {
  assert.equal(shouldShowNotification(desktopCtx), true); // 창이 보여도 다른 앱을 보고 있으면 알린다
  assert.equal(shouldShowNotification({ ...desktopCtx, windowFocused: true }), false);
  assert.equal(shouldShowNotification({ ...desktopCtx, windowFocused: true, documentHidden: true }), false);
  assert.equal(shouldShowNotification({ ...desktopCtx, desktopEnabled: false }), false);
  assert.equal(shouldShowNotification({ ...desktopCtx, dnd: true }), false);
  // 웹 권한·서비스 워커는 데스크톱 판단에 쓰지 않는다
  assert.equal(shouldShowNotification({ ...desktopCtx, webPermissionGranted: true, hasServiceWorker: true }), true);
});

test('알림 조건(웹): 기존 동작 그대로 (숨김 + 권한 + 서비스 워커, 방해 금지 아님)', () => {
  assert.equal(shouldShowNotification(webCtx), true);
  assert.equal(shouldShowNotification({ ...webCtx, documentHidden: false }), false);
  assert.equal(shouldShowNotification({ ...webCtx, webPermissionGranted: false }), false);
  assert.equal(shouldShowNotification({ ...webCtx, hasServiceWorker: false }), false);
  assert.equal(shouldShowNotification({ ...webCtx, dnd: true }), false);
  // 웹에서는 데스크톱 설정과 포커스를 보지 않는다
  assert.equal(shouldShowNotification({ ...webCtx, desktopEnabled: false, windowFocused: true }), true);
});

test('배지 숫자: 채널 멘션 + DM 안 읽음 + 그룹 DM 안 읽음', () => {
  assert.equal(computeBadgeCount({ channels: [], directMessages: [], groupDMs: [] }), 0);
  assert.equal(
    computeBadgeCount({
      channels: [{ mentionCount: 2 }, { mentionCount: 0 }],
      directMessages: [{ unreadCount: 3 }],
      groupDMs: [{ unreadCount: 1 }, { unreadCount: 4 }],
    }),
    10,
  );
  // 음수나 NaN은 0으로 본다
  assert.equal(
    computeBadgeCount({ channels: [{ mentionCount: -1 }], directMessages: [{ unreadCount: NaN }], groupDMs: [{ unreadCount: 1 }] }),
    1,
  );
});
