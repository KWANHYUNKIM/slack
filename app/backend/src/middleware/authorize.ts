import { Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { AuthRequest } from '../types.js';
import { parseIntParam, MAX_MESSAGE_LENGTH } from '../utils/params.js';

// ── Express Middleware ──────────────────────────────────────────────

/**
 * Requires the authenticated user to be a member of the channel
 * specified by req.params.id. Attaches req.channelId on success.
 */
export async function requireChannelMembership(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const channelId = parseIntParam(req.params.id);
  if (!channelId) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return;
  }

  const userId = req.user!.userId;
  const membership = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId, channelId } },
  });

  if (!membership) {
    res.status(403).json({ error: 'You must be a member of this channel' });
    return;
  }

  req.channelId = channelId;
  next();
}

/**
 * Requires the authenticated user to have access to the message
 * specified by req.params.id (message must exist, not be deleted,
 * and the user must be a member of its channel).
 * Attaches req.message and req.channelId on success.
 */
export async function requireMessageAccess(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const messageId = parseIntParam(req.params.id);
  if (!messageId) {
    res.status(400).json({ error: 'Invalid message ID' });
    return;
  }

  const message = await prisma.message.findUnique({
    where: { id: messageId },
  });

  if (!message || message.deletedAt) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  const userId = req.user!.userId;
  const membership = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId, channelId: message.channelId } },
  });

  if (!membership) {
    res.status(403).json({ error: 'You must be a member of this channel' });
    return;
  }

  req.message = message;
  req.channelId = message.channelId;
  next();
}

/**
 * Checks whether the given user has access to the specified file.
 * Returns the file record if access is granted, or null otherwise.
 *
 * - Message-attached files: requires channel membership
 * - DM-attached files: requires DM participation (sender or recipient, or group member)
 * - Unattached files: requires file ownership
 *
 * Used by both the requireFileAccess middleware and the download-token
 * endpoint to avoid duplicating authorization logic.
 */
export async function verifyFileAccess(
  userId: number,
  fileId: number,
): Promise<any | null> {
  const file = await prisma.file.findUnique({
    where: { id: fileId },
    include: {
      user: { select: { id: true, name: true } },
    },
  });

  if (!file) return null;

  if (file.messageId) {
    const message = await prisma.message.findUnique({
      where: { id: file.messageId, deletedAt: null },
    });
    if (!message) return null;

    const membership = await prisma.channelMember.findUnique({
      where: { userId_channelId: { userId, channelId: message.channelId } },
    });
    if (!membership) return null;
  } else if (file.dmId) {
    const dm = await prisma.directMessage.findUnique({
      where: { id: file.dmId },
    });
    if (!dm || dm.deletedAt) return null;
    if (!(await canAccessDm(dm, userId))) return null;
  } else {
    if (file.userId !== userId) return null;
  }

  return file;
}

/**
 * Express middleware that requires the authenticated user to have access
 * to the file specified by req.params.id. Attaches req.file on success.
 * Returns 404 for all unauthorized/missing files to prevent enumeration.
 */
export async function requireFileAccess(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const fileId = parseIntParam(req.params.id);
  if (!fileId) {
    res.status(400).json({ error: 'Invalid file ID' });
    return;
  }

  const file = await verifyFileAccess(req.user!.userId, fileId);
  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  req.file = file;
  next();
}

/**
 * DM 접근 판정. 그룹 메시지(groupId 있음)는 현재 그룹 멤버만, 1:1 메시지는 보낸 사람·받는 사람만.
 * 그룹을 나간 사람은 자기가 보낸 메시지라도 더 이상 접근할 수 없다.
 */
export async function canAccessDm(
  dm: { fromUserId: number; toUserId: number | null; groupId: number | null },
  userId: number,
): Promise<boolean> {
  if (dm.groupId !== null) return checkDmGroupMembership(userId, dm.groupId);
  return dm.fromUserId === userId || dm.toUserId === userId;
}

/**
 * Requires the authenticated user to be a participant in the DM
 * specified by req.params.id (either sender or recipient, or a member of its group).
 * Use for read-only operations and thread replies.
 * Attaches req.dm on success.
 */
