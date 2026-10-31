import type { Message } from '@prisma/client';
import prisma from '../db.js';
import { checkChannelMembership } from '../middleware/authorize.js';
import {
  addMessageReaction,
  deleteChannelMessage,
  editChannelMessage,
  removeMessageReaction,
  sendChannelMessage,
} from '../services/messageService.js';
import { ToolAccessError, type ToolContext } from './readTools.js';

// MCP 쓰기 도구의 실제 동작. 규칙(보관 채널, 스레드 부모, 작성자만 수정·삭제)과 소켓 이벤트·멘션 활동·푸시는
// REST 라우트와 같은 messageService를 쓴다. 여기서는 "토큰 소유자가 이 채널·메시지에 접근할 수 있는가"만 확인한다.
// 비멤버와 없는 대상은 같은 오류로 답해 비공개 채널의 존재를 숨긴다.

const NOT_ACCESSIBLE_CHANNEL = 'Channel not found or not accessible';
const NOT_ACCESSIBLE_MESSAGE = 'Message not found or not accessible';

async function assertChannelMember(ctx: ToolContext, channelId: number) {
  if (!(await checkChannelMembership(ctx.userId, channelId))) throw new ToolAccessError(NOT_ACCESSIBLE_CHANNEL);
}

/** 삭제되지 않은 메시지이고 소유자가 그 채널의 멤버일 때만 돌려준다(requireMessageAccess와 같은 규칙) */
async function loadAccessibleMessage(ctx: ToolContext, messageId: number): Promise<Message> {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message || message.deletedAt) throw new ToolAccessError(NOT_ACCESSIBLE_MESSAGE);
  if (!(await checkChannelMembership(ctx.userId, message.channelId))) throw new ToolAccessError(NOT_ACCESSIBLE_MESSAGE);
  return message;
}

export async function sendMessage(
  ctx: ToolContext,
  args: { channelId: number; content: string; threadId?: number; alsoSendToChannel?: boolean },
) {
  await assertChannelMember(ctx, args.channelId);
  const { channelId, ...input } = args;
  const msg = await sendChannelMessage(ctx.userId, channelId, input);
  if (!msg) throw new Error('Message was not created');
  return { id: msg.id, channelId: msg.channelId, threadId: msg.threadId, createdAt: msg.createdAt };
}

export async function editMessage(ctx: ToolContext, args: { messageId: number; content: string }) {
  const message = await loadAccessibleMessage(ctx, args.messageId);
  const edited = await editChannelMessage(ctx.userId, message, args.content);
  return { id: edited.id, channelId: edited.channelId, editedAt: edited.editedAt };
}

export async function deleteMessage(ctx: ToolContext, args: { messageId: number }) {
  const message = await loadAccessibleMessage(ctx, args.messageId);
  await deleteChannelMessage(ctx.userId, message);
  return { id: message.id, deleted: true };
}

export async function addReaction(ctx: ToolContext, args: { messageId: number; emoji: string }) {
  const message = await loadAccessibleMessage(ctx, args.messageId);
  const reaction = await addMessageReaction(ctx.userId, message, args.emoji);
  return { messageId: message.id, emoji: reaction.emoji };
}

export async function removeReaction(ctx: ToolContext, args: { messageId: number; emoji: string }) {
  const message = await loadAccessibleMessage(ctx, args.messageId);
  await removeMessageReaction(ctx.userId, message, args.emoji);
  return { messageId: message.id, emoji: args.emoji, removed: true };
}
