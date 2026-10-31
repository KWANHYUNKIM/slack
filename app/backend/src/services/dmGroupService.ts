import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { attachableFiles } from './fileAttach.js';
import { getIO, isUserOnline } from '../websocket/index.js';
import { DM_INCLUDE_USERS } from '../db/selects.js';
import { logError } from '../utils/logger.js';
import { sendPushToUser } from './pushService.js';
import { createActivitiesForDm } from './mentionService.js';
import { enforceDlp, recordDlpWarnings } from './dlpService.js';

// 그룹 DM(본인 포함 3~9명) 공용 로직. HTTP 라우트(routes/dmGroups.ts, routes/dms.ts의 메시지 단위 경로)와
// 소켓(dmgroup:send)이 같은 함수를 불러 동작을 맞춘다. 권한 검사(멤버 여부)는 호출한 쪽이 먼저 한다.

/** 본인을 뺀 상대 수 최소·최대. 1명이면 1:1 DM을 쓴다. */
export const MIN_GROUP_OTHERS = 2;
export const MAX_GROUP_SIZE = 9;

export const GROUP_MEMBER_SELECT = { id: true, name: true, avatar: true, status: true } as const;

/** 정렬한 id를 '-'로 잇는다. 같은 멤버 집합이면 같은 키가 나온다. */
export function memberKeyFor(userIds: number[]): string {
  return [...new Set(userIds)].sort((a, b) => a - b).join('-');
}

export async function getGroupMemberIds(groupId: number): Promise<number[]> {
  const rows = await prisma.dMGroupMember.findMany({ where: { groupId }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

/** 그룹 이벤트는 멤버 각자의 개인 room(user:<id>)으로 보낸다. 기존 dm:* 이벤트와 같은 방식이다. */
export function emitToUsers(userIds: number[], event: string, payload: unknown): void {
  const io = getIO();
  if (!io || userIds.length === 0) return;
  io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
}

export async function emitToGroup(groupId: number, event: string, payload: unknown, exceptUserId?: number): Promise<void> {
  const ids = await getGroupMemberIds(groupId);
  emitToUsers(ids.filter((id) => id !== exceptUserId), event, payload);
}

type UserCheck = { ok: true } | { ok: false; status: number; error: string };
type Db = Prisma.TransactionClient | typeof prisma;

const UNABLE_TO_ADD: UserCheck = { ok: false, status: 400, error: 'Unable to add users' };

/** 첨부할 수 없는 fileIds(남의 파일, 없는 파일, 이미 붙은 파일). 라우트와 소켓이 400으로 바꾼다. */
export class InvalidFileIdsError extends Error {
  readonly code = 'INVALID_FILE_IDS';
  constructor() {
    super('Invalid file IDs or files already attached');
  }
}

/**
 * 그룹에 들어갈 사용자들을 검사한다.
 * - newUserIds: 모두 존재하고 활성이어야 한다.
 * - 게스트 격리: 최종 멤버(allMemberIds) 중 게스트가 있으면, 그 게스트는 나머지 모든 멤버와 채널을 하나 이상
 *   공유해야 한다. 행위자가 누구든 적용한다(멤버가 게스트를 모르는 사람과 묶을 수 없다). 게스트 행위자의
 *   기존 규칙(대상과 공유 채널 필요)도 행위자가 게스트 멤버이므로 여기에 포함된다.
 */
export async function validateGroupUsers(newUserIds: number[], allMemberIds: number[], db: Db = prisma): Promise<UserCheck> {
  if (newUserIds.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: newUserIds }, deactivatedAt: null },
      select: { id: true },
    });
    if (users.length !== newUserIds.length) return UNABLE_TO_ADD;
  }

  const memberIds = [...new Set(allMemberIds)];
  const guests = await db.user.findMany({
    where: { id: { in: memberIds }, role: 'GUEST' },
    select: { id: true },
  });
  if (guests.length === 0) return { ok: true };

  const guestIds = guests.map((g) => g.id);
  const pairs = await db.$queryRaw<Array<{ guestId: number; otherId: number }>>`
    SELECT DISTINCT cm1."userId" AS "guestId", cm2."userId" AS "otherId"
    FROM "ChannelMember" cm1
    JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId" AND cm2."userId" <> cm1."userId"
    WHERE cm1."userId" = ANY(${guestIds}) AND cm2."userId" = ANY(${memberIds})
  `;
  for (const guestId of guestIds) {
    const shared = new Set(pairs.filter((p) => p.guestId === guestId).map((p) => p.otherId));
    if (shared.size !== memberIds.length - 1) return UNABLE_TO_ADD;
  }
  return { ok: true };
}

