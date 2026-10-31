import type { ActivityType, Prisma } from '@prisma/client';
import prisma from '../db.js';
import { canReadChannel, guestVisibleUserIds, listableChannelsWhere, verifyFilesAccess } from '../middleware/authorize.js';
import { MAX_READ_FILE_BYTES, isTextMimetype } from '../utils/fileTypes.js';
import { MENTION_TYPES, serializeActivities, visibleActivityWhere } from '../services/mentionService.js';
import { STATUS_SELECT, toPublicUser } from '../services/statusService.js';
import { isUserOnline } from '../websocket/index.js';
import { USER_SELECT_BASIC } from '../db/selects.js';
import { channelTimelineWhere } from '../db/timeline.js';
import { paginateResults } from '../utils/pagination.js';

// MCP 읽기 도구의 실제 조회. 모든 함수는 토큰 소유자(ctx)의 권한으로만 읽는다.
// 권한 판단은 authorize.ts의 헬퍼(canReadChannel, listableChannelsWhere, guestVisibleUserIds)와
// mentionService.visibleActivityWhere를 그대로 쓴다. 여기서 새 권한 규칙을 만들지 않는다.

export interface ToolContext {
  userId: number;
  role: string | undefined;
  tokenId: number;
  scopes: string[];
}

/** 도구 결과로 돌려줄 수 있는, 권한 없음·없음을 구분하지 않는 오류 */
export class ToolAccessError extends Error {}

export const MAX_THREAD_REPLIES = 200;

const MESSAGE_VIEW_INCLUDE = {
  user: { select: USER_SELECT_BASIC },
  files: { select: { id: true, originalName: true, mimetype: true, size: true } },
  reactions: { select: { emoji: true } },
  _count: { select: { replies: { where: { deletedAt: null } } } },
} as const;

type MessageRow = Prisma.MessageGetPayload<{ include: typeof MESSAGE_VIEW_INCLUDE }>;

/**
 * 메시지에 붙은 파일 중 read_file로 내용을 읽을 수 있는 id. 접근 규칙은 REST 다운로드와 같은 verifyFilesAccess
 * (채널 멤버만, 그래서 멤버가 아닌 공개 채널의 파일은 읽을 수 없다)이고, files:read 범위와 텍스트·크기 상한도 본다.
 */
async function readableFileIds(ctx: ToolContext, rows: MessageRow[]): Promise<Set<number>> {
  const candidates = rows.flatMap((m) => (m.deletedAt ? [] : m.files)).filter((f) => isTextMimetype(f.mimetype) && f.size <= MAX_READ_FILE_BYTES);
  if (!ctx.scopes.includes('files:read') || candidates.length === 0) return new Set();
  const allowed = await verifyFilesAccess(ctx.userId, candidates.map((f) => f.id));
  return new Set(candidates.filter((f) => allowed.has(f.id)).map((f) => f.id));
}

function toMessageView(m: MessageRow, readable: Set<number>) {
  const deleted = !!m.deletedAt;
  const reactionCounts = new Map<string, number>();
  if (!deleted) for (const r of m.reactions) reactionCounts.set(r.emoji, (reactionCounts.get(r.emoji) ?? 0) + 1);
  return {
    id: m.id,
    channelId: m.channelId,
    threadId: m.threadId,
    user: { id: m.user.id, name: m.user.name },
    // 삭제된 부모(답글이 남은 자리표시자)는 내용·첨부·리액션을 비운다(blankIfDeleted와 같은 규칙)
    content: deleted ? '' : m.content,
    deleted,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    replyCount: m._count.replies,
    files: deleted ? [] : m.files.map((f) => ({ id: f.id, name: f.originalName, mimetype: f.mimetype, size: f.size, readable: readable.has(f.id) })),
    reactions: [...reactionCounts].map(([emoji, count]) => ({ emoji, count })),
  };
}

export async function listChannels(ctx: ToolContext, args: { limit: number; cursor?: number }) {
  const rows = await prisma.channel.findMany({
    where: { ...listableChannelsWhere(ctx.userId, ctx.role), ...(args.cursor && { id: { lt: args.cursor } }) },
    // 내 멤버십 행만 같이 가져와 isMember를 한 번의 조회로 판단한다
    include: { _count: { select: { members: true } }, members: { where: { userId: ctx.userId }, select: { userId: true } } },
    orderBy: { id: 'desc' },
    take: args.limit + 1,
  });
  const { results, nextCursor } = paginateResults(rows, args.limit);
  return {
    items: results.map((c) => ({
      id: c.id,
      name: c.name,
      topic: c.topic,
      description: c.description,
      isPrivate: c.isPrivate,
      isMember: c.members.length > 0,
      memberCount: c._count.members,
    })),
    nextCursor: nextCursor ?? null,
  };
}

