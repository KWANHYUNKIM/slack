// 빠른 전환기(06) 순수 로직 단위 테스트. 실행: npm run switcher:test (Node 24의 타입 제거로 .ts를 바로 읽는다)
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore } from '../src/lib/fuzzy.ts';
import {
  buildSwitcherItems,
  parseRecents,
  parseTargetPath,
  pruneRecents,
  pushRecent,
  rankSwitcherItems,
  sidebarOrder,
  stepTarget,
  RECENT_MAX,
} from '../src/lib/switcher.ts';
import { SHORTCUTS, detectMac, isEditableElement, matchShortcut, shortcutKeys } from '../src/lib/shortcuts.ts';

const ch = (id, name, extra = {}) => ({
  id, name, isPrivate: false, memberCount: 1, unreadCount: 0, isMember: true, mentionCount: 0, ...extra,
});
const dm = (userId, userName, extra = {}) => ({
  id: userId, userId, userName, userAvatar: '', userStatus: 'online', unreadCount: 0, mentionCount: 0, ...extra,
});
const group = (id, name, extra = {}) => ({ id, name, members: [], unreadCount: 0, mentionCount: 0, isStarred: false, ...extra });
const build = (channels, directMessages = [], groupDMs = []) =>
  buildSwitcherItems({ channels, directMessages, groupDMs, groupName: (g) => g.name ?? 'group' });
const labels = (items) => items.map((i) => i.label);
const cmp = (a, b) => a.localeCompare(b, 'ko');
const key = (k, o = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o });

// ---- 퍼지 매칭 ----
test('fuzzy: gen -> general이 gen 없는 이름보다 위', () => {
  const items = build([ch(1, 'random'), ch(2, 'general'), ch(3, 'engineering')]);
  assert.deepEqual(labels(rankSwitcherItems(items, 'gen', [], cmp)).slice(0, 2), ['general', 'engineering']);
});
test('fuzzy: 앞쪽 일치가 중간 일치보다 높다', () => {
  assert.ok(fuzzyScore('dev', 'dev-team') > fuzzyScore('dev', 'my-dev-team'));
  assert.ok(fuzzyScore('dev', 'my-dev-team') > fuzzyScore('dev', 'mydevteam'));
});
test('fuzzy: 연속이 아니어도 순서만 맞으면 일치하고 순서가 틀리면 불일치', () => {
  assert.notEqual(fuzzyScore('gnl', 'general'), null);
  assert.equal(fuzzyScore('lng', 'general'), null);
});
test('fuzzy: 대소문자와 전각 문자를 무시한다', () => {
  assert.notEqual(fuzzyScore('GEN', 'general'), null);
  assert.notEqual(fuzzyScore('ｇｅｎ', 'general'), null);
});
test('fuzzy: 한글 채널 이름', () => {
  const items = build([ch(1, '일반'), ch(2, '개발-공지'), ch(3, '잡담')]);
  assert.deepEqual(labels(rankSwitcherItems(items, '개발', [], cmp)), ['개발-공지']);
  assert.deepEqual(labels(rankSwitcherItems(items, '공지', [], cmp)), ['개발-공지']);
  assert.deepEqual(labels(rankSwitcherItems(items, '일', [], cmp)), ['일반']);
  assert.equal(fuzzyScore('ㅇㅂ', '일반'), null); // 초성 검색은 범위 밖
});
test('fuzzy: 빈 검색어는 0점, 빈 텍스트는 불일치', () => {
  assert.equal(fuzzyScore('', 'abc'), 0);
  assert.equal(fuzzyScore('a', ''), null);
});
test('rank: 별표/안 읽음 가점은 일치도가 비슷할 때 순서를 가른다', () => {
  const items = build([ch(1, 'dev-a'), ch(2, 'dev-b', { isStarred: true })]);
  assert.deepEqual(labels(rankSwitcherItems(items, 'dev', [], cmp)), ['dev-b', 'dev-a']);
});

