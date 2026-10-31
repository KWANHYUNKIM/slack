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
  LEGACY_RECENT_KEY,
  recentStorageKey,
  loadRecents,
  saveRecents,
  canPruneRecents,
  sidebarSections,
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
  // Esc는 전역에서 판정하지 않는다(각 모달의 onKeyDown이 처리)
  assert.equal(matchShortcut(key('Escape'), false), null);
  assert.equal(matchShortcut(key('ArrowUp', { altKey: true }), false)?.id, 'prevChannel');
  assert.equal(matchShortcut(key('ArrowDown', { altKey: true }), false)?.id, 'nextChannel');
  assert.equal(matchShortcut(key('ArrowUp', { altKey: true, shiftKey: true }), false)?.id, 'prevUnread');
  assert.equal(matchShortcut(key('ArrowDown', { altKey: true, shiftKey: true }), false)?.id, 'nextUnread');
  assert.equal(matchShortcut(key('ArrowUp'), false), null);
});
test('단축키: 입력창에서 동작하는 것은 Cmd/Ctrl+K와 Esc뿐', () => {
  assert.deepEqual(SHORTCUTS.filter((d) => d.inEditable && !d.docOnly).map((d) => d.id), ['switcher']);
  // e 같은 글자는 어떤 단축키에도 걸리지 않는다(편집 단축키 오발동 없음)
  for (const k of ['e', 'u', 'p', 'l']) assert.equal(matchShortcut(key(k), false), null);
});
test('단축키: 입력 요소 판정', () => {
  assert.equal(isEditableElement({ tagName: 'INPUT' }), true);
  for (const type of ['text', 'search', 'email', 'url', 'tel', 'password', 'number']) {
    assert.equal(isEditableElement({ tagName: 'INPUT', type }), true, type);
  }
  for (const type of ['checkbox', 'radio', 'button', 'submit', 'range', 'file']) {
    assert.equal(isEditableElement({ tagName: 'INPUT', type, closest: () => null }), false, type);
  }
  assert.equal(isEditableElement({ tagName: 'SELECT', closest: () => null }), false);
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

// ---- 리뷰 반영 ----
test('최근 정리: 세 목록이 모두 로드되고 실패가 없을 때만', () => {
  const ok = { channelsLoaded: true, dmsLoaded: true, groupsLoaded: true, loadError: null };
  assert.equal(canPruneRecents(ok), true);
  assert.equal(canPruneRecents({ ...ok, channelsLoaded: false }), false);
  assert.equal(canPruneRecents({ ...ok, dmsLoaded: false }), false);
  assert.equal(canPruneRecents({ ...ok, groupsLoaded: false }), false);
  assert.equal(canPruneRecents({ ...ok, loadError: '불러오지 못했습니다' }), false);
  // 로드 전의 빈 목록으로 정리하면 기록이 모두 사라지므로 호출자가 위 조건을 지켜야 한다
  const recents = [{ kind: 'channel', id: 1 }];
  assert.deepEqual(pruneRecents(recents, build([])), []);
  assert.deepEqual(pruneRecents(recents, build([ch(1, 'a')])), recents);
});

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    keys: () => [...m.keys()],
  };
}
test('최근 저장: 사용자별 키, 예전 공용 키는 읽고 버린다, 로그아웃(지우기)은 현재 사용자 것만', () => {
  const st = fakeStorage({ [LEGACY_RECENT_KEY]: JSON.stringify([{ kind: 'channel', id: 99 }]) });
  assert.deepEqual(loadRecents(st, 1), []); // 공용 키 내용을 물려받지 않는다
  assert.equal(st.getItem(LEGACY_RECENT_KEY), null);
  saveRecents(st, 1, [{ kind: 'channel', id: 5 }]);
  saveRecents(st, 2, [{ kind: 'dm', id: 8 }]);
  assert.deepEqual(st.keys().sort(), [recentStorageKey(1), recentStorageKey(2)]);
  assert.deepEqual(loadRecents(st, 1), [{ kind: 'channel', id: 5 }]);
  assert.deepEqual(loadRecents(st, 2), [{ kind: 'dm', id: 8 }]);
  saveRecents(st, 1, []); // clearRecents / 로그아웃
  assert.equal(st.getItem(recentStorageKey(1)), null);
  assert.deepEqual(loadRecents(st, 2), [{ kind: 'dm', id: 8 }]);
  // 저장소가 예외를 던져도 안전
  const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
  assert.deepEqual(loadRecents(broken, 1), []);
  saveRecents(broken, 1, [{ kind: 'dm', id: 1 }]);
});

