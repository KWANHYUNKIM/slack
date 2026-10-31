import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { ERR } from '../utils/errorCodes.js';

// 법적 보존(E6). 보존 건(LegalHold)에 대상 사용자(custodian)를 묶는다. 활성(releasedAt 없음) 보존 건이 하나라도 있으면 그 사용자는 보존 대상이다.
//
// User.legalHold는 이 계산 결과의 캐시다(화면 표시와 하위 호환용). 데이터 보존 정리(retentionService)는 캐시에 기대지 않고
// 활성 보존 관계를 직접 조건으로 쓴다(플래그 OR 관계: 둘 중 하나라도 보존이면 제외). 그래서 캐시가 잠깐 어긋나도 데이터는 지워지지 않는다.
// 보존 건을 바꾸는 모든 경로는 같은 트랜잭션 안에서 syncHoldFlags로 캐시를 다시 계산한다.
// 동시성: 두 요청이 같은 사용자를 서로 다른 보존 건에서 동시에 빼면, 각자 상대의 변경을 못 본 채 계산해 결과가 어긋날 수 있다.
// 보존 건 변경은 드물므로 트랜잭션 단위 advisory lock 하나로 전부 직렬화한다.

export const HOLD_NAME_MAX = 100;
export const HOLD_DESCRIPTION_MAX = 1000;
export const CUSTODIANS_PER_REQUEST_MAX = 100;
const LOCK_KEY = 0x4c48; // 'LH'. 다른 advisory lock과 겹치지 않게 고정값을 쓴다.

type Tx = Prisma.TransactionClient;

export type HoldResult<T> = { ok: true; value: T } | { ok: false; status: number; body: { error: string; code: string } };

const fail = (status: number, error: string, code: string): HoldResult<never> => ({ ok: false, status, body: { error, code } });
const NOT_FOUND = () => fail(404, 'Legal hold not found', ERR.LEGAL_HOLD_NOT_FOUND);
const RELEASED = () => fail(409, 'Legal hold has been released', ERR.LEGAL_HOLD_RELEASED);

const USER_SELECT = { id: true, name: true, email: true, avatar: true, deactivatedAt: true } as const;

const HOLD_LIST_SELECT = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  releasedAt: true,
  creator: { select: { id: true, name: true } },
  releaser: { select: { id: true, name: true } },
  _count: { select: { custodians: true } },
} as const;

type HoldListRow = Prisma.LegalHoldGetPayload<{ select: typeof HOLD_LIST_SELECT }>;

const holdView = ({ _count, ...h }: HoldListRow) => ({ ...h, custodianCount: _count.custodians });

/** 모든 보존 건 변경은 이 안에서 한다. 잠금은 트랜잭션이 끝나면 풀린다. */
async function withHoldLock<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    return fn(tx);
  });
}

/** 주어진 사용자들의 User.legalHold를 활성 보존 건 기준으로 다시 계산한다. */
export async function syncHoldFlags(tx: Tx, userIds: number[]): Promise<void> {
  if (userIds.length === 0) return;
  const held = await tx.legalHoldCustodian.findMany({
    where: { userId: { in: userIds }, hold: { releasedAt: null } },
    select: { userId: true },
    distinct: ['userId'],
  });
  const heldIds = held.map((h) => h.userId);
  const freeIds = userIds.filter((id) => !heldIds.includes(id));
  if (heldIds.length > 0) await tx.user.updateMany({ where: { id: { in: heldIds }, legalHold: false }, data: { legalHold: true } });
  if (freeIds.length > 0) await tx.user.updateMany({ where: { id: { in: freeIds }, legalHold: true }, data: { legalHold: false } });
}

export type HoldStatus = 'active' | 'released' | 'all';