// ---- 후보 만들기: 채널, 1:1 DM, 그룹 DM ----
test('후보: 채널(내가 속한 것만), DM, 그룹 DM, 경로', () => {
  const items = build([ch(1, 'a'), ch(2, 'b', { isMember: false })], [dm(7, 'Kim')], [group(9, 'Squad', { isStarred: true })]);
  assert.deepEqual(items.map((i) => i.path), ['/c/1', '/d/7', '/g/9']);
  assert.equal(items[2].isStarred, true);
});
test('후보: 채널을 나가거나 삭제하면 후보와 최근 방문에서 빠진다', () => {
  const recents = [{ kind: 'channel', id: 1 }, { kind: 'channel', id: 2 }, { kind: 'dm', id: 7 }];
  const before = build([ch(1, 'a'), ch(2, 'b')], [dm(7, 'Kim')]);
  assert.deepEqual(labels(rankSwitcherItems(before, '', recents, cmp)), ['a', 'b', 'Kim']);
  // 나가기: isMember=false
  const left = build([ch(1, 'a'), ch(2, 'b', { isMember: false })], [dm(7, 'Kim')]);
  assert.deepEqual(labels(rankSwitcherItems(left, '', recents, cmp)), ['a', 'Kim']);
  assert.deepEqual(pruneRecents(recents, left), [{ kind: 'channel', id: 1 }, { kind: 'dm', id: 7 }]);
  // 삭제: 스토어에서 사라짐
  const deleted = build([ch(1, 'a')], [dm(7, 'Kim')]);
  assert.deepEqual(labels(rankSwitcherItems(deleted, 'b', recents, cmp)), []);
  // 이름 변경은 같은 id의 label이 바뀌어 검색에 반영된다
  const renamed = build([ch(1, 'renamed'), ch(2, 'b')], [dm(7, 'Kim')]);
  assert.deepEqual(labels(rankSwitcherItems(renamed, 'renam', [], cmp)), ['renamed']);
});

// ---- 최근 방문 ----
test('최근: 빈 검색어는 최근 방문 순서, 8개로 채운다', () => {
  const channels = Array.from({ length: 12 }, (_, i) => ch(i + 1, `c${String(i + 1).padStart(2, '0')}`, { isStarred: i === 11 }));
  const items = build(channels);
  const out = rankSwitcherItems(items, '', [{ kind: 'channel', id: 5 }, { kind: 'channel', id: 3 }], cmp);
  assert.equal(out.length, 8);
  assert.deepEqual(labels(out).slice(0, 3), ['c05', 'c03', 'c12']); // 최근 -> 별표 -> 이름 순
});
test('최근: 기록 쌓기(맨 앞, 중복 제거, 최대 20개)와 지우기', () => {
  let list = [];
  for (let i = 1; i <= 25; i++) list = pushRecent(list, { kind: 'channel', id: i });
  assert.equal(list.length, RECENT_MAX);
  assert.deepEqual(list[0], { kind: 'channel', id: 25 });
  list = pushRecent(list, { kind: 'channel', id: 10 });
  assert.deepEqual(list[0], { kind: 'channel', id: 10 });
  assert.equal(list.filter((r) => r.id === 10).length, 1);
  // 종류가 다르면 같은 id여도 별개
  assert.equal(pushRecent([{ kind: 'channel', id: 1 }], { kind: 'dm', id: 1 }).length, 2);
});
test('최근: 깨진 localStorage 값은 빈 목록', () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents('not json'), []);
  assert.deepEqual(parseRecents('{"a":1}'), []);
  assert.deepEqual(parseRecents('[{"kind":"x","id":1},{"kind":"dm","id":"2"},{"kind":"dm","id":3}]'), [{ kind: 'dm', id: 3 }]);
});
test('경로 해석', () => {
  assert.deepEqual(parseTargetPath('/c/12'), { kind: 'channel', id: 12 });
  assert.deepEqual(parseTargetPath('/d/3/'), { kind: 'dm', id: 3 });
  assert.deepEqual(parseTargetPath('/g/4'), { kind: 'group', id: 4 });
  assert.equal(parseTargetPath('/files'), null);
  assert.equal(parseTargetPath('/c/abc'), null);
  assert.equal(parseTargetPath('/c/0'), null);
});

