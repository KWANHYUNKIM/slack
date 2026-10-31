// 빠른 전환기(06)의 후보 만들기·정렬·최근 방문. 순수 함수만 둔다(node:test: scripts/switcher.test.mjs).
// 스토어/React를 가져오지 않으므로 타입은 `import type`만 쓴다.

import { fuzzyScore } from './fuzzy.ts';
import type { Channel, DirectMessage, GroupDM } from './types.ts';

export type TargetKind = 'channel' | 'dm' | 'group';

/** localStorage['recentTargets']에 저장하는 항목. 비밀 정보 없음. */
export interface RecentTarget {
  kind: TargetKind;
  id: number;
}

export interface SwitcherItem {
  /** 목록 key이자 aria-activedescendant 대상: `channel:3` */
  key: string;
  kind: TargetKind;
  /** channel: 채널 id, dm: 상대 userId, group: 그룹 id (경로에 쓰는 값) */
  id: number;
  label: string;
  path: string;
  isPrivate?: boolean;
  isStarred: boolean;
  unreadCount: number;
  mentionCount: number;
}

/** 예전 공용 키. 사용자별 키로 옮기면서 한 번 읽어 버린다. */
export const LEGACY_RECENT_KEY = 'recentTargets';
/** 사용자별 최근 방문 저장 키 */
export const recentStorageKey = (userId: number) => `recentTargets:${userId}`;
export const RECENT_MAX = 20;
export const SWITCHER_EMPTY_LIMIT = 8;
export const SWITCHER_RESULT_LIMIT = 30;

export const targetKey = (kind: TargetKind, id: number) => `${kind}:${id}`;

export function targetPath(kind: TargetKind, id: number): string {
  return kind === 'channel' ? `/c/${id}` : kind === 'dm' ? `/d/${id}` : `/g/${id}`;
}

/** 경로가 채널/DM/그룹 화면이면 대상을 돌려준다. 그 밖의 경로는 null. */
export function parseTargetPath(pathname: string): RecentTarget | null {
  const m = /^\/(c|d|g)\/(\d+)\/?$/.exec(pathname);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { kind: m[1] === 'c' ? 'channel' : m[1] === 'd' ? 'dm' : 'group', id };
}

/** 최근 방문 맨 앞에 넣는다(중복 제거, 최대 RECENT_MAX). */
export function pushRecent(list: RecentTarget[], target: RecentTarget): RecentTarget[] {
  const rest = list.filter((r) => !(r.kind === target.kind && r.id === target.id));
  return [target, ...rest].slice(0, RECENT_MAX);
}