async function assertChannelReadable(ctx: ToolContext, channelId: number) {
  const access = await canReadChannel(ctx.userId, ctx.role, channelId);
  // 없는 채널과 권한 없는 채널을 같은 오류로 답해 비공개 채널의 존재를 숨긴다
  if (!access.exists || !access.allowed) throw new ToolAccessError('Channel not found or not accessible');
}

export async function readChannel(ctx: ToolContext, args: { channelId: number; limit: number; cursor?: number }) {
  await assertChannelReadable(ctx, args.channelId);
  // 채널 화면과 같은 타임라인(GET /channels/:id/messages와 같은 헬퍼)
  const rows = await prisma.message.findMany({
    where: { ...channelTimelineWhere(args.channelId), ...(args.cursor && { id: { lt: args.cursor } }) },
    include: MESSAGE_VIEW_INCLUDE,
    orderBy: { id: 'desc' },
    take: args.limit + 1,
  });
  const { results, nextCursor } = paginateResults(rows, args.limit);
  // 사람이 읽기 쉽게 오래된 것부터. nextCursor는 더 오래된 쪽을 가리킨다.
  const readable = await readableFileIds(ctx, results);
  return { channelId: args.channelId, messages: results.reverse().map((m) => toMessageView(m, readable)), nextCursor: nextCursor ?? null };
}

export async function readThread(ctx: ToolContext, args: { messageId: number }) {
  const target = await prisma.message.findUnique({
    where: { id: args.messageId },
    select: { id: true, threadId: true, deletedAt: true },
  });
  // 삭제된 답글 id는 없는 메시지와 같게 답한다(requireThreadReadAccess는 지워진 답글을 404로 막는다)
  if (target?.deletedAt && target.threadId !== null) throw new ToolAccessError('Message not found or not accessible');
  const parentId = target ? (target.threadId ?? target.id) : null;
  const parent = parentId ? await prisma.message.findUnique({ where: { id: parentId }, include: MESSAGE_VIEW_INCLUDE }) : null;
  if (!parent) throw new ToolAccessError('Message not found or not accessible');
  await assertChannelReadable(ctx, parent.channelId).catch(() => {
    throw new ToolAccessError('Message not found or not accessible');
  });

  const replies = await prisma.message.findMany({
    where: { threadId: parent.id, deletedAt: null },
    include: MESSAGE_VIEW_INCLUDE,
    orderBy: { id: 'asc' },
    take: MAX_THREAD_REPLIES + 1,
  });
  // 지워진 부모는 살아 있는 답글이 있을 때만 자리표시자로 보여 준다(requireThreadReadAccess와 같은 규칙)
  if (parent.deletedAt && replies.length === 0) throw new ToolAccessError('Message not found or not accessible');

  const shownReplies = replies.slice(0, MAX_THREAD_REPLIES);
  const readable = await readableFileIds(ctx, [parent, ...shownReplies]);
  return {
    parent: toMessageView(parent, readable),
    replies: shownReplies.map((m) => toMessageView(m, readable)),
    truncated: replies.length > MAX_THREAD_REPLIES,
  };
}

export async function listUsers(ctx: ToolContext, args: { search?: string; limit: number }) {
  const visibleUserIds = await guestVisibleUserIds(ctx.userId, ctx.role);
  const users = await prisma.user.findMany({
    where: {
      deactivatedAt: null,
      ...(visibleUserIds && { id: { in: visibleUserIds } }),
      ...(args.search && { name: { contains: args.search, mode: 'insensitive' as const } }),
    },
    select: { id: true, name: true, status: true, bio: true, ...STATUS_SELECT },
    orderBy: { name: 'asc' },
    take: args.limit,
  });
  return {
    items: users.map((u) => ({
      ...toPublicUser(u),
      status: isUserOnline(u.id) ? 'online' : u.status,
      isOnline: isUserOnline(u.id),
    })),
  };
}

const ACTIVITY_TYPES: Record<string, ActivityType[] | undefined> = {
  all: undefined,
  mentions: MENTION_TYPES,
  threads: ['THREAD_REPLY'],
  reactions: ['REACTION'],
};

export async function getActivity(
  ctx: ToolContext,
  args: { type: 'all' | 'mentions' | 'threads' | 'reactions'; unreadOnly: boolean; limit: number; cursor?: number },
) {
  const types = ACTIVITY_TYPES[args.type];
  // 읽기 전용 도구라 읽음 처리는 하지 않는다
  const rows = await prisma.activity.findMany({
    where: {
      ...(await visibleActivityWhere(ctx.userId)),
      ...(types && { type: { in: types } }),
      ...(args.unreadOnly && { readAt: null }),
      ...(args.cursor && { id: { lt: args.cursor } }),
    },
    orderBy: { id: 'desc' },
    take: args.limit + 1,
  });
  const { results, nextCursor } = paginateResults(rows, args.limit);
  return { items: await serializeActivities(results), nextCursor: nextCursor ?? null };
}
