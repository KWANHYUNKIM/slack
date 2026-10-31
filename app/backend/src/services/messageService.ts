import { Prisma, type Message } from '@prisma/client';
import { z } from 'zod';
import { attachableFiles, uniqueFileIds } from './fileAttach.js';
import prisma from '../db.js';
import { USER_SELECT_BASIC, MESSAGE_INCLUDE_FULL } from '../db/selects.js';
import { getIO } from '../websocket/index.js';
import { MAX_MESSAGE_LENGTH } from '../utils/params.js';
import { ERR } from '../utils/errorCodes.js';
import { enforceDlp, recordDlpWarnings } from './dlpService.js';
import { PARENT_EXCERPT_INCLUDE, withParentExcerpt, onThreadReplyCreated, onThreadReplyDeleted, onThreadParentDeleted } from './threadService.js';
import { processNewChannelMessage, syncActivitiesOnEdit, deleteActivitiesForMessage, createReactionActivity, removeReactionActivity } from './mentionService.js';

// 채널 메시지 쓰기(작성, 수정, 삭제, 리액션)의 공용 서비스. REST 라우트와 MCP 쓰기 도구가 함께 쓴다.
// 호출하는 쪽이 "누가 요청했는가"(채널 멤버 여부, 메시지 접근)를 먼저 확인하고, 여기서는 상태 규칙
// (보관 채널, 스레드 부모, 작성자만 수정·삭제)과 소켓 이벤트·활동·푸시를 한 곳에서 처리한다.

/** 라우트가 status로, MCP가 메시지로 그대로 돌려주는 규칙 위반 오류 */
export class ServiceError extends Error {
  /** @param code 안정된 오류 code(응답의 code). 정하지 않으면 상태 코드별 기본 code가 붙는다. */
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** 데이터 유출 방지(DLP) 규칙이 막은 메시지. rule은 일치한 규칙의 이름(일치한 문자열은 담지 않는다). */
export class DlpBlockedError extends ServiceError {
  constructor(public readonly rule: string) {
    super(400, 'Message blocked by a data loss prevention rule', ERR.DLP_BLOCKED, { rule });
  }
}

/** 소켓 응답용: 클라이언트가 번역에 쓰는 code와 DLP 규칙 이름만 */
export function serviceErrorExtra(error: ServiceError): { code?: string; rule?: string } {
  return { ...(error.code && { code: error.code }), ...(error instanceof DlpBlockedError && { rule: error.rule }) };
}

/** ServiceError를 REST 응답 본문으로. code와 extra(예: DLP 규칙 이름)가 있으면 함께 담는다. */
export function serviceErrorBody(error: ServiceError): { error: string; code?: string; [key: string]: unknown } {
  return { error: error.message, ...(error.code && { code: error.code }), ...error.extra };
}

export class InvalidFileIdsError extends ServiceError {
  constructor() {
    super(400, 'Invalid file IDs or files already attached');
  }
}

export const messageContentSchema = z.string()
  .max(MAX_MESSAGE_LENGTH)
  .refine((val) => !val.includes('\u0000'), { message: 'Message content cannot contain null bytes' });

// Matches either a Unicode emoji sequence or a shortcode (with or without colons)
const emojiShortcodeRegex = /^:?[a-z0-9_+-]+:?$/;
const unicodeEmojiRegex = /^(\p{Regional_Indicator}{2}|(\p{Extended_Pictographic})(\p{Emoji_Modifier}|️|‍(\p{Extended_Pictographic}))*)+$/u;

export const isValidEmoji = (val: string) =>
  val.length >= 1 && val.length <= 32 && (unicodeEmojiRegex.test(val) || emojiShortcodeRegex.test(val));

export const reactionEmojiSchema = z.string().min(1).max(32)
  .refine(isValidEmoji, { message: 'Invalid emoji format' });

async function assertChannelNotArchived(channelId: number) {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, select: { archivedAt: true } });
  if (channel?.archivedAt) throw new ServiceError(403, 'This channel has been archived');
}