/** 최신순 커서 페이지 */
export async function listHolds(status: HoldStatus, limit: number, cursor: number | undefined) {
  const where: Prisma.LegalHoldWhereInput = {
    ...(status === 'active' ? { releasedAt: null } : status === 'released' ? { releasedAt: { not: null } } : {}),
    ...(cursor ? { id: { lt: cursor } } : {}),
  };
  const rows = await prisma.legalHold.findMany({ where, select: HOLD_LIST_SELECT, orderBy: { id: 'desc' }, take: limit + 1 });
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(holdView);
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export async function getHold(id: number) {
  const hold = await prisma.legalHold.findUnique({
    where: { id },
    select: {
      ...HOLD_LIST_SELECT,
      custodians: { select: { addedAt: true, user: { select: USER_SELECT } }, orderBy: { addedAt: 'asc' } },
    },
  });
  if (!hold) return null;
  const { custodians, ...rest } = hold;
  return { ...holdView(rest), custodians: custodians.map((c) => ({ ...c.user, addedAt: c.addedAt })) };
}

export type HoldDetail = NonNullable<Awaited<ReturnType<typeof getHold>>>;

/** 존재하는 사용자 id만 남긴다. 비활성 사용자도 대상이 될 수 있다(퇴사자 보존이 흔한 경우다). */
async function existingUsers(tx: Tx, userIds: number[]): Promise<{ id: number; name: string }[]> {
  return tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
}

export async function createHold(input: { name: string; description: string | null; userIds: number[] }, actorId: number): Promise<HoldResult<{ id: number; added: { id: number; name: string }[] }>> {
  return withHoldLock(async (tx) => {
    const users = await existingUsers(tx, input.userIds);
    if (users.length !== new Set(input.userIds).size) return fail(400, 'Unknown user', ERR.LEGAL_HOLD_INVALID_USERS);
    const hold = await tx.legalHold.create({ data: { name: input.name, description: input.description, createdBy: actorId } });
    if (users.length > 0) {
      await tx.legalHoldCustodian.createMany({ data: users.map((u) => ({ holdId: hold.id, userId: u.id, addedBy: actorId })) });
      await syncHoldFlags(tx, users.map((u) => u.id));
    }
    return { ok: true, value: { id: hold.id, added: users } };
  });
}

export async function updateHold(id: number, input: { name?: string; description?: string | null }): Promise<HoldResult<{ before: { name: string; description: string | null } }>> {
  return withHoldLock(async (tx) => {
    const hold = await tx.legalHold.findUnique({ where: { id } });
    if (!hold) return NOT_FOUND();
    if (hold.releasedAt) return RELEASED();
    await tx.legalHold.update({ where: { id }, data: input });
    return { ok: true, value: { before: { name: hold.name, description: hold.description } } };
  });
}

/** 이미 대상인 사용자는 건너뛴다. 새로 추가된 사용자만 돌려준다. */
export async function addCustodians(id: number, userIds: number[], actorId: number): Promise<HoldResult<{ name: string; added: { id: number; name: string }[] }>> {
  return withHoldLock(async (tx) => {
    const hold = await tx.legalHold.findUnique({ where: { id } });
    if (!hold) return NOT_FOUND();
    if (hold.releasedAt) return RELEASED();
    const users = await existingUsers(tx, userIds);
    if (users.length !== new Set(userIds).size) return fail(400, 'Unknown user', ERR.LEGAL_HOLD_INVALID_USERS);
    const already = new Set(
      (await tx.legalHoldCustodian.findMany({ where: { holdId: id, userId: { in: userIds } }, select: { userId: true } })).map((c) => c.userId),
    );
    const added = users.filter((u) => !already.has(u.id));
    if (added.length > 0) {
      await tx.legalHoldCustodian.createMany({ data: added.map((u) => ({ holdId: id, userId: u.id, addedBy: actorId })) });
      await syncHoldFlags(tx, added.map((u) => u.id));
    }
    return { ok: true, value: { name: hold.name, added } };
  });
}

export async function removeCustodian(id: number, userId: number): Promise<HoldResult<{ name: string; userName: string; stillHeld: boolean }>> {
  return withHoldLock(async (tx) => {
    const hold = await tx.legalHold.findUnique({ where: { id } });
    if (!hold) return NOT_FOUND();
    if (hold.releasedAt) return RELEASED();
    const row = await tx.legalHoldCustodian.findUnique({ where: { holdId_userId: { holdId: id, userId } }, select: { user: { select: { name: true } } } });
    if (!row) return fail(404, 'User is not a custodian of this hold', ERR.LEGAL_HOLD_CUSTODIAN_NOT_FOUND);
    await tx.legalHoldCustodian.delete({ where: { holdId_userId: { holdId: id, userId } } });
    await syncHoldFlags(tx, [userId]);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { legalHold: true } });
    return { ok: true, value: { name: hold.name, userName: row.user.name, stillHeld: user.legalHold } };
  });
}

/** 해제하면 대상자 목록은 기록으로 남고, 다른 활성 보존 건에 없는 사용자는 정리 대상으로 돌아간다. 되돌릴 수 없다. */
export async function releaseHold(id: number, actorId: number): Promise<HoldResult<{ name: string; custodianCount: number; freed: number }>> {
  return withHoldLock(async (tx) => {
    const hold = await tx.legalHold.findUnique({ where: { id }, include: { custodians: { select: { userId: true } } } });
    if (!hold) return NOT_FOUND();
    if (hold.releasedAt) return RELEASED();
    await tx.legalHold.update({ where: { id }, data: { releasedAt: new Date(), releasedBy: actorId } });
    const ids = hold.custodians.map((c) => c.userId);
    await syncHoldFlags(tx, ids);
    const freed = ids.length === 0 ? 0 : await tx.user.count({ where: { id: { in: ids }, legalHold: false } });
    return { ok: true, value: { name: hold.name, custodianCount: ids.length, freed } };
  });
}