export interface GroupView {
  id: number;
  name: string | null;
  createdBy: number;
  createdAt: Date;
  members: { id: number; name: string; avatar: string | null; status: string | null }[];
}

const GROUP_VIEW_INCLUDE = {
  members: { orderBy: { joinedAt: 'asc' as const }, include: { user: { select: GROUP_MEMBER_SELECT } } },
};
type GroupWithMembers = Prisma.DMGroupGetPayload<{ include: typeof GROUP_VIEW_INCLUDE }>;

function toGroupView(group: GroupWithMembers): GroupView {
  return {
    id: group.id,
    name: group.name,
    createdBy: group.createdBy,
    createdAt: group.createdAt,
    members: group.members.map((m) => ({
      ...m.user,
      status: isUserOnline(m.user.id) ? 'online' : 'offline',
    })),
  };
}

export async function getGroupView(groupId: number): Promise<GroupView | null> {
  const group = await prisma.dMGroup.findUnique({ where: { id: groupId }, include: GROUP_VIEW_INCLUDE });
  return group ? toGroupView(group) : null;
}

/**
 * 같은 멤버 집합의 그룹이 있으면 그대로 돌려주고, 없으면 만든다.
 * 동시에 같은 집합으로 두 번 만들면 memberKey unique가 하나만 남기고, 진 쪽은 이긴 쪽 그룹을 돌려준다.
 */
export async function findOrCreateGroup(creatorId: number, otherIds: number[]): Promise<{ groupId: number; created: boolean }> {
  const allIds = [...new Set([creatorId, ...otherIds])];
  const memberKey = memberKeyFor(allIds);
  const existing = await prisma.dMGroup.findUnique({ where: { memberKey }, select: { id: true } });
  if (existing) return { groupId: existing.id, created: false };

  try {
    const group = await prisma.dMGroup.create({
      data: {
        memberKey,
        createdBy: creatorId,
        members: { create: allIds.map((userId) => ({ userId })) },
      },
      select: { id: true },
    });
    return { groupId: group.id, created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.dMGroup.findUnique({ where: { memberKey }, select: { id: true } });
      if (winner) return { groupId: winner.id, created: false };
    }
    throw err;
  }
}

/** 멤버 변경을 직렬화한다: 그룹 행을 잠근 뒤 멤버를 다시 읽는다(동시 추가로 9명 상한을 넘지 않게). */
async function lockGroup(tx: Prisma.TransactionClient, groupId: number): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "DMGroup" WHERE id = ${groupId} FOR UPDATE`;
}

/**
 * 멤버가 바뀐 뒤 memberKey를 현재 멤버로 맞춘다. 먼저 원래 키로 써 보고, 다른 그룹이 그 키를 쓰고 있어
 * unique 위반이면 '#<id>'를 붙여 재사용 대상에서 뺀다. 매번 원래 키부터 시도하므로 충돌이 풀리면 원래 키로 돌아간다.
 * 트랜잭션 안의 실패한 문장은 트랜잭션 전체를 깨므로 SAVEPOINT로 그 한 문장만 되돌린다.
 */
async function refreshMemberKey(tx: Prisma.TransactionClient, groupId: number): Promise<void> {
  const rows = await tx.dMGroupMember.findMany({ where: { groupId }, select: { userId: true } });
  const key = memberKeyFor(rows.map((r) => r.userId));
  await tx.$executeRaw`SAVEPOINT member_key`;
  try {
    await tx.dMGroup.update({ where: { id: groupId }, data: { memberKey: key } });
    await tx.$executeRaw`RELEASE SAVEPOINT member_key`;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT member_key`;
    await tx.dMGroup.update({ where: { id: groupId }, data: { memberKey: `${key}#${groupId}` } });
  }
}

export type MemberChangeResult = { ok: true; addedIds: number[] } | { ok: false; status: number; error: string };

