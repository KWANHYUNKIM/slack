import test from 'node:test';
import assert from 'node:assert/strict';
import { computeUnread, countUnreadFrom, dmUnreadScope, hasUnreadOutOfRange, previousTimelineId, type UnreadCandidate } from '../src/lib/unread.ts';

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

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));

test('범위 밖 60개: 열 때 50개만 로드되면 범위 밖, 실시간 10개가 와도 열 때 판정이 기준이다', () => {
  const atOpen = range(11, 60); // 서버 total 60, 로드 50
  assert.equal(hasUnreadOutOfRange(atOpen, null, 60), true);
  // 실시간 10개가 붙은 뒤에 다시 계산하면 판정이 뒤집힌다: 그래서 화면은 열 때 한 번만 판정해 고정한다
  const later = [...atOpen, ...range(61, 70)];
  assert.equal(hasUnreadOutOfRange(later, null, 60), false);
  assert.equal(computeUnread(later, null, ME).dividerBeforeId, 11);
});

test('모두 읽음 후 새 메시지: 순수 계산은 새 메시지를 첫 안 읽음으로 보지만 화면은 dividerAllowed=false로 막는다', () => {
  const list = range(1, 5);
  assert.equal(computeUnread(list, 5, ME).dividerBeforeId, null);
  assert.equal(computeUnread([...list, msg(6)], 5, ME).dividerBeforeId, 6);
});

test('mark unread 개수는 서버 규칙(삭제·스레드 답글 제외, 내 것 포함)과 같다', () => {
  const list = [msg(1), msg(2, 2, { threadId: 1 }), msg(3, ME), msg(4, 2, { isDeleted: true }), msg(5)];
  assert.equal(countUnreadFrom(list, 1), 3);
  assert.equal(countUnreadFrom(list, 4), 1);
});

// DM(1:1, 그룹) 구분선: 기준점은 서버가 읽음 처리 이전 값으로 내려준다
test('DM: 상대가 3개 보낸 뒤 열면 첫 안 읽음 앞에 선이 서고, 기준점이 최신이 되면(재진입) 선이 없다', () => {
  const list = [msg(10, ME), msg(11), msg(12), msg(13)];
  assert.deepEqual(computeUnread(list, 10, ME), { dividerBeforeId: 11, unreadLoaded: 3 });
  assert.equal(computeUnread(list, 13, ME).dividerBeforeId, null);
});

test('DM: 안 읽은 메시지를 지우면 선이 다음 안 읽은 메시지로 옮겨 간다', () => {
  const list = [msg(10, ME), msg(11), msg(12), msg(13)];
  assert.equal(computeUnread(list, 10, ME).dividerBeforeId, 11);
  assert.deepEqual(computeUnread(list.filter((m) => m.id !== 11), 10, ME), { dividerBeforeId: 12, unreadLoaded: 2 });
  assert.equal(computeUnread(list.filter((m) => m.id > 10 && m.id !== 11 && m.id !== 12 && m.id !== 13), 10, ME).dividerBeforeId, null);
});

test('dmUnreadScope: 채널 id와 겹치지 않고 1:1·그룹 대화끼리도 겹치지 않는다', () => {
  const scopes = new Set<number>();
  for (let n = 1; n <= 50; n++) {
    scopes.add(dmUnreadScope(n)); // 1:1: userId n
    scopes.add(dmUnreadScope(-n)); // 그룹: groupId n
  }
  assert.equal(scopes.size, 100);
  assert.ok([...scopes].every((v) => v < 0));
});
