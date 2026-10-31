import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { getIO } from '../websocket/index.js';
import { logError } from '../utils/logger.js';
import { trackBackground } from '../utils/keyedQueue.js';
import { USER_SELECT_BASIC, THREAD_REPLY_INCLUDE } from '../db/selects.js';

// 스레드 모아보기와 읽음 상태, "채널에도 보내기". 채널 스레드만 다룬다(그룹 DM·1:1 DM 스레드는 후속 범위).
// 답글을 만드는 모든 경로(HTTP 답글, 채널 메시지 POST, 소켓 message:send)가 onThreadReplyCreated를 호출한다.

/** 모아보기 카드 한 장에 인라인으로 보여 줄 최근 답글 수 */
const INLINE_REPLY_LIMIT = 20;
const EXCERPT_LENGTH = 100;

type ReplyLike = { id: number; userId: number; channelId: number; threadId: number | null };

function emitToUsers(userIds: number[], event: string, payload: unknown): void {
  const io = getIO();
  if (!io || userIds.length === 0) return;
  io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
}

/** 부모 발췌: 채널 타임라인의 "스레드에 답글" 머리글에 쓴다. */
export const PARENT_EXCERPT_SELECT = {
  id: true,
  content: true,
  deletedAt: true,
  user: { select: USER_SELECT_BASIC },
} as const;

export function toParentExcerpt<T extends { content: string; deletedAt: Date | null } | null | undefined>(parent: T) {
  if (!parent) return null;
  return { ...parent, content: parent.deletedAt ? '' : parent.content.slice(0, EXCERPT_LENGTH) };
}

/** 삭제된 부모(답글이 남아 자리표시자로 보이는 경우)는 내용·첨부·리액션을 비워 내려 보낸다. deletedAt은 그대로 둔다. */
export function blankIfDeleted<T extends { deletedAt: Date | null; content: string }>(msg: T): T {
  if (!msg.deletedAt) return msg;
  return { ...msg, content: '', ...('files' in msg && { files: [] }), ...('reactions' in msg && { reactions: [] }) };
}

/** 답글/타임라인 응답에 붙이는 부모 발췌 include와 직렬화 */
export const PARENT_EXCERPT_INCLUDE = { parent: { select: PARENT_EXCERPT_SELECT } } as const;

export function withParentExcerpt<T extends { parent?: { content: string; deletedAt: Date | null } | null }>(msg: T) {
  return { ...msg, parent: toParentExcerpt(msg.parent) };
}