/** localStorage 값이 깨져 있어도 안전하게 읽는다. */
export function parseRecents(raw: string | null): RecentTarget[] {
  if (!raw) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: RecentTarget[] = [];
    for (const r of data) {
      const rec = r as Partial<RecentTarget> | null;
      if (
        rec && typeof rec === 'object' &&
        (rec.kind === 'channel' || rec.kind === 'dm' || rec.kind === 'group') &&
        typeof rec.id === 'number' && Number.isSafeInteger(rec.id)
      ) {
        out.push({ kind: rec.kind, id: rec.id });
      }
    }
    return out.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** localStorage 모양의 최소 인터페이스(테스트에서 가짜로 대체) */
export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** 사용자별 최근 방문을 읽는다. 예전 공용 키는 버린다. */
export function loadRecents(storage: StorageLike, userId: number): RecentTarget[] {
  try {
    storage.removeItem(LEGACY_RECENT_KEY);
    return parseRecents(storage.getItem(recentStorageKey(userId)));
  } catch {
    return [];
  }
}

export function saveRecents(storage: StorageLike, userId: number, list: RecentTarget[]): void {
  try {
    if (list.length === 0) storage.removeItem(recentStorageKey(userId));
    else storage.setItem(recentStorageKey(userId), JSON.stringify(list));
  } catch {
    // 저장소가 막혀 있어도 화면 동작은 계속한다
  }
}

/** 채널, DM, 그룹 목록이 모두 로드를 마쳤고 실패가 없을 때만 최근 방문을 정리해도 된다. */
export function canPruneRecents(s: { channelsLoaded: boolean; dmsLoaded: boolean; groupsLoaded: boolean; loadError: string | null }): boolean {
  return s.channelsLoaded && s.dmsLoaded && s.groupsLoaded && !s.loadError;
}

interface BuildInput {
  channels: Channel[];
  directMessages: DirectMessage[];
  groupDMs: GroupDM[];
  /** 그룹 DM 표시 이름(로캘 목록 형식이라 호출자가 만든다) */
  groupName: (g: GroupDM) => string;
}

/** 후보 전체. 내가 속한 채널만 넣는다(나가거나 삭제된 채널은 스토어에서 빠지거나 isMember가 꺼진다). */
export function buildSwitcherItems({ channels, directMessages, groupDMs, groupName }: BuildInput): SwitcherItem[] {
  const items: SwitcherItem[] = [];
  for (const ch of channels) {
    if (!ch.isMember) continue;
    items.push({
      key: targetKey('channel', ch.id), kind: 'channel', id: ch.id, label: ch.name, path: targetPath('channel', ch.id),
      isPrivate: ch.isPrivate, isStarred: !!ch.isStarred, unreadCount: ch.unreadCount, mentionCount: ch.mentionCount,
    });
  }
  for (const dm of directMessages) {
    items.push({
      key: targetKey('dm', dm.userId), kind: 'dm', id: dm.userId, label: dm.userName, path: targetPath('dm', dm.userId),
      isStarred: !!dm.isStarred, unreadCount: dm.unreadCount, mentionCount: dm.mentionCount,
    });
  }
  for (const g of groupDMs) {
    items.push({
      key: targetKey('group', g.id), kind: 'group', id: g.id, label: groupName(g), path: targetPath('group', g.id),
      isStarred: g.isStarred, unreadCount: g.unreadCount, mentionCount: g.mentionCount,
    });
  }
  return items;
}

/** 후보에 없는(나갔거나 삭제된) 대상을 최근 방문에서 뺀다. */
export function pruneRecents(recents: RecentTarget[], items: SwitcherItem[]): RecentTarget[] {
  const alive = new Set(items.map((i) => i.key));
  return recents.filter((r) => alive.has(targetKey(r.kind, r.id)));
}

const hasUnread = (i: SwitcherItem) => i.unreadCount + i.mentionCount > 0;

/**
 * 전환기에 보여 줄 목록.
 * - 빈 검색어: 최근 방문 순서, 모자라면 별표 -> 안 읽음 -> 이름 순으로 SWITCHER_EMPTY_LIMIT까지 채운다.
 * - 검색어 있음: 퍼지 점수 + 별표/안 읽음/최근 가점, 동점이면 이름 순.
 */
export function rankSwitcherItems(
  items: SwitcherItem[],
  query: string,
  recents: RecentTarget[],
  compare: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): SwitcherItem[] {
  const recentRank = new Map(recents.map((r, i) => [targetKey(r.kind, r.id), i]));

  if (query.trim().length === 0) {
    const byKey = new Map(items.map((i) => [i.key, i]));
    const out: SwitcherItem[] = [];
    const seen = new Set<string>();
    for (const r of recents) {
      const it = byKey.get(targetKey(r.kind, r.id));
      if (it && !seen.has(it.key)) {
        out.push(it);
        seen.add(it.key);
      }
    }
    const filler = items
      .filter((i) => !seen.has(i.key))
      .sort((a, b) =>
        Number(b.isStarred) - Number(a.isStarred) ||
        Number(hasUnread(b)) - Number(hasUnread(a)) ||
        compare(a.label, b.label));
    return [...out, ...filler].slice(0, SWITCHER_EMPTY_LIMIT);
  }

  const scored: { item: SwitcherItem; score: number }[] = [];
  for (const item of items) {
    const base = fuzzyScore(query, item.label);
    if (base === null) continue;
    let score = base;
    if (item.isStarred) score += 50;
    if (hasUnread(item)) score += 20;
    const r = recentRank.get(item.key);
    if (r !== undefined) score += Math.max(0, 20 - r);
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || compare(a.item.label, b.item.label));
  return scored.slice(0, SWITCHER_RESULT_LIMIT).map((s) => s.item);
}

/**
 * 사이드바 표시 구역(Sidebar.tsx와 Alt+위/아래 이동이 함께 쓴다).
 * 별표 구역(채널, DM, 그룹) -> 공개 채널 -> 비공개 채널 -> 일반 DM -> 일반 그룹.
 * 별표를 단 항목은 별표 구역으로만 가고, 내가 속하지 않은 채널은 뺀다.
 */
export function sidebarSections(
  input: { channels: Channel[]; directMessages: DirectMessage[]; groupDMs: GroupDM[] },
  compare: (a: string, b: string) => number,
) {
  const byName = (a: Channel, b: Channel) => compare(a.name, b.name);
  const member = input.channels.filter((ch) => ch.isMember);
  return {
    starredChannels: member.filter((ch) => ch.isStarred).sort(byName),
    starredDMs: input.directMessages.filter((dm) => dm.isStarred),
    starredGroups: input.groupDMs.filter((g) => g.isStarred),
    publicChannels: member.filter((ch) => !ch.isPrivate && !ch.isStarred).sort(byName),
    privateChannels: member.filter((ch) => ch.isPrivate && !ch.isStarred).sort(byName),
    plainDMs: input.directMessages.filter((dm) => !dm.isStarred),
    plainGroups: input.groupDMs.filter((g) => !g.isStarred),
  };
}

/** sidebarSections를 한 줄 순서로 편 대상 목록(이전/다음 대화 이동용) */
export function sidebarOrder(
  input: { channels: Channel[]; directMessages: DirectMessage[]; groupDMs: GroupDM[] },
  compare: (a: string, b: string) => number,
): SwitcherItem[] {
  const sec = sidebarSections(input, compare);
  const keep = (list: Channel[] | DirectMessage[] | GroupDM[], kind: 'channel' | 'dm' | 'group') => {
    const items = buildSwitcherItems({
      channels: kind === 'channel' ? (list as Channel[]) : [],
      directMessages: kind === 'dm' ? (list as DirectMessage[]) : [],
      groupDMs: kind === 'group' ? (list as GroupDM[]) : [],
      groupName: () => '',
    });
    return items;
  };
  return [
    ...keep(sec.starredChannels, 'channel'),
    ...keep(sec.starredDMs, 'dm'),
    ...keep(sec.starredGroups, 'group'),
    ...keep(sec.publicChannels, 'channel'),
    ...keep(sec.privateChannels, 'channel'),
    ...keep(sec.plainDMs, 'dm'),
    ...keep(sec.plainGroups, 'group'),
  ];
}

/** 현재 대상 기준 이전/다음(옵션: 안 읽은 것만) 항목. 현재가 목록에 없으면 처음/끝에서 시작한다. 없으면 null. */
export function stepTarget(
  order: SwitcherItem[],
  current: RecentTarget | null,
  dir: 1 | -1,
  unreadOnly: boolean,
): SwitcherItem | null {
  const n = order.length;
  if (n === 0) return null;
  const cur = current ? order.findIndex((i) => i.kind === current.kind && i.id === current.id) : -1;
  for (let step = 1; step <= n; step++) {
    const idx = cur === -1
      ? (dir === 1 ? step - 1 : n - step)
      : (((cur + dir * step) % n) + n) % n;
    if (idx === cur) return null;
    const it = order[idx];
    if (!unreadOnly || hasUnread(it)) return it;
  }
  return null;
}
