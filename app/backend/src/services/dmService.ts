import type { DirectMessage } from '@prisma/client';
import prisma from '../db.js';
import { DM_INCLUDE_USERS } from '../db/selects.js';
import { checkDmGroupMembership } from '../middleware/authorize.js';
import { getIO, isUserOnline } from '../websocket/index.js';
import { logError } from '../utils/logger.js';
import { ServiceError } from './messageService.js';
import { InvalidFileIdsError, emitToGroup } from './dmGroupService.js';
import { sendPushToUser } from './pushService.js';
import { toPublicUser } from './statusService.js';
import {
  createActivitiesForDm,
  syncActivitiesOnDmEdit,
  deleteActivitiesForDm,
  getMentionCountsByDmPartner,
} from './mentionService.js';

// 1:1 DM 쓰기(전송, 수정, 삭제)와 대화 목록의 공용 서비스. REST(routes/dms.ts), 소켓(dm:send), MCP 도구가 함께 쓴다.
// 그룹 DM 전송은 dmGroupService.sendGroupMessage를 그대로 쓴다. 호출하는 쪽이 "이 사용자가 이 그룹의 멤버인가"를
// 먼저 확인하고, 여기서는 1:1 전송 규칙(받는 사람 존재·활성, 게스트는 채널 공유 상대만)과 작성자만 수정·삭제,
// 소켓 이벤트·멘션 활동·푸시를 한 곳에서 처리한다.

export const UNABLE_TO_SEND = 'Unable to send message';

export interface DmSender {
  userId: number;
  role: string | undefined;
}