test('단축키 경계: AltGr', () => {
  // Windows 독일어 배열 등: AltGr는 ctrl+alt로 보고된다. 글자 단축키 `?`는 보조키를 무시하고 인식
  assert.equal(matchShortcut(key('?', { ctrlKey: true, altKey: true }), false)?.id, 'help');
  assert.equal(matchShortcut(key('?', { altKey: true, getModifierState: (k) => k === 'AltGraph' }), false)?.id, 'help');
  // getModifierState가 AltGraph 아님이라고 하면 진짜 Ctrl+Alt: `?`로 보지 않는다
  assert.equal(matchShortcut(key('?', { ctrlKey: true, altKey: true, getModifierState: () => false }), false), null);
  // AltGr 상태에서는 Ctrl+K도 Alt+화살표도 발동하지 않는다
  assert.equal(matchShortcut(key('k', { ctrlKey: true, altKey: true }), false), null);
  assert.equal(matchShortcut(key('ArrowUp', { ctrlKey: true, altKey: true }), false), null);
  // Mac은 Ctrl+Alt가 AltGr가 아니다
  assert.equal(matchShortcut(key('?', { ctrlKey: true, altKey: true }), true), null);
});
test('단축키 경계: Shift 정확 일치', () => {
  assert.equal(matchShortcut(key('K', { ctrlKey: true, shiftKey: true }), false), null); // Ctrl+Shift+K
  assert.equal(matchShortcut(key('K', { metaKey: true, shiftKey: true }), true), null);
  assert.equal(matchShortcut(key('k', { ctrlKey: true }), false)?.id, 'switcher');
  assert.equal(matchShortcut(key('Escape', { shiftKey: true }), false, [{ id: 'x', key: 'Escape', inEditable: true, group: 'general', labelKey: 'x' }]), null);
  assert.equal(matchShortcut(key('?', { shiftKey: true }), false)?.id, 'help'); // 기호는 예외
  assert.equal(matchShortcut(key('ArrowUp', { altKey: true, shiftKey: true }), false)?.id, 'prevUnread');
});
test('단축키 경계: 키 라벨 번역과 기호 유지', () => {
  const sw = SHORTCUTS.find((d) => d.id === 'switcher');
  const ko = { ctrl: '컨트롤', alt: '알트', shift: '시프트', esc: '이에스씨', enter: '엔터' };
  assert.deepEqual(shortcutKeys(sw, false, (id) => ko[id]), ['컨트롤', 'K']);
  assert.deepEqual(shortcutKeys(sw, true, (id) => ko[id]), ['⌘', 'K']);
  assert.deepEqual(shortcutKeys(SHORTCUTS.find((d) => d.id === 'closeTop'), false, (id) => ko[id]), ['이에스씨']);
  assert.deepEqual(shortcutKeys(SHORTCUTS.find((d) => d.id === 'prevUnread'), true, (id) => ko[id]), ['⌥', '⇧', '↑']);
});
test('사이드바 구역: 별표는 별표 구역으로만, 비멤버 채널 제외, 순서 함수와 일치', () => {
  const input = {
    channels: [ch(1, 'b'), ch(2, 'a'), ch(3, 'p', { isPrivate: true }), ch(4, 's', { isStarred: true }), ch(5, 'x', { isMember: false })],
    directMessages: [dm(7, 'Kim', { isStarred: true }), dm(8, 'Lee')],
    groupDMs: [group(9, 'G1', { isStarred: true }), group(10, 'G2')],
  };
  const sec = sidebarSections(input, cmp);
  assert.deepEqual(sec.starredChannels.map((c) => c.id), [4]);
  assert.deepEqual(sec.publicChannels.map((c) => c.id), [2, 1]);
  assert.deepEqual(sec.privateChannels.map((c) => c.id), [3]);
  assert.deepEqual(sec.starredDMs.map((d) => d.userId), [7]);
  assert.deepEqual(sec.plainDMs.map((d) => d.userId), [8]);
  assert.deepEqual(sec.starredGroups.map((g) => g.id), [9]);
  assert.deepEqual(sec.plainGroups.map((g) => g.id), [10]);
  assert.deepEqual(sidebarOrder(input, cmp).map((i) => i.key), ['channel:4', 'dm:7', 'group:9', 'channel:2', 'channel:1', 'channel:3', 'dm:8', 'group:10']);
});