// ---- 이전/다음 대화 ----
test('Alt+위/아래: 사이드바 순서(별표 -> 공개 -> 비공개 -> DM -> 그룹)로 순환', () => {
  const order = sidebarOrder(
    { channels: [ch(1, 'pub'), ch(2, 'priv', { isPrivate: true }), ch(3, 'star', { isStarred: true })], directMessages: [dm(7, 'Kim')], groupDMs: [group(9, 'G')] },
    cmp,
  );
  assert.deepEqual(order.map((i) => i.key), ['channel:3', 'channel:1', 'channel:2', 'dm:7', 'group:9']);
  assert.equal(stepTarget(order, { kind: 'channel', id: 1 }, 1, false).key, 'channel:2');
  assert.equal(stepTarget(order, { kind: 'group', id: 9 }, 1, false).key, 'channel:3'); // 끝에서 처음으로
  assert.equal(stepTarget(order, { kind: 'channel', id: 3 }, -1, false).key, 'group:9');
  assert.equal(stepTarget(order, null, 1, false).key, 'channel:3');
  assert.equal(stepTarget([], null, 1, false), null);
});
test('Alt+Shift+위/아래: 안 읽은 대화만 건너뛰며 이동', () => {
  const order = sidebarOrder(
    { channels: [ch(1, 'a'), ch(2, 'b', { unreadCount: 2 }), ch(3, 'c'), ch(4, 'd', { mentionCount: 1 })], directMessages: [], groupDMs: [] },
    cmp,
  );
  assert.equal(stepTarget(order, { kind: 'channel', id: 1 }, 1, true).key, 'channel:2');
  assert.equal(stepTarget(order, { kind: 'channel', id: 2 }, 1, true).key, 'channel:4');
  assert.equal(stepTarget(order, { kind: 'channel', id: 1 }, -1, true).key, 'channel:4');
  const none = sidebarOrder({ channels: [ch(1, 'a'), ch(2, 'b')], directMessages: [], groupDMs: [] }, cmp);
  assert.equal(stepTarget(none, { kind: 'channel', id: 1 }, 1, true), null);
});

// ---- 단축키 판정 ----
test('단축키: Mac은 Cmd+K, 그 외는 Ctrl+K', () => {
  assert.equal(matchShortcut(key('k', { metaKey: true }), true)?.id, 'switcher');
  assert.equal(matchShortcut(key('k', { ctrlKey: true }), true), null); // Mac의 Ctrl+K는 다른 동작
  assert.equal(matchShortcut(key('k', { ctrlKey: true }), false)?.id, 'switcher');
  assert.equal(matchShortcut(key('k', { metaKey: true }), false), null);
  assert.equal(matchShortcut(key('K', { ctrlKey: true, shiftKey: false }), false)?.id, 'switcher'); // Caps Lock
  assert.equal(matchShortcut(key('k'), false), null);
});
test('단축키: ?, Esc, Alt+화살표, Alt+Shift+화살표를 구분', () => {
  assert.equal(matchShortcut(key('?', { shiftKey: true }), false)?.id, 'help');
  assert.equal(matchShortcut(key('?'), false)?.id, 'help');
  assert.equal(matchShortcut(key('Escape'), false)?.id, 'closeTop');
  assert.equal(matchShortcut(key('ArrowUp', { altKey: true }), false)?.id, 'prevChannel');
  assert.equal(matchShortcut(key('ArrowDown', { altKey: true }), false)?.id, 'nextChannel');
  assert.equal(matchShortcut(key('ArrowUp', { altKey: true, shiftKey: true }), false)?.id, 'prevUnread');
  assert.equal(matchShortcut(key('ArrowDown', { altKey: true, shiftKey: true }), false)?.id, 'nextUnread');
  assert.equal(matchShortcut(key('ArrowUp'), false), null);
});
test('단축키: 입력창에서 동작하는 것은 Cmd/Ctrl+K와 Esc뿐', () => {
  assert.deepEqual(SHORTCUTS.filter((d) => d.inEditable).map((d) => d.id).sort(), ['closeTop', 'switcher']);
  // e 같은 글자는 어떤 단축키에도 걸리지 않는다(편집 단축키 오발동 없음)
  for (const k of ['e', 'u', 'p', 'l']) assert.equal(matchShortcut(key(k), false), null);
});
test('단축키: 입력 요소 판정', () => {
  assert.equal(isEditableElement({ tagName: 'INPUT' }), true);
  assert.equal(isEditableElement({ tagName: 'textarea' }), true);
  assert.equal(isEditableElement({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isEditableElement({ tagName: 'P', closest: (s) => (s.includes('contenteditable') ? {} : null) }), true);
  assert.equal(isEditableElement({ tagName: 'BUTTON', closest: () => null }), false);
  assert.equal(isEditableElement(null), false);
});
test('단축키: OS별 라벨과 id 중복 없음', () => {
  const sw = SHORTCUTS.find((d) => d.id === 'switcher');
  assert.deepEqual(shortcutKeys(sw, true), ['⌘', 'K']);
  assert.deepEqual(shortcutKeys(sw, false), ['Ctrl', 'K']);
  assert.deepEqual(shortcutKeys(SHORTCUTS.find((d) => d.id === 'nextUnread'), false), ['Alt', 'Shift', '↓']);
  assert.equal(new Set(SHORTCUTS.map((d) => d.id)).size, SHORTCUTS.length);
  assert.equal(detectMac('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), true);
  assert.equal(detectMac('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), false);
});