/** 스레드 참여자: 부모 작성자 + 삭제되지 않은 답글 작성자 중 지금도 그 채널 멤버인 사람. */
export async function getThreadParticipantIds(parentId: number, channelId: number): Promise<number[]> {
  const rows = await prisma.message.findMany({
    where: { OR: [{ id: parentId }, { threadId: parentId }], deletedAt: null },
    select: { userId: true },
    distinct: ['userId'],
  });
  const ids = rows.map((r) => r.userId);
  if (ids.length === 0) return [];
  const members = await prisma.channelMember.findMany({
    where: { channelId, userId: { in: ids } },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

async function emitThreadUpdated(parentId: number, channelId: number, lastReplyId: number | null, actorId: number): Promise<void> {
  const [participants, replyCount] = await Promise.all([
    getThreadParticipantIds(parentId, channelId),
    prisma.message.count({ where: { threadId: parentId, deletedAt: null } }),
  ]);
  emitToUsers(participants, 'thread:updated', { parentId, channelId, lastReplyId, replyCount, actorId });
}

/** 답글이 만들어진 뒤: 작성자의 읽음 위치를 그 답글로 옮기고 참여자에게 thread:updated를 보낸다. 실패는 로그만 남긴다. */
export function onThreadReplyCreated(reply: ReplyLike): Promise<void> {
  return trackBackground(onThreadReplyCreatedImpl(reply));
}

async function onThreadReplyCreatedImpl(reply: ReplyLike): Promise<void> {
  if (!reply.threadId) return;
  try {
    await prisma.threadRead.upsert({
      where: { userId_threadId: { userId: reply.userId, threadId: reply.threadId } },
      create: { userId: reply.userId, threadId: reply.threadId, lastReadReplyId: reply.id },
      update: { lastReadReplyId: reply.id },
    });
    await emitThreadUpdated(reply.threadId, reply.channelId, reply.id, reply.userId);
  } catch (err) {
    logError('Thread reply post-process failed', err);
  }
}

/** 답글이 삭제된 뒤: 답글 수가 바뀌었으니 참여자에게 알린다. */
export function onThreadReplyDeleted(reply: ReplyLike): Promise<void> {
  return trackBackground(onThreadReplyDeletedImpl(reply));
}

async function onThreadReplyDeletedImpl(reply: ReplyLike): Promise<void> {
  if (!reply.threadId) return;
  try {
    const last = await prisma.message.findFirst({
      where: { threadId: reply.threadId, deletedAt: null },
      orderBy: { id: 'desc' },
      select: { id: true },
    });
    await emitThreadUpdated(reply.threadId, reply.channelId, last?.id ?? null, reply.userId);
  } catch (err) {
    logError('Thread reply delete post-process failed', err);
  }
}

// ── 목록 ────────────────────────────────────────────────────────────

/**
 * 내가 참여한(부모 작성자이거나 답글을 쓴) 스레드의 요약. 지금도 내가 멤버인 보관되지 않은 채널만.
 * 부모가 삭제돼도 살아 있는 답글이 있으면 남는다(부모는 자리표시자). 살아 있는 답글이 없으면 카드는 사라진다.
 * 정렬과 커서는 마지막 답글 id(id가 시간 순서와 같다).
 */
function participatingThreadsSql(userId: number) {
  return Prisma.sql`
    FROM "Message" r
    JOIN "Message" p ON p.id = r."threadId"
    JOIN "Channel" c ON c.id = p."channelId"
    JOIN "ChannelMember" cm ON cm."channelId" = p."channelId" AND cm."userId" = ${userId}
    LEFT JOIN "ThreadRead" tr ON tr."threadId" = p.id AND tr."userId" = ${userId}
    WHERE r."deletedAt" IS NULL AND p."threadId" IS NULL AND c."archivedAt" IS NULL
      AND (
        p."userId" = ${userId}
        OR EXISTS (
          SELECT 1 FROM "Message" mine
          WHERE mine."threadId" = p.id AND mine."userId" = ${userId} AND mine."deletedAt" IS NULL
        )
      )
    GROUP BY p.id, tr."lastReadReplyId"`;
}

type ThreadRow = { parentId: number; lastReplyId: number; replyCount: number; unreadCount: number };

export async function listThreads(userId: number, limit: number, cursor?: number) {
  const rows = await prisma.$queryRaw<ThreadRow[]>`
    SELECT p.id AS "parentId",
           MAX(r.id)::int AS "lastReplyId",
           COUNT(*)::int AS "replyCount",
           (COUNT(*) FILTER (WHERE r."userId" <> ${userId} AND r.id > COALESCE(tr."lastReadReplyId", 0)))::int AS "unreadCount"
    ${participatingThreadsSql(userId)}
    ${cursor ? Prisma.sql`HAVING MAX(r.id) < ${cursor}` : Prisma.empty}
    ORDER BY MAX(r.id) DESC
    LIMIT ${limit + 1}`;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  if (page.length === 0) return { items: [], nextCursor: undefined };

  const parentIds = page.map((r) => r.parentId);
  const [parents, replies] = await Promise.all([
    prisma.message.findMany({
      where: { id: { in: parentIds } },
      include: { ...THREAD_REPLY_INCLUDE, channel: { select: { id: true, name: true, isPrivate: true } } },
    }),
    prisma.message.findMany({
      where: { threadId: { in: parentIds }, deletedAt: null },
      include: THREAD_REPLY_INCLUDE,
      orderBy: { id: 'asc' },
    }),
  ]);
  const parentMap = new Map(parents.map((m) => [m.id, m]));
  const repliesByParent = new Map<number, typeof replies>();
  for (const rep of replies) {
    const list = repliesByParent.get(rep.threadId!) ?? [];
    list.push(rep);
    repliesByParent.set(rep.threadId!, list);
  }

  const items = page.map((row) => {
    const { channel, ...rawParent } = parentMap.get(row.parentId)!;
    const parent = blankIfDeleted(rawParent);
    const all = repliesByParent.get(row.parentId) ?? [];
    const lastReply = all[all.length - 1] ?? null;
    return {
      parent,
      channel,
      replyCount: row.replyCount,
      unreadCount: row.unreadCount,
      replies: all.slice(-INLINE_REPLY_LIMIT),
      lastReply,
      lastActivityAt: lastReply?.createdAt ?? parent.createdAt,
    };
  });
  return { items, nextCursor: hasMore ? page[page.length - 1].lastReplyId : undefined };
}

/** 안 읽은 답글이 있는 스레드 수(사이드바 배지). */
export async function countUnreadThreads(userId: number): Promise<number> {
  const rows = await prisma.$queryRaw<{ unread: number }[]>`
    SELECT (COUNT(*) FILTER (WHERE r."userId" <> ${userId} AND r.id > COALESCE(tr."lastReadReplyId", 0)))::int AS unread
    ${participatingThreadsSql(userId)}`;
  return rows.filter((r) => r.unread > 0).length;
}

// ── 읽음 ────────────────────────────────────────────────────────────

export type MarkReadResult = { ok: true; lastReadReplyId: number | null } | { ok: false; status: number; error: string };

/** 스레드를 읽음 처리한다. 읽음 위치는 뒤로 가지 않는다. lastReadReplyId를 생략하면 최신 답글. */
export async function markThreadRead(userId: number, parentId: number, lastReadReplyId?: number): Promise<MarkReadResult> {
  let target: number | null;
  if (lastReadReplyId !== undefined) {
    const reply = await prisma.message.findFirst({ where: { id: lastReadReplyId, threadId: parentId, deletedAt: null }, select: { id: true } });
    if (!reply) return { ok: false, status: 400, error: 'lastReadReplyId is not a reply of this thread' };
    target = reply.id;
  } else {
    const last = await prisma.message.findFirst({ where: { threadId: parentId, deletedAt: null }, orderBy: { id: 'desc' }, select: { id: true } });
    target = last?.id ?? null;
  }

  const existing = await prisma.threadRead.findUnique({ where: { userId_threadId: { userId, threadId: parentId } } });
  const next = Math.max(existing?.lastReadReplyId ?? 0, target ?? 0) || null;
  const saved = await prisma.threadRead.upsert({
    where: { userId_threadId: { userId, threadId: parentId } },
    create: { userId, threadId: parentId, lastReadReplyId: next },
    update: { lastReadReplyId: next },
  });
  emitToUsers([userId], 'thread:read', { parentId });
  return { ok: true, lastReadReplyId: saved.lastReadReplyId };
}

// ── 채널에도 보내기 ──────────────────────────────────────────────────

export type BroadcastResult = { ok: true; message: unknown } | { ok: false; status: number; error: string };

/** 답글의 "채널에도 보내기"를 사후에 켜고 끈다(작성자만, 답글만). 변경은 message:updated로 채널에 알린다. */
export async function setReplyBroadcast(message: { id: number; userId: number; threadId: number | null; channelId: number }, actorId: number, value: boolean): Promise<BroadcastResult> {
  if (message.userId !== actorId) return { ok: false, status: 403, error: 'You can only change your own replies' };
  if (message.threadId === null) return { ok: false, status: 400, error: 'Only thread replies can be sent to the channel' };
  const channel = await prisma.channel.findUnique({ where: { id: message.channelId }, select: { archivedAt: true } });
  if (channel?.archivedAt) return { ok: false, status: 403, error: 'This channel has been archived' };

  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { alsoSendToChannel: value },
    include: { ...THREAD_REPLY_INCLUDE, parent: { select: PARENT_EXCERPT_SELECT } },
  });
  const payload = { ...updated, parent: toParentExcerpt(updated.parent) };
  getIO()?.to(`channel:${message.channelId}`).emit('message:updated', payload);
  return { ok: true, message: payload };
}
