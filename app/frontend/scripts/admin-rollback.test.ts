import test from 'node:test';
import assert from 'node:assert/strict';
import { removeById, restoreItem, patchById, pickFields } from '../src/lib/adminRollback.ts';

interface Row { id: number; name: string; role?: string; deactivatedAt?: string | null }
const rows = (...ids: number[]): Row[] => ids.map((id) => ({ id, name: `r${id}` }));
const ids = (list: Row[]) => list.map((r) => r.id);

test('removeById는 위치와 항목을 기억하고, 없으면 null이다', () => {
  const removed = removeById(rows(1, 2, 3), 2);
  assert.ok(removed);
  assert.equal(removed.index, 1);
  assert.equal(removed.item.id, 2);
  assert.deepEqual(ids(removed.next), [1, 3]);
  assert.equal(removeById(rows(1), 9), null);
});

test('restoreItem은 원래 위치에 다시 넣는다', () => {
  const restored = restoreItem(rows(1, 3), { id: 2, name: 'r2' }, 1);
  assert.deepEqual(ids(restored), [1, 2, 3]);
});

test('restoreItem은 위치가 줄었으면 끝에 넣고, 이미 있으면 그대로 둔다', () => {
  assert.deepEqual(ids(restoreItem(rows(1), { id: 5, name: 'r5' }, 4)), [1, 5]);
  const same = rows(1, 2);
  assert.equal(restoreItem(same, { id: 2, name: 'r2' }, 0), same);
});

test('초대 2개를 연속 삭제하다가 한쪽이 실패하면 실패한 쪽만 원래 자리에 돌아온다', () => {
  // 목록 [a, b, c]에서 b를 먼저 지우고(성공), 그다음 a를 지운다(실패)
  let list = rows(1, 2, 3);
  const b = removeById(list, 2);
  assert.ok(b);
  list = b.next; // [1, 3]
  const a = removeById(list, 1);
  assert.ok(a);
  list = a.next; // [3]

  // a 요청 실패: a만 원래 위치(0)로 되돌린다. b 삭제 결과는 그대로 남는다
  list = restoreItem(list, a.item, a.index);
  assert.deepEqual(ids(list), [1, 3]);
});

test('연속 삭제에서 먼저 지운 쪽이 뒤에 실패해도 현재 목록 기준으로 되돌린다', () => {
  let list = rows(1, 2, 3);
  const first = removeById(list, 1);
  assert.ok(first);
  list = first.next; // [2, 3]
  const second = removeById(list, 3);
  assert.ok(second);
  list = second.next; // [2]

  // 두 번째(3번) 실패: 원래 위치 2에 되돌린다
  list = restoreItem(list, second.item, second.index);
  assert.deepEqual(ids(list), [2, 3]);
  // 첫 번째(1번)는 성공했으므로 되돌리지 않는다
  assert.equal(list.some((r) => r.id === 1), false);
});

test('patchById는 한 항목의 필드만 바꾸고 나머지는 그대로 둔다', () => {
  const list = rows(1, 2);
  const next = patchById(list, 2, { role: 'ADMIN' });
  assert.equal(next[1].role, 'ADMIN');
  assert.equal(next[0], list[0]);
  assert.deepEqual(ids(patchById(list, 9, { role: 'X' })), [1, 2]);
});

test('변경 실패 롤백은 그 항목의 이전 필드만 되돌리고, 다른 항목의 성공한 변경을 지우지 않는다', () => {
  let list: Row[] = [
    { id: 1, name: 'a', role: 'MEMBER' },
    { id: 2, name: 'b', role: 'MEMBER' },
  ];
  // 1번 역할을 ADMIN으로 바꾸는 동안 2번 비활성화는 성공했다
  const prev = pickFields(list[0], ['role']);
  list = patchById(list, 1, { role: 'ADMIN' });
  list = patchById(list, 2, { deactivatedAt: '2026-10-31T00:00:00.000Z' });

  // 1번 요청 실패: 1번의 role만 되돌린다
  list = patchById(list, 1, prev);
  assert.equal(list[0].role, 'MEMBER');
  assert.equal(list[1].deactivatedAt, '2026-10-31T00:00:00.000Z');
});

test('pickFields는 지정한 키만 현재 값으로 담는다', () => {
  const row: Row = { id: 1, name: 'a', role: 'GUEST', deactivatedAt: null };
  assert.deepEqual(pickFields(row, ['role', 'deactivatedAt']), { role: 'GUEST', deactivatedAt: null });
});