export async function requireDmAccess(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const dmId = parseIntParam(req.params.id);
  if (!dmId) {
    res.status(400).json({ error: 'Invalid message ID' });
    return;
  }

  const dm = await prisma.directMessage.findUnique({
    where: { id: dmId },
  });

  if (!dm || dm.deletedAt !== null) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  const userId = req.user!.userId;
  if (!(await canAccessDm(dm, userId))) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  req.dm = dm;
  next();
}

/**
 * Requires the authenticated user to own the direct message
 * specified by req.params.id. Checks existence, soft-delete,
 * and fromUserId ownership. Attaches req.dm on success.
 */
export async function requireDmOwnership(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const dmId = parseIntParam(req.params.id);
  if (!dmId) {
    res.status(400).json({ error: 'Invalid message ID' });
    return;
  }

  const dm = await prisma.directMessage.findUnique({
    where: { id: dmId },
  });

  if (!dm || dm.deletedAt !== null) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  const userId = req.user!.userId;
  if (dm.fromUserId !== userId) {
    res.status(403).json({ error: 'You can only modify your own messages' });
    return;
  }
  // 그룹을 나간 뒤에는 자기 메시지도 고치거나 지울 수 없다
  if (dm.groupId !== null && !(await checkDmGroupMembership(userId, dm.groupId))) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }

  req.dm = dm;
  next();
}

/**
 * Requires the authenticated user to be a current member of the group DM
 * specified by req.params.id. Attaches req.dmGroupId on success.
 * 그룹이 없거나 멤버가 아니면 둘 다 404로 답해 그룹 id 존재 여부를 숨긴다.
 */
export async function requireDmGroupMember(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const groupId = parseIntParam(req.params.id);
  if (!groupId) {
    res.status(400).json({ error: 'Invalid group ID' });
    return;
  }

  if (!(await checkDmGroupMembership(req.user!.userId, groupId))) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  req.dmGroupId = groupId;
  next();
}

/**
 * 채널 읽기 권한 규칙: 멤버이거나, 공개 채널이면 비멤버(게스트 제외)도 읽을 수 있다.
 * 채널이 없으면 exists:false. 읽기 접근 미들웨어와 퍼말링크 locate가 함께 쓴다.
 */
export async function canReadChannel(
  userId: number,
  role: string | undefined,
  channelId: number,
): Promise<{ exists: boolean; allowed: boolean; isMember: boolean }> {
  const [membership, channel] = await Promise.all([
    prisma.channelMember.findUnique({ where: { userId_channelId: { userId, channelId } } }),
    prisma.channel.findUnique({ where: { id: channelId }, select: { id: true, isPrivate: true } }),
  ]);
  if (!channel) return { exists: false, allowed: false, isMember: false };
  const isMember = !!membership;
  return { exists: true, allowed: isMember || (!channel.isPrivate && role !== 'GUEST'), isMember };
}

/**
 * Allows non-members to read public channels.
 * Members always pass; non-members pass only if the channel is public.
 * Attaches req.channelId and req.isChannelMember.
 */
export async function requirePublicChannelReadAccess(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const channelId = parseIntParam(req.params.id);
  if (!channelId) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return;
  }

  const access = await canReadChannel(req.user!.userId, req.user!.role, channelId);
  if (!access.exists) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }
  if (!access.allowed) {
    res.status(403).json({ error: 'You must be a member of this channel' });
    return;
  }

  req.channelId = channelId;
  req.isChannelMember = access.isMember;
  next();
}

/**
 * Allows non-members to read messages in public channels.
 * Attaches req.message and req.channelId.
 */
export function requirePublicMessageReadAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  return messageReadAccess(req, res, next, false);
}

/**
 * requirePublicMessageReadAccess와 같지만, 삭제된 스레드 부모도 살아 있는 답글이 남아 있으면 통과시킨다
 * (삭제 자리표시자 카드에서 스레드를 열 수 있어야 한다).
 */
export function requireThreadReadAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  return messageReadAccess(req, res, next, true);
}