export interface SendChannelMessageInput {
  content: string;
  threadId?: number;
  alsoSendToChannel?: boolean;
  fileIds?: number[];
}

export interface SendChannelMessageOptions {
  /** message:new를 내보내는 방법을 바꾼다. 기본은 채널 방 전체(io.to). 소켓 경로는 보낸 사람에게 방 참여와 무관하게 먼저 보낸다. */
  broadcast?: (message: object) => void;
}

/** 채널(또는 그 안의 스레드)에 메시지를 올린다. 채널 멤버 확인은 호출하는 쪽 몫. */
export async function sendChannelMessage(
  userId: number,
  channelId: number,
  input: SendChannelMessageInput,
  options: SendChannelMessageOptions = {},
) {
  const { content, threadId, alsoSendToChannel, fileIds } = input;
  await assertChannelNotArchived(channelId);
  // 데이터 유출 방지: BLOCK 규칙에 걸리면 저장하지 않는다(WARN은 저장 뒤 감사 로그)
  const dlpWarned = await enforceDlp(userId, content, 'message');

  // Validate threadId belongs to the same channel and is not deleted
  if (threadId) {
    const parentMessage = await prisma.message.findUnique({ where: { id: threadId } });
    if (!parentMessage || parentMessage.deletedAt || parentMessage.channelId !== channelId) {
      throw new ServiceError(400, 'Thread parent must belong to the same channel');
    }
    if (parentMessage.threadId !== null) {
      throw new ServiceError(400, 'Cannot reply to a reply. Reply to the parent message instead.');
    }
  }

  // Create message and atomically attach files in a transaction
  const finalMessage = await prisma.$transaction(async (tx) => {
    const msg = await tx.message.create({
      data: { content, userId, channelId, threadId, alsoSendToChannel: !!threadId && !!alsoSendToChannel },
    });

    if (fileIds && fileIds.length > 0) {
      const updated = await tx.file.updateMany({
        where: attachableFiles(userId, fileIds),
        data: { messageId: msg.id },
      });
      if (updated.count !== uniqueFileIds(fileIds).length) throw new InvalidFileIdsError();
    }

    return tx.message.findUnique({
      where: { id: msg.id },
      include: { ...MESSAGE_INCLUDE_FULL, ...PARENT_EXCERPT_INCLUDE },
    });
  }).then((m) => (m ? withParentExcerpt(m) : m));

  if (finalMessage && dlpWarned.length > 0) recordDlpWarnings(userId, 'message', finalMessage.id, dlpWarned);

  // Broadcast via WebSocket so other users see the message in real-time
  if (finalMessage) {
    if (options.broadcast) options.broadcast(finalMessage);
    else getIO()?.to(`channel:${channelId}`).emit('message:new', finalMessage);
  }

  // 활동 생성, 활동 이벤트, 푸시(await하지 않는다. 실패는 서비스가 로그로 남긴다)
  if (finalMessage) {
    void processNewChannelMessage(finalMessage, { generalPush: true });
    void onThreadReplyCreated(finalMessage);
  }
  return finalMessage;
}

/** 내 메시지 수정. message는 존재·삭제 여부·채널 멤버 확인을 마친 행. */
export async function editChannelMessage(userId: number, message: Message, content: string) {
  if (message.userId !== userId) throw new ServiceError(403, 'You can only edit your own messages');
  await assertChannelNotArchived(message.channelId);
  const dlpWarned = await enforceDlp(userId, content, 'message');

  const edited = await prisma.message.update({
    where: { id: message.id },
    data: { content, editedAt: new Date() },
    include: {
      user: { select: USER_SELECT_BASIC },
      reactions: { include: { user: { select: { id: true, name: true } } } },
      ...PARENT_EXCERPT_INCLUDE,
    },
  });
  recordDlpWarnings(userId, 'message', edited.id, dlpWarned);
  // 채널에도 보낸 답글의 "스레드에 답글" 머리글이 유지되도록 부모 발췌를 함께 보낸다
  const updatedMessage = withParentExcerpt(edited);
  getIO()?.to(`channel:${message.channelId}`).emit('message:updated', updatedMessage);
  void syncActivitiesOnEdit(updatedMessage);
  return updatedMessage;
}

