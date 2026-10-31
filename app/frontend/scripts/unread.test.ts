import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUnread, hasUnreadOutOfRange, previousTimelineId, type UnreadCandidate } from '../src/lib/unread.ts';

const ME = 1;
const msg = (id: number, userId = 2, extra: Partial<UnreadCandidate> = {}): UnreadCandidate => ({ id, userId, ...extra });

test('기준점이 중간이면 다음 메시지 앞에 선이 선다', () => {
  const r = computeUnread([msg(1), msg(2), msg(3), msg(4)], 2, ME);
  assert.deepEqual(r, { dividerBeforeId: 3, unreadLoaded: 2 });
});

test('기준점이 마지막이면 선이 없다', () => {
  assert.deepEqual(computeUnread([msg(1), msg(2)], 2, ME), { dividerBeforeId: null, unreadLoaded: 0 });
});

test('기준점이 null이면 첫 메시지 앞이다', () => {
  assert.deepEqual(computeUnread([msg(5), msg(6)], null, ME), { dividerBeforeId: 5, unreadLoaded: 2 });
});

test('내 메시지는 제외한다', () => {
  const r = computeUnread([msg(1), msg(2, ME), msg(3), msg(4, ME)], 1, ME);
  assert.deepEqual(r, { dividerBeforeId: 3, unreadLoaded: 1 });
});

test('내 메시지만 새로 있으면 선이 없다', () => {
  assert.equal(computeUnread([msg(1), msg(2, ME)], 1, ME).dividerBeforeId, null);
});

test('삭제된 안 읽음은 건너뛰고 선이 다음 메시지로 옮겨 간다', () => {
  const r = computeUnread([msg(1), msg(2, 2, { isDeleted: true }), msg(3)], 1, ME);
  assert.deepEqual(r, { dividerBeforeId: 3, unreadLoaded: 1 });
  assert.equal(computeUnread([msg(1), msg(2, 2, { isDeleted: true })], 1, ME).dividerBeforeId, null);
});

test('스레드 답글은 건너뛰고 채널에도 보낸 답글은 센다', () => {
  const r = computeUnread([msg(1), msg(2, 2, { threadId: 1 }), msg(3, 2, { threadId: 1, alsoSendToChannel: true })], 1, ME);
  assert.deepEqual(r, { dividerBeforeId: 3, unreadLoaded: 1 });
});

test('빈 목록', () => {
  assert.deepEqual(computeUnread([], 3, ME), { dividerBeforeId: null, unreadLoaded: 0 });
});

test('범위 밖 안 읽음: 서버 수가 로드 수보다 많고 첫 메시지가 기준점보다 새것', () => {
  const loaded = [msg(100), msg(101), msg(102)];
  assert.equal(hasUnreadOutOfRange(loaded, 50, 60), true);
  assert.equal(hasUnreadOutOfRange(loaded, 50, 3), false);
  assert.equal(hasUnreadOutOfRange(loaded, 100, 60), false); // 기준점이 로드 범위 안
  assert.equal(hasUnreadOutOfRange(loaded, null, 0), false);
});

test('mark unread: 바로 앞 타임라인 메시지', () => {
  const list = [msg(1), msg(2, 2, { threadId: 1 }), msg(3, 2, { isDeleted: true }), msg(4)];
  assert.equal(previousTimelineId(list, 4), 1);
  assert.equal(previousTimelineId(list, 1), null);
});