async function messageReadAccess(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
  allowDeletedParent: boolean,
): Promise<void> {
  const messageId = parseIntParam(req.params.id);
  if (!messageId) {
    res.status(400).json({ error: 'Invalid message ID' });
    return;
  }

  const message = await prisma.message.findUnique({
    where: { id: messageId },
  });

  const hasLiveReplies = !!message && !!message.deletedAt && allowDeletedParent && message.threadId === null
    && (await prisma.message.count({ where: { threadId: message.id, deletedAt: null } })) > 0;
  if (!message || (message.deletedAt && !hasLiveReplies)) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  const access = await canReadChannel(req.user!.userId, req.user!.role, message.channelId);
  if (!access.exists) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }
  if (!access.allowed) {
    res.status(403).json({ error: 'You must be a member of this channel' });
    return;
  }

  req.message = message;
  req.channelId = message.channelId;
  req.isChannelMember = access.isMember;
  next();
}

// ── WebSocket Helper ────────────────────────────────────────────────

export async function checkDmGroupMembership(
  userId: number,
  groupId: number,
): Promise<boolean> {
  const membership = await prisma.dMGroupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    select: { userId: true },
  });
  return !!membership;
}

export async function checkChannelMembership(
  userId: number,
  channelId: number,
): Promise<boolean> {
  const membership = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId, channelId } },
  });
  return !!membership;
}

// ── Zod Schemas for WebSocket Payloads ──────────────────────────────

const contentSchema = z.string().min(1).max(MAX_MESSAGE_LENGTH)
  .refine(val => val.trim().length > 0, { message: 'Content cannot be empty' })
  .refine(val => !val.includes('\u0000'), { message: 'Content cannot contain null bytes' });

const optionalContentSchema = z.string().max(MAX_MESSAGE_LENGTH)
  .refine(val => !val.includes('\u0000'), { message: 'Content cannot contain null bytes' });

export const wsMessageSendSchema = z.object({
  channelId: z.number().int().positive(),
  content: optionalContentSchema,
  threadId: z.number().int().positive().optional(),
  alsoSendToChannel: z.boolean().optional(),
  fileIds: z.array(z.number().int().positive()).max(10).optional(),
}).refine(
  (data) => (data.content?.trim().length ?? 0) > 0 || (data.fileIds && data.fileIds.length > 0),
  { message: 'Message must have content or file attachments' },
);

export const wsMessageEditSchema = z.object({
  messageId: z.number().int().positive(),
  content: contentSchema,
});

export const wsMessageDeleteSchema = z.object({
  messageId: z.number().int().positive(),
});

export const wsDmSendSchema = z.object({
  toUserId: z.number().int().positive(),
  content: contentSchema,
});

export const wsDmGroupSendSchema = z.object({
  groupId: z.number().int().positive(),
  content: optionalContentSchema,
  fileIds: z.array(z.number().int().positive()).max(10).optional(),
}).refine(
  (data) => (data.content?.trim().length ?? 0) > 0 || (data.fileIds && data.fileIds.length > 0),
  { message: 'Message must have content or file attachments' },
);

export const wsChannelIdSchema = z.number().int().positive();

export const wsDmGroupIdSchema = z.number().int().positive();

export const wsUserIdSchema = z.number().int().positive();

// ── Huddle Schemas ───────────────────────────────────────────────────

export const wsHuddleInviteSchema = z.object({
  toUserId: z.number().int().positive(),
});

export const wsHuddleInviteResponseSchema = z.object({
  inviteId: z.string().min(1),
});

export const wsHuddleLeaveSchema = z.object({
  huddleId: z.string().min(1),
});

export const wsHuddleMuteSchema = z.object({
  huddleId: z.string().min(1),
  isMuted: z.boolean(),
});

export const wsHuddleSignalSchema = z.object({
  huddleId: z.string().min(1),
  signal: z.object({
    type: z.enum(['offer', 'answer', 'ice-candidate']),
    sdp: z.string().optional(),
    candidate: z.unknown().optional(),
  }),
});