/** 내 메시지 삭제(소프트). message는 접근 확인을 마친 행. */
export async function deleteChannelMessage(userId: number, message: Message) {
  if (message.userId !== userId) throw new ServiceError(403, 'You can only delete your own messages');
  await assertChannelNotArchived(message.channelId);

  // 소프트 삭제하고 첨부를 떼어 낸다. 떼어 낸 첨부에는 원래 메시지 id를 남긴다(eDiscovery가 삭제된 메시지의 첨부를 찾는다)
  await prisma.$transaction([
    prisma.message.update({ where: { id: message.id }, data: { deletedAt: new Date() } }),
    prisma.file.updateMany({ where: { messageId: message.id }, data: { messageId: null, detachedFromMessageId: message.id } }),
  ]);

  void deleteActivitiesForMessage(message.id);
  if (message.threadId) void onThreadReplyDeleted(message);
  else void onThreadParentDeleted(message);

  // Broadcast deletion to channel so other clients update in real-time
  getIO()?.to(`channel:${message.channelId}`).emit('message:deleted', {
    messageId: message.id,
    threadId: message.threadId ?? null,
    channelId: message.channelId,
  });
}

/** 리액션 추가. message는 접근 확인을 마친 행. */
export async function addMessageReaction(userId: number, message: Message, emoji: string) {
  await assertChannelNotArchived(message.channelId);

  const existing = await prisma.reaction.findUnique({
    where: { userId_messageId_emoji: { userId, messageId: message.id, emoji } },
  });
  if (existing) throw new ServiceError(400, 'Reaction already exists');

  // 같은 리액션이 동시에 들어오면 위 조회를 둘 다 통과한다. 유니크 제약이 막은 쪽을 "이미 있음"으로 돌려준다.
  const reaction = await prisma.reaction.create({
    data: { emoji, userId, messageId: message.id },
    include: { user: { select: { id: true, name: true, avatar: true } } },
  }).catch((error) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ServiceError(400, 'Reaction already exists');
    }
    throw error;
  });

  // Broadcast to channel so other users see the reaction in real-time
  getIO()?.to(`channel:${message.channelId}`).emit('reaction:added', {
    messageId: message.id,
    reaction: { id: reaction.id, emoji, userId, user: reaction.user },
  });

  void createReactionActivity({
    actorId: userId,
    targetUserId: message.userId,
    emoji,
    messageId: message.id,
    channelId: message.channelId,
    actor: reaction.user,
  });
  return reaction;
}

/** 내 리액션 제거. message는 접근 확인을 마친 행. */
export async function removeMessageReaction(userId: number, message: Message, emoji: string) {
  await assertChannelNotArchived(message.channelId);

  const reaction = await prisma.reaction.findUnique({
    where: { userId_messageId_emoji: { userId, messageId: message.id, emoji } },
  });
  if (!reaction) throw new ServiceError(404, 'Reaction not found');

  // 동시에 두 번 지우면 한쪽은 이미 없다. delete는 P2025로 던지므로 deleteMany의 count로 판단해 404로 돌려준다.
  const { count } = await prisma.reaction.deleteMany({ where: { id: reaction.id } });
  if (count === 0) throw new ServiceError(404, 'Reaction not found');
  void removeReactionActivity({ actorId: userId, emoji, messageId: message.id });

  // Broadcast to channel so other users see the removal in real-time
  getIO()?.to(`channel:${message.channelId}`).emit('reaction:removed', { messageId: message.id, emoji, userId });
}
