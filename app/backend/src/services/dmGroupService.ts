import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { getIO, isUserOnline } from '../websocket/index.js';
import { DM_INCLUDE_USERS } from '../db/selects.js';
import { logError } from '../utils/logger.js';
import { sendPushToUser } from './pushService.js';

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

export async function isGroupMember(groupId: number, userId: number): Promise<boolean> {
  const row = await prisma.dMGroupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { userId: true },
  });
  return !!row;
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

/**
 * 그룹에 넣을 사용자들을 검사한다: 모두 존재하고 활성이어야 한다.
 * 게스트가 만들거나 추가하면 대상 모두가 게스트와 채널을 하나 이상 공유해야 한다(1:1 DM 규칙과 같다).
 */
export async function validateGroupUsers(actor: { userId: number; role?: string }, userIds: number[]): Promise<UserCheck> {
  if (userIds.length === 0) return { ok: true };
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, deactivatedAt: null },
    select: { id: true },
  });
  if (users.length !== userIds.length) return { ok: false, status: 400, error: 'Unable to add users' };

  if (actor.role === 'GUEST') {
    const shared = await prisma.$queryRaw<Array<{ userId: number }>>`
      SELECT DISTINCT cm2."userId"
      FROM "ChannelMember" cm1
      JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId"
      WHERE cm1."userId" = ${actor.userId} AND cm2."userId" = ANY(${userIds})
    `;
    if (shared.length !== userIds.length) return { ok: false, status: 400, error: 'Unable to add users' };
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

export async function getGroupView(groupId: number): Promise<GroupView | null> {
  const group = await prisma.dMGroup.findUnique({
    where: { id: groupId },
    include: { members: { orderBy: { joinedAt: 'asc' }, include: { user: { select: GROUP_MEMBER_SELECT } } } },
  });
  if (!group) return null;
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

/**
 * 멤버가 바뀐 뒤 memberKey를 현재 멤버로 맞춘다. 다른 그룹이 이미 그 키를 쓰면 '#<id>'를 붙여
 * 재사용 대상에서 뺀다(같은 멤버 집합으로 새로 만들면 기존 그룹이 나온다).
 */
async function refreshMemberKey(tx: Prisma.TransactionClient, groupId: number): Promise<void> {
  const rows = await tx.dMGroupMember.findMany({ where: { groupId }, select: { userId: true } });
  const key = memberKeyFor(rows.map((r) => r.userId));
  const clash = await tx.dMGroup.findFirst({ where: { memberKey: key, id: { not: groupId } }, select: { id: true } });
  await tx.dMGroup.update({ where: { id: groupId }, data: { memberKey: clash ? `${key}#${groupId}` : key } });
}

export type MemberChangeResult = { ok: true; addedIds: number[] } | { ok: false; status: number; error: string };

/**
 * 멤버 추가. 정책: 기존 기록은 새 멤버에게도 보인다. 새 멤버의 읽음 커서는 지금 마지막 메시지로 둬서
 * 이전 기록 전체가 안 읽음으로 쌓이지 않게 한다. 이미 멤버인 사람은 건너뛴다.
 */
export async function addGroupMembers(groupId: number, actorId: number, userIds: number[]): Promise<MemberChangeResult> {
  const current = await getGroupMemberIds(groupId);
  const newIds = [...new Set(userIds)].filter((id) => !current.includes(id));
  if (newIds.length === 0) return { ok: true, addedIds: [] };
  if (current.length + newIds.length > MAX_GROUP_SIZE) {
    return { ok: false, status: 400, error: `A group conversation can have at most ${MAX_GROUP_SIZE} members` };
  }

  const last = await prisma.directMessage.findFirst({
    where: { groupId, threadId: null },
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.dMGroupMember.createMany({
      data: newIds.map((userId) => ({ groupId, userId, lastReadDmId: last?.id ?? null })),
      skipDuplicates: true,
    });
    await refreshMemberKey(tx, groupId);
  });

  const view = await getGroupView(groupId);
  const allIds = view ? view.members.map((m) => m.id) : [...current, ...newIds];
  emitToUsers(allIds, 'dmgroup:member:added', { groupId, userIds: newIds, actorId, group: view });
  return { ok: true, addedIds: newIds };
}

/**
 * 나가기. 정책: 남은 사람이 2명 이하여도 그룹은 지우지 않는다(기록 보존, 남은 사람은 계속 볼 수 있다).
 * 나간 사람은 더 이상 조회·전송할 수 없고, 그 그룹의 내 활동은 visibleActivityWhere에서 빠진다.
 */
export async function leaveGroup(groupId: number, userId: number): Promise<void> {
  const before = await getGroupMemberIds(groupId);
  await prisma.$transaction(async (tx) => {
    await tx.dMGroupMember.delete({ where: { groupId_userId: { groupId, userId } } });
    await refreshMemberKey(tx, groupId);
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
 * 활동(멘션·스레드)은 호출자가 응답 뒤에 createActivitiesForDm으로 만든다(1:1 경로와 같은 순서).
 */
export async function sendGroupMessage(input: GroupMessageInput) {
  const { groupId, fromUserId, content, fileIds, threadId } = input;

  const dm = await prisma.$transaction(async (tx) => {
    const created = await tx.directMessage.create({
      data: { content, fromUserId, groupId, ...(threadId && { threadId }) },
    });

    if (fileIds && fileIds.length > 0) {
      const updated = await tx.file.updateMany({
        where: { id: { in: fileIds }, userId: fromUserId, messageId: null, dmId: null },
        data: { dmId: created.id },
      });
      if (updated.count !== fileIds.length) {
        throw new Error('Invalid file IDs or files already attached');
      }
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

  const memberIds = await getGroupMemberIds(groupId);
  emitToUsers(memberIds, threadId ? 'dm:reply' : 'dm:new', dm);

  const senderName = dm.fromUser?.name || 'Someone';
  for (const userId of memberIds) {
    if (userId === fromUserId || isUserOnline(userId)) continue;
    sendPushToUser(
      userId,
      {
        title: threadId ? `${senderName} (thread)` : senderName,
        body: dm.content.slice(0, 100) || 'Sent an attachment',
        url: `/g/${groupId}`,
      },
      { kind: 'dm' },
    ).catch((err) => logError('Push notification dispatch failed', err));
  }

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
    prisma.dMGroup.findMany({
      where: { id: { in: groupIds } },
      include: { members: { orderBy: { joinedAt: 'asc' }, include: { user: { select: GROUP_MEMBER_SELECT } } } },
    }),
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
      group: {
        id: g.id,
        name: g.name,
        createdBy: g.createdBy,
        createdAt: g.createdAt,
        members: g.members.map((m) => ({ ...m.user, status: isUserOnline(m.user.id) ? 'online' : 'offline' })),
      },
      lastMessage: last ? { id: last.id, content: last.content, fromUserId: last.fromUserId, createdAt: last.createdAt } : null,
      unreadCount: unreadByGroup.get(g.id) ?? 0,
      isStarred: !!memberByGroup.get(g.id)?.starredAt,
    };
  });
  const sortKey = (c: GroupConversation) => (c.lastMessage?.createdAt ?? c.group.createdAt).getTime();
  return result.sort((a, b) => sortKey(b) - sortKey(a));
}
