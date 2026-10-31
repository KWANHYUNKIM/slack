// 관리자 낙관적 업데이트의 롤백 로직. 스냅샷 전체를 되돌리지 않고, 실패한 항목 하나만 되돌린다.
// 다른 항목의 성공한 변경이 함께 날아가지 않게 하려고 순수 함수로 두고 scripts/admin-rollback.test.ts로 검증한다.

interface HasId {
  id: number;
}

/** id가 같은 항목을 뺀 목록과, 되돌릴 때 쓸 항목과 원래 위치를 돌려준다. 없으면 null. */
export function removeById<T extends HasId>(list: T[], id: number): { next: T[]; item: T; index: number } | null {
  const index = list.findIndex((x) => x.id === id);
  if (index < 0) return null;
  return { next: [...list.slice(0, index), ...list.slice(index + 1)], item: list[index], index };
}

/** 지운 항목을 원래 위치에 다시 넣는다(위치가 줄었으면 끝). 이미 있으면 그대로 둔다. */
export function restoreItem<T extends HasId>(list: T[], item: T, index: number): T[] {
  if (list.some((x) => x.id === item.id)) return list;
  const at = Math.min(Math.max(index, 0), list.length);
  return [...list.slice(0, at), item, ...list.slice(at)];
}

/** id가 같은 항목의 지정한 필드만 바꾼다. 항목이 없으면 목록을 그대로 돌려준다. */
export function patchById<T extends HasId>(list: T[], id: number, patch: Partial<T>): T[] {
  return list.map((x) => (x.id === id ? { ...x, ...patch } : x));
}

/** 항목에서 지정한 필드의 현재 값만 골라 담는다. 변경 전 값을 롤백용으로 보관할 때 쓴다. */
export function pickFields<T, K extends keyof T>(item: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = item[key];
  return out;
}
