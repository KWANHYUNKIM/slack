import test from 'node:test';
import assert from 'node:assert/strict';
import { canShowNotification, computeBadgeCount, getDesktop, showMessageNotification, type DesktopApi } from '../src/lib/desktop.ts';

const g = globalThis as unknown as { window?: { desktop?: unknown } };

function fakeDesktop() {
  const calls: { notify: unknown[]; badge: number[] } = { notify: [], badge: [] };
  const api: DesktopApi = {
    apiVersion: 1,
    platform: 'darwin',
    notify: (payload) => calls.notify.push(payload),
    setBadgeCount: (count) => calls.badge.push(count),
    changeServer: () => {},
    onNavigate: () => () => {},
  };
  return { api, calls };
}

test('웹(window.desktop 없음)에서는 데스크톱 기능을 쓰지 않는다', () => {
  g.window = {};
  assert.equal(getDesktop(), null);
  // node에는 Notification이 없으니 웹 알림 조건도 거짓이다
  assert.equal(canShowNotification(), false);
  delete g.window;
  assert.equal(getDesktop(), null);
});

test('모양이 다른 window.desktop은 무시한다', () => {
  g.window = { desktop: { apiVersion: 0 } };
  assert.equal(getDesktop(), null);
  g.window = { desktop: 'x' };
  assert.equal(getDesktop(), null);
  delete g.window;
});

test('데스크톱이면 네이티브 알림으로 보낸다', () => {
  const { api, calls } = fakeDesktop();
  g.window = { desktop: api };
  assert.equal(getDesktop(), api);
  assert.equal(canShowNotification(), true);
  showMessageNotification({ title: '#general', body: 'kim: hi', url: '/c/1' });
  assert.deepEqual(calls.notify, [{ title: '#general', body: 'kim: hi', path: '/c/1' }]);
  delete g.window;
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
