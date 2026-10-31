import type { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { USER_SELECT_BASIC } from '../db/selects.js';
import { canAccessDm, checkDmGroupMembership } from '../middleware/authorize.js';
import { listGroupConversationSummaries, sendGroupMessage } from '../services/dmGroupService.js';
import {
  UNABLE_TO_SEND,
  deleteDirectMessage,
  editDirectMessage,
  listDirectConversationSummaries,
  sendDirectMessage,
  sharesChannel,
} from '../services/dmService.js';
import { ServiceError } from '../services/messageService.js';
import { paginateResults } from '../utils/pagination.js';
import { ToolAccessError, type ToolContext } from './readTools.js';

// MCP DM 도구(mcp-2b)의 실제 동작. 1:1 DM의 전송·수정·삭제는 dmService, 그룹 DM 전송은 dmGroupService를 REST·소켓과 같이 쓴다.
// 여기서는 "토큰 소유자가 이 대화·메시지에 접근할 수 있는가"만 확인한다. 읽기는 읽음 처리(readAt, 읽음 커서, 멘션 읽음)를 하지 않는다.
// 없는 대상과 접근할 수 없는 대상은 같은 오류로 답해 사용자·그룹의 존재를 숨긴다.

const NOT_ACCESSIBLE_CONVERSATION = 'Conversation not found or not accessible';
const NOT_ACCESSIBLE_MESSAGE = 'Message not found or not accessible';

const DM_VIEW_INCLUDE = {
  fromUser: { select: USER_SELECT_BASIC },
  files: { select: { id: true, originalName: true, mimetype: true, size: true } },
  reactions: { select: { emoji: true } },
  _count: { select: { replies: { where: { deletedAt: null } } } },
} as const;

type DmRow = Prisma.DirectMessageGetPayload<{ include: typeof DM_VIEW_INCLUDE }>;

function toDmView(m: DmRow) {
  const reactionCounts = new Map<string, number>();
  for (const r of m.reactions) reactionCounts.set(r.emoji, (reactionCounts.get(r.emoji) ?? 0) + 1);
  return {
    id: m.id,
    fromUser: { id: m.fromUser.id, name: m.fromUser.name },
    toUserId: m.toUserId,
    groupId: m.groupId,
    content: m.content,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    replyCount: m._count.replies,
    files: m.files.map((f) => ({ id: f.id, name: f.originalName, mimetype: f.mimetype, size: f.size })),
    reactions: [...reactionCounts].map(([emoji, count]) => ({ emoji, count })),
  };
}

/** userId와 groupId 중 정확히 하나만 받는다 */
function pickTarget(args: { userId?: number; groupId?: number }): { userId: number } | { groupId: number } {
  if ((args.userId === undefined) === (args.groupId === undefined)) {
    throw new ToolAccessError('Provide exactly one of userId or groupId');
  }
  return args.groupId !== undefined ? { groupId: args.groupId } : { userId: args.userId! };
}

/** GET /dms/:userId와 같은 규칙: 상대가 있어야 하고, 게스트는 채널을 공유하는 상대만 볼 수 있다(자기 자신은 가능) */
async function assertCanReadWithUser(ctx: ToolContext, otherUserId: number) {
  if (otherUserId === ctx.userId) return;
  const other = await prisma.user.findUnique({ where: { id: otherUserId }, select: { id: true } });
  if (!other) throw new ToolAccessError(NOT_ACCESSIBLE_CONVERSATION);
  if (ctx.role === 'GUEST' && !(await sharesChannel(ctx.userId, otherUserId))) throw new ToolAccessError(NOT_ACCESSIBLE_CONVERSATION);
}

export async function listDms(ctx: ToolContext, args: { limit: number }) {
  // 사이드바용 목록(멘션 수, 별표, 상태 포함)이 아니라 가벼운 요약을 쓰고, limit은 SQL에서 적용한다
  const [direct, groups] = await Promise.all([
    listDirectConversationSummaries(ctx.userId, ctx.role, args.limit),
    listGroupConversationSummaries(ctx.userId, args.limit),
  ]);
  return { direct, groups };
}

export async function readDm(ctx: ToolContext, args: { userId?: number; groupId?: number; limit: number; cursor?: number }) {
  const target = pickTarget(args);
  let where: Prisma.DirectMessageWhereInput;
  if ('groupId' in target) {
    if (!(await checkDmGroupMembership(ctx.userId, target.groupId))) throw new ToolAccessError(NOT_ACCESSIBLE_CONVERSATION);
    where = { groupId: target.groupId };
  } else {
    await assertCanReadWithUser(ctx, target.userId);
    where = {
      groupId: null,
      OR: [
        { fromUserId: ctx.userId, toUserId: target.userId },
        { fromUserId: target.userId, toUserId: ctx.userId },
      ],
    };
  }
  // 대화 화면과 같은 타임라인(삭제 제외, 스레드 답글 제외). 읽음 처리는 하지 않는다.
  const rows = await prisma.directMessage.findMany({
    where: { ...where, deletedAt: null, threadId: null, ...(args.cursor && { id: { lt: args.cursor } }) },
    include: DM_VIEW_INCLUDE,
    orderBy: { id: 'desc' },
    take: args.limit + 1,
  });
  const { results, nextCursor } = paginateResults(rows, args.limit);
  return { ...target, messages: results.reverse().map(toDmView), nextCursor: nextCursor ?? null };
}

export async function sendDm(ctx: ToolContext, args: { userId?: number; groupId?: number; content: string }) {
  const target = pickTarget(args);
  if ('groupId' in target) {
    if (!(await checkDmGroupMembership(ctx.userId, target.groupId))) throw new ToolAccessError(NOT_ACCESSIBLE_CONVERSATION);
    const dm = await sendGroupMessage({ groupId: target.groupId, fromUserId: ctx.userId, content: args.content });
    return { id: dm.id, groupId: dm.groupId, createdAt: dm.createdAt };
  }
  try {
    const dm = await sendDirectMessage({ userId: ctx.userId, role: ctx.role }, target.userId, { content: args.content });
    return { id: dm.id, toUserId: dm.toUserId, createdAt: dm.createdAt };
  } catch (error) {
    // 받는 사람이 없음·비활성·게스트 격리는 구분하지 않고 같은 오류로 답한다
    if (error instanceof ServiceError && error.message === UNABLE_TO_SEND) throw new ToolAccessError(NOT_ACCESSIBLE_CONVERSATION);
    throw error;
  }
}

/** 삭제되지 않은 DM이고 소유자가 참여자(1:1 당사자 또는 그룹 멤버)일 때만 돌려준다 */
async function loadAccessibleDm(ctx: ToolContext, messageId: number) {
  const dm = await prisma.directMessage.findUnique({ where: { id: messageId } });
  if (!dm || dm.deletedAt || !(await canAccessDm(dm, ctx.userId))) throw new ToolAccessError(NOT_ACCESSIBLE_MESSAGE);
  return dm;
}

export async function editDmMessage(ctx: ToolContext, args: { messageId: number; content: string }) {
  const dm = await loadAccessibleDm(ctx, args.messageId);
  const edited = await editDirectMessage(ctx.userId, dm, args.content);
  return { id: edited.id, editedAt: edited.editedAt };
}

export async function deleteDmMessage(ctx: ToolContext, args: { messageId: number }) {
  const dm = await loadAccessibleDm(ctx, args.messageId);
  await deleteDirectMessage(ctx.userId, dm);
  return { id: dm.id, deleted: true };
}