/**
 * 멤버 추가. 정책: 기존 기록은 새 멤버에게도 보인다. 새 멤버의 읽음 커서는 지금 마지막 메시지로 둬서
 * 이전 기록 전체가 안 읽음으로 쌓이지 않게 한다. 이미 멤버인 사람은 건너뛴다.
 * 그룹 행을 잠근 트랜잭션 안에서 멤버 수·사용자·게스트 격리를 검사하고 추가와 memberKey 갱신까지 끝낸다.
 */
export async function addGroupMembers(groupId: number, actorId: number, userIds: number[]): Promise<MemberChangeResult> {
  const result = await prisma.$transaction(async (tx): Promise<MemberChangeResult> => {
    await lockGroup(tx, groupId);
    const current = (await tx.dMGroupMember.findMany({ where: { groupId }, select: { userId: true } })).map((r) => r.userId);
    const newIds = [...new Set(userIds)].filter((id) => !current.includes(id));
    if (newIds.length === 0) return { ok: true, addedIds: [] };
    if (current.length + newIds.length > MAX_GROUP_SIZE) {
      return { ok: false, status: 400, error: `A group conversation can have at most ${MAX_GROUP_SIZE} members` };
    }
    const check = await validateGroupUsers(newIds, [...current, ...newIds], tx);
    if (!check.ok) return check;

    const last = await tx.directMessage.findFirst({
      where: { groupId, threadId: null },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    await tx.dMGroupMember.createMany({
      data: newIds.map((userId) => ({ groupId, userId, lastReadDmId: last?.id ?? null })),
      skipDuplicates: true,
    });
    await refreshMemberKey(tx, groupId);
    return { ok: true, addedIds: newIds };
  });
  if (!result.ok || result.addedIds.length === 0) return result;

  const view = await getGroupView(groupId);
  if (view) emitToUsers(view.members.map((m) => m.id), 'dmgroup:member:added', { groupId, userIds: result.addedIds, actorId, group: view });
  return result;
}

/**
 * 나가기. 정책: 남은 사람이 2명 이하여도 그룹은 지우지 않는다(기록 보존, 남은 사람은 계속 볼 수 있다).
 * 나간 사람은 더 이상 조회·전송할 수 없고, 그 그룹의 내 활동은 visibleActivityWhere에서 빠진다.
 */
export async function leaveGroup(groupId: number, userId: number): Promise<void> {
  const before = await prisma.$transaction(async (tx) => {
    await lockGroup(tx, groupId);
    const rows = await tx.dMGroupMember.findMany({ where: { groupId }, select: { userId: true } });
    await tx.dMGroupMember.deleteMany({ where: { groupId, userId } });
    await refreshMemberKey(tx, groupId);
    return rows.map((r) => r.userId);
  });
  emitToUsers(before, 'dmgroup:member:removed', { groupId, userId });
}

export interface GroupMessageInput {
  groupId: number;
  fromUserId: number;
  content: string;
  fileIds?: number[];
  threadId?: number | null;
}

/**
 * 그룹 메시지(또는 스레드 답글) 전송의 단일 경로. 커밋 뒤 멤버 전원에게 dm:new(답글은 dm:reply)를 보내고,
 * 오프라인 멤버에게 푸시한다. 보낸 사람의 읽음 커서는 자기 메시지까지 옮긴다.
 * 활동(멘션·스레드)도 여기서 만든다(await하지 않는다). 호출자는 따로 createActivitiesForDm을 부르지 않는다.
 */
export async function sendGroupMessage(input: GroupMessageInput) {
  const { groupId, fromUserId, content, fileIds, threadId } = input;
  const dlpWarned = await enforceDlp(fromUserId, content, 'direct_message');

  const dm = await prisma.$transaction(async (tx) => {
    const created = await tx.directMessage.create({
      data: { content, fromUserId, groupId, ...(threadId && { threadId }) },
    });

    if (fileIds && fileIds.length > 0) {
      const updated = await tx.file.updateMany({
        where: attachableFiles(fromUserId, fileIds),
        data: { dmId: created.id },
      });
      if (updated.count !== fileIds.length) throw new InvalidFileIdsError();
    }

    if (!threadId) {
      await tx.dMGroupMember.update({
        where: { groupId_userId: { groupId, userId: fromUserId } },
        data: { lastReadDmId: created.id },
      });
    }

    return tx.directMessage.findUniqueOrThrow({
      where: { id: created.id },
      include: DM_INCLUDE_USERS,
    });
  });

  recordDlpWarnings(fromUserId, 'direct_message', dm.id, dlpWarned);

  const memberIds = await getGroupMemberIds(groupId);
  emitToUsers(memberIds, threadId ? 'dm:reply' : 'dm:new', dm);

  // 스레드 답글은 부모 작성자와 스레드 참여자에게만 푸시한다(THREAD_REPLY 활동과 같은 기준)
  let pushTargets = memberIds;
  if (threadId) {
    const participants = await prisma.directMessage.findMany({
      where: { OR: [{ id: threadId }, { threadId }], deletedAt: null },
      select: { fromUserId: true },
      distinct: ['fromUserId'],
    });
    const participantIds = new Set(participants.map((p) => p.fromUserId));
    pushTargets = memberIds.filter((id) => participantIds.has(id));
  }

  const senderName = dm.fromUser?.name;
  for (const userId of pushTargets) {
    if (userId === fromUserId || isUserOnline(userId)) continue;
    sendPushToUser(
      userId,
      {
        titleKey: threadId ? 'dmThread' : 'dmTitle', sender: senderName, content: dm.content, plainBody: true,
        url: `/g/${groupId}`,
      },
      { kind: 'dm' },
    ).catch((err) => logError('Push notification dispatch failed', err));
  }

  // 푸시까지 보낸 뒤 활동 생성(await하지 않는다)
  void createActivitiesForDm(dm);
  return dm;
}

/** 읽음 커서를 앞으로만 옮긴다. upToDmId가 없으면 그룹의 마지막 최상위 메시지까지. */
export async function markGroupRead(groupId: number, userId: number, upToDmId?: number): Promise<number | null> {
  let target = upToDmId;
  if (!target) {
    const last = await prisma.directMessage.findFirst({
      where: { groupId, threadId: null },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    target = last?.id;
  }
  if (!target) return null;
  await prisma.dMGroupMember.updateMany({
    where: { groupId, userId, OR: [{ lastReadDmId: null }, { lastReadDmId: { lt: target } }] },
    data: { lastReadDmId: target },
  });
  return target;
}

/**
 * 안 읽음 구분선용 읽음 기준점: 내 읽음 커서(lastReadDmId)와 그 이후 최상위 메시지 수(내 것 포함, 채널 응답과 같은 규칙).
 * 읽음 처리(markGroupRead)보다 먼저 불러야 열기 직전 값이다.
 */
export async function getGroupUnreadBaseline(groupId: number, userId: number): Promise<{ lastReadId: number | null; unreadCount: number }> {
  const member = await prisma.dMGroupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { lastReadDmId: true },
  });
  const lastReadId = member?.lastReadDmId ?? null;
  const unreadCount = await prisma.directMessage.count({
    where: { groupId, threadId: null, deletedAt: null, ...(lastReadId !== null && { id: { gt: lastReadId } }) },
  });
  return { lastReadId, unreadCount };
}

export interface GroupConversation {
  type: 'group';
  group: GroupView;
  lastMessage: { id: number; content: string; fromUserId: number; createdAt: Date } | null;
  unreadCount: number;
  isStarred: boolean;
}

/** 사이드바용: 내가 멤버인 그룹 목록과 마지막 메시지, 안 읽은 수(내가 보낸 것 제외), 별표. */
export async function listGroupConversations(userId: number): Promise<GroupConversation[]> {
  const memberships = await prisma.dMGroupMember.findMany({
    where: { userId },
    select: { groupId: true, lastReadDmId: true, starredAt: true },
  });
  if (memberships.length === 0) return [];
  const groupIds = memberships.map((m) => m.groupId);

  const [groups, lastMessages, unreadRows] = await Promise.all([
    prisma.dMGroup.findMany({ where: { id: { in: groupIds } }, include: GROUP_VIEW_INCLUDE }),
    prisma.$queryRaw<Array<{ id: number; content: string; fromUserId: number; createdAt: Date; groupId: number }>>`
      SELECT DISTINCT ON (dm."groupId") dm.id, dm.content, dm."fromUserId", dm."createdAt", dm."groupId"
      FROM "DirectMessage" dm
      WHERE dm."groupId" = ANY(${groupIds}) AND dm."deletedAt" IS NULL AND dm."threadId" IS NULL
      ORDER BY dm."groupId", dm.id DESC
    `,
    prisma.$queryRaw<Array<{ groupId: number; unreadCount: number }>>`
      SELECT dm."groupId", COUNT(*)::int AS "unreadCount"
      FROM "DirectMessage" dm
      JOIN "DMGroupMember" gm ON gm."groupId" = dm."groupId" AND gm."userId" = ${userId}
      WHERE dm."groupId" = ANY(${groupIds})
        AND dm."deletedAt" IS NULL
        AND dm."threadId" IS NULL
        AND dm."fromUserId" <> ${userId}
        AND (gm."lastReadDmId" IS NULL OR dm.id > gm."lastReadDmId")
      GROUP BY dm."groupId"
    `,
  ]);

  const lastByGroup = new Map(lastMessages.map((m) => [m.groupId, m]));
  const unreadByGroup = new Map(unreadRows.map((r) => [r.groupId, Number(r.unreadCount)]));
  const memberByGroup = new Map(memberships.map((m) => [m.groupId, m]));

  const result: GroupConversation[] = groups.map((g) => {
    const last = lastByGroup.get(g.id);
    return {
      type: 'group',
      group: toGroupView(g),
      lastMessage: last ? { id: last.id, content: last.content, fromUserId: last.fromUserId, createdAt: last.createdAt } : null,
      unreadCount: unreadByGroup.get(g.id) ?? 0,
      isStarred: !!memberByGroup.get(g.id)?.starredAt,
    };
  });
  const sortKey = (c: GroupConversation) => (c.lastMessage?.createdAt ?? c.group.createdAt).getTime();
  return result.sort((a, b) => sortKey(b) - sortKey(a));
}

export interface GroupConversationSummary {
  groupId: number;
  name: string | null;
  members: { id: number; name: string }[];
  lastMessage: { id: number; content: string; fromUserId: number; createdAt: Date } | null;
  unreadCount: number;
}

/**
 * 도구·API용 가벼운 그룹 대화 목록. listGroupConversations와 같은 순서(마지막 메시지 시각, 없으면 생성 시각)이지만
 * limit을 SQL 단계에서 적용하고, 별표와 접속 상태를 읽지 않으며, 멤버는 id와 이름만 가져온다.
 */
export async function listGroupConversationSummaries(userId: number, limit: number): Promise<GroupConversationSummary[]> {
  const rows = await prisma.$queryRaw<Array<{
    groupId: number; lastId: number | null; lastContent: string | null; lastFrom: number | null; lastAt: Date | null; unreadCount: number;
  }>>`
    SELECT g.id AS "groupId", last.id AS "lastId", last.content AS "lastContent", last."fromUserId" AS "lastFrom", last."createdAt" AS "lastAt",
      (SELECT COUNT(*)::int FROM "DirectMessage" d
        WHERE d."groupId" = g.id AND d."deletedAt" IS NULL AND d."threadId" IS NULL AND d."fromUserId" <> ${userId}
          AND (gm."lastReadDmId" IS NULL OR d.id > gm."lastReadDmId")) AS "unreadCount"
    FROM "DMGroupMember" gm
    JOIN "DMGroup" g ON g.id = gm."groupId"
    LEFT JOIN LATERAL (
      SELECT dm.id, dm.content, dm."fromUserId", dm."createdAt" FROM "DirectMessage" dm
      WHERE dm."groupId" = g.id AND dm."deletedAt" IS NULL AND dm."threadId" IS NULL
      ORDER BY dm.id DESC LIMIT 1
    ) last ON true
    WHERE gm."userId" = ${userId}
    ORDER BY COALESCE(last."createdAt", g."createdAt") DESC, g.id DESC
    LIMIT ${limit}
  `;
  if (rows.length === 0) return [];
  const groups = await prisma.dMGroup.findMany({
    where: { id: { in: rows.map((r) => r.groupId) } },
    select: { id: true, name: true, members: { orderBy: { joinedAt: 'asc' }, select: { user: { select: { id: true, name: true } } } } },
  });
  const byId = new Map(groups.map((g) => [g.id, g]));
  return rows.flatMap((r) => {
    const g = byId.get(r.groupId);
    if (!g) return [];
    return [{
      groupId: g.id,
      name: g.name,
      members: g.members.map((m) => m.user),
      lastMessage: r.lastId === null ? null : { id: r.lastId, content: r.lastContent!, fromUserId: r.lastFrom!, createdAt: r.lastAt! },
      unreadCount: Number(r.unreadCount),
    }];
  });
}