/** 두 사용자가 채널을 하나라도 같이 쓰는가(게스트 격리 기준) */
export async function sharesChannel(userId: number, otherUserId: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT cm1."channelId" AS id
    FROM "ChannelMember" cm1
    JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId"
    WHERE cm1."userId" = ${userId} AND cm2."userId" = ${otherUserId}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** 받는 사람이 없거나 비활성이면, 보내는 사람이 게스트인데 채널을 공유하지 않으면 보낼 수 없다. 자기 자신에게는 보낼 수 있다. */
export async function canSendDm(sender: DmSender, toUserId: number): Promise<boolean> {
  if (sender.userId === toUserId) return true;
  const recipient = await prisma.user.findUnique({ where: { id: toUserId }, select: { id: true, deactivatedAt: true } });
  if (!recipient || recipient.deactivatedAt) return false;
  if (sender.role === 'GUEST' && !(await sharesChannel(sender.userId, toUserId))) return false;
  return true;
}

export interface SendDirectMessageInput {
  content: string;
  fileIds?: number[];
}

/**
 * 1:1 DM 전송의 단일 경로. 규칙 위반은 ServiceError(400), 첨부할 수 없는 fileIds는 InvalidFileIdsError.
 * 커밋 뒤 보낸 사람과 받는 사람의 개인 room에 dm:new를 보내고, 받는 사람이 오프라인이면 푸시하며,
 * 응답과 별개로 멘션 활동을 만든다(await하지 않는다).
 */
export async function sendDirectMessage(sender: DmSender, toUserId: number, input: SendDirectMessageInput) {
  const fromUserId = sender.userId;
  if (!(await canSendDm(sender, toUserId))) throw new ServiceError(400, UNABLE_TO_SEND);
  const { content, fileIds } = input;

  const dm = await prisma.$transaction(async (tx) => {
    const created = await tx.directMessage.create({
      data: {
        content,
        fromUserId,
        toUserId,
        // Self-DMs are auto-read (no notifications for yourself)
        ...(fromUserId === toUserId && { readAt: new Date() }),
      },
    });

    if (fileIds && fileIds.length > 0) {
      const updated = await tx.file.updateMany({
        where: { id: { in: fileIds }, userId: fromUserId, messageId: null, dmId: null },
        data: { dmId: created.id },
      });
      if (updated.count !== fileIds.length) throw new InvalidFileIdsError();
    }

    return tx.directMessage.findUniqueOrThrow({ where: { id: created.id }, include: DM_INCLUDE_USERS });
  });

  // Broadcast via WebSocket so the recipient sees the DM in real-time
  const io = getIO();
  if (io) {
    io.to(`user:${fromUserId}`).emit('dm:new', dm);
    if (fromUserId !== toUserId) io.to(`user:${toUserId}`).emit('dm:new', dm);
  }
  if (fromUserId !== toUserId && !isUserOnline(toUserId)) {
    // Push notification (fire-and-forget)
    sendPushToUser(toUserId, {
      titleKey: 'dmTitle', sender: dm.fromUser?.name || 'Someone', content: dm.content, plainBody: true,
      url: `/d/${fromUserId}`,
    }, { kind: 'dm' }).catch((err) => logError('Push notification dispatch failed', err));
  }

  // dm:new 뒤에 활동 생성(await하지 않는다)
  void createActivitiesForDm(dm);
  return dm;
}

/** 수정·삭제 공통 규칙: 지워진 메시지는 없는 것, 작성자만, 그룹 DM은 현재 멤버만 */
async function assertCanModifyDm(userId: number, dm: DirectMessage): Promise<void> {
  if (dm.deletedAt !== null) throw new ServiceError(404, 'Message not found');
  if (dm.fromUserId !== userId) throw new ServiceError(403, 'You can only modify your own messages');
  // 그룹을 나간 뒤에는 자기 메시지도 고치거나 지울 수 없다
  if (dm.groupId !== null && !(await checkDmGroupMembership(userId, dm.groupId))) throw new ServiceError(403, 'Access denied');
}

/** DM 참여자 전원(보낸 사람 포함, 나와의 대화는 한 번)의 user 룸으로 이벤트를 보낸다 */
async function emitToParticipants(dm: { fromUserId: number; toUserId: number | null; groupId: number | null }, event: string, payload: unknown) {
  if (dm.groupId !== null) {
    await emitToGroup(dm.groupId, event, payload);
    return;
  }
  const ids = new Set([dm.fromUserId, ...(dm.toUserId !== null ? [dm.toUserId] : [])]);
  getIO()?.to([...ids].map((id) => `user:${id}`)).emit(event, payload);
}

/** 내 DM(1:1 또는 그룹) 수정. 참여자 전원(보낸 사람의 다른 탭 포함)에게 dm:updated를 보낸다. */
export async function editDirectMessage(userId: number, dm: DirectMessage, content: string) {
  await assertCanModifyDm(userId, dm);
  const updated = await prisma.directMessage.update({
    where: { id: dm.id },
    data: { content, editedAt: new Date() },
    include: { ...DM_INCLUDE_USERS },
  });

  // 보낸 사람의 다른 탭·기기도 갱신되도록 보낸 사람 본인의 user 룸에도 보낸다(클라이언트는 id로 교체하므로 중복 적용해도 같다)
  await emitToParticipants(updated, 'dm:updated', updated);
  void syncActivitiesOnDmEdit(updated);
  return updated;
}

/** 내 DM(1:1 또는 그룹) 삭제(소프트). 참여자 전원(보낸 사람의 다른 탭 포함)에게 dm:deleted를 보낸다. */
export async function deleteDirectMessage(userId: number, dm: DirectMessage): Promise<void> {
  await assertCanModifyDm(userId, dm);
  await prisma.directMessage.update({ where: { id: dm.id }, data: { deletedAt: new Date() } });
  void deleteActivitiesForDm(dm.id);

  // 그룹과 1:1 모두 같은 모양({ dmId, fromUserId, toUserId, groupId, threadId }). 보낸 사람 본인의 user 룸에도 보낸다.
  await emitToParticipants(dm, 'dm:deleted', {
    dmId: dm.id,
    fromUserId: dm.fromUserId,
    toUserId: dm.groupId !== null ? null : dm.toUserId,
    groupId: dm.groupId,
    threadId: dm.threadId,
  });
}

// 원시 SQL(jsonb)로 읽은 상태 컬럼은 UTC ISO 문자열이다. Date로 되돌려 공개용 뷰로 바꾼다.
function withPublicStatus<T extends Record<string, any>>(user: T) {
  return toPublicUser({
    ...user,
    customStatusEmoji: user.customStatusEmoji ?? null,
    customStatusText: user.customStatusText ?? null,
    customStatusExpiresAt: user.customStatusExpiresAt ? new Date(user.customStatusExpiresAt) : null,
    dndUntil: user.dndUntil ? new Date(user.dndUntil) : null,
    dndWithStatus: user.dndWithStatus === true,
  });
}

/** 사이드바용 1:1 대화 목록(GET /dms와 같은 결과). 게스트는 채널을 공유하는 상대만 보인다. 읽음 처리는 하지 않는다. */
export async function listDirectConversations(userId: number, role: string | undefined) {
  // Single query: get all conversations with last message and unread count
  const conversations: any[] = await prisma.$queryRaw`
    WITH conversation_partners AS (
      SELECT DISTINCT
        CASE WHEN "fromUserId" = ${userId} THEN "toUserId" ELSE "fromUserId" END AS "otherUserId"
      FROM "DirectMessage"
      WHERE ("fromUserId" = ${userId} OR "toUserId" = ${userId})
        AND "groupId" IS NULL
        AND "deletedAt" IS NULL
    ),
    last_messages AS (
      SELECT DISTINCT ON (other_id)
        dm.id,
        dm.content,
        dm."fromUserId",
        dm."toUserId",
        dm."createdAt",
        dm."updatedAt",
        dm."editedAt",
        dm."deletedAt",
        dm."readAt",
        CASE WHEN dm."fromUserId" = ${userId} THEN dm."toUserId" ELSE dm."fromUserId" END AS other_id
      FROM "DirectMessage" dm
      WHERE (dm."fromUserId" = ${userId} OR dm."toUserId" = ${userId})
        AND dm."groupId" IS NULL
        AND dm."deletedAt" IS NULL
      ORDER BY other_id, dm."createdAt" DESC
    ),
    unread_counts AS (
      SELECT "fromUserId" AS "otherUserId", COUNT(*)::int AS "unreadCount"
      FROM "DirectMessage"
      WHERE "toUserId" = ${userId}
        AND "deletedAt" IS NULL
        AND "readAt" IS NULL
      GROUP BY "fromUserId"
    )
    SELECT
      jsonb_build_object(
        'id', u.id, 'name', u.name, 'avatar', u.avatar, 'status', u.status,
        -- 컬럼은 UTC 기준 timestamp라 서버·세션 시간대와 무관하게 UTC ISO로 내보낸다
        'customStatusEmoji', u."customStatusEmoji", 'customStatusText', u."customStatusText",
        'customStatusExpiresAt', to_char(u."customStatusExpiresAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'dndUntil', to_char(u."dndUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'dndWithStatus', u."dndWithStatus"
      ) AS "otherUser",
      jsonb_build_object(
        'id', lm.id, 'content', lm.content, 'fromUserId', lm."fromUserId",
        'toUserId', lm."toUserId", 'createdAt', lm."createdAt",
        'updatedAt', lm."updatedAt", 'editedAt', lm."editedAt",
        'deletedAt', lm."deletedAt", 'readAt', lm."readAt"
      ) AS "lastMessage",
      COALESCE(uc."unreadCount", 0) AS "unreadCount"
    FROM conversation_partners cp
    JOIN "User" u ON u.id = cp."otherUserId"
    LEFT JOIN last_messages lm ON lm.other_id = cp."otherUserId"
    LEFT JOIN unread_counts uc ON uc."otherUserId" = cp."otherUserId"
    ORDER BY lm."createdAt" DESC NULLS LAST
  `;

  // Guests: filter conversations to only shared-channel members
  let filteredConversations = conversations;
  if (role === 'GUEST') {
    const sharedMembers = await prisma.$queryRaw<Array<{ userId: number }>>`
      SELECT DISTINCT cm2."userId"
      FROM "ChannelMember" cm1
      JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId" AND cm2."userId" != cm1."userId"
      WHERE cm1."userId" = ${userId}
    `;
    const sharedIds = new Set(sharedMembers.map(m => m.userId));
    filteredConversations = conversations.filter(
      (conv: any) => conv.otherUser && sharedIds.has(conv.otherUser.id)
    );
  }

  const [mentionCounts, stars] = await Promise.all([
    getMentionCountsByDmPartner(userId),
    prisma.dMStar.findMany({ where: { userId }, select: { otherUserId: true } }),
  ]);
  const starredIds = new Set(stars.map(st => st.otherUserId));

  // Apply online status from WebSocket tracking
  const result = filteredConversations.map((conv) => ({
    otherUser: conv.otherUser ? withPublicStatus({
      ...conv.otherUser,
      status: isUserOnline(conv.otherUser.id) ? 'online' : 'offline',
    }) : conv.otherUser,
    lastMessage: conv.lastMessage,
    unreadCount: Number(conv.unreadCount),
    mentionCount: conv.otherUser ? mentionCounts.get(conv.otherUser.id) ?? 0 : 0,
    isStarred: conv.otherUser ? starredIds.has(conv.otherUser.id) : false,
  }));

  return result;
}

export interface DmConversationSummary {
  userId: number;
  name: string;
  lastMessage: { id: number; content: string; fromUserId: number; createdAt: Date };
  unreadCount: number;
}

/**
 * 도구·API용 가벼운 1:1 대화 목록. 사이드바용 listDirectConversations와 같은 대화 집합·순서이지만
 * 멘션 수, 별표, 접속 상태, 상태 메시지를 읽지 않고, 게스트 격리와 limit을 SQL 단계에서 적용한다.
 * 게스트에게는 listDirectConversations처럼 채널을 공유하는 상대만(자기 자신 제외) 보인다.
 */
export async function listDirectConversationSummaries(userId: number, role: string | undefined, limit: number): Promise<DmConversationSummary[]> {
  const isGuest = role === 'GUEST';
  const rows = await prisma.$queryRaw<Array<{
    userId: number; name: string; id: number; content: string; fromUserId: number; createdAt: Date; unreadCount: number;
  }>>`
    WITH last_messages AS (
      SELECT DISTINCT ON (other_id) dm.id, dm.content, dm."fromUserId", dm."createdAt",
        CASE WHEN dm."fromUserId" = ${userId} THEN dm."toUserId" ELSE dm."fromUserId" END AS other_id
      FROM "DirectMessage" dm
      WHERE (dm."fromUserId" = ${userId} OR dm."toUserId" = ${userId})
        AND dm."groupId" IS NULL AND dm."deletedAt" IS NULL
      ORDER BY other_id, dm."createdAt" DESC, dm.id DESC
    )
    SELECT lm.other_id AS "userId", u.name, lm.id, lm.content, lm."fromUserId", lm."createdAt",
      COALESCE((
        SELECT COUNT(*)::int FROM "DirectMessage" d
        WHERE d."toUserId" = ${userId} AND d."fromUserId" = lm.other_id AND d."deletedAt" IS NULL AND d."readAt" IS NULL
      ), 0) AS "unreadCount"
    FROM last_messages lm
    JOIN "User" u ON u.id = lm.other_id
    WHERE (NOT ${isGuest} OR (lm.other_id <> ${userId} AND EXISTS (
      SELECT 1 FROM "ChannelMember" cm1
      JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId"
      WHERE cm1."userId" = ${userId} AND cm2."userId" = lm.other_id
    )))
    ORDER BY lm."createdAt" DESC, lm.id DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    lastMessage: { id: r.id, content: r.content, fromUserId: r.fromUserId, createdAt: r.createdAt },
    unreadCount: Number(r.unreadCount),
  }));
}
