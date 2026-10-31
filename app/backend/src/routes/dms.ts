import { Router, Response } from 'express';
import { z } from 'zod';
import { MAX_MESSAGE_LENGTH } from '../utils/params.js';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireDmOwnership, requireDmAccess } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { isUserOnline, getIO } from '../websocket/index.js';
import { USER_SELECT_BASIC, FILE_SELECT, DM_INCLUDE_USERS } from '../db/selects.js';
import { parsePagination, paginateResults } from '../utils/pagination.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { sendPushToUser } from '../services/pushService.js';
import { sendGroupMessage, emitToGroup, InvalidFileIdsError } from '../services/dmGroupService.js';
import { sharesChannel, sendDirectMessage, editDirectMessage, deleteDirectMessage, listDirectConversations } from '../services/dmService.js';
import { ServiceError } from '../services/messageService.js';
import {
  createActivitiesForDm,
  createReactionActivity,
  removeReactionActivity,
  markDmMentionsRead,
} from '../services/mentionService.js';

const router = Router();

const sendDMSchema = z.object({
  toUserId: z.number().int().positive(),
  content: z.string().max(MAX_MESSAGE_LENGTH)
    .refine(val => !val.includes('\u0000'), { message: 'Content cannot contain null bytes' }),
  fileIds: z.array(z.number().int().positive()).max(10).optional(),
}).refine(
  (data) => (data.content?.trim().length ?? 0) > 0 || (data.fileIds && data.fileIds.length > 0),
  { message: 'Message must have content or file attachments' },
);

// POST /dms - Send a direct message
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { toUserId, content, fileIds } = sendDMSchema.parse(req.body);
    // 받는 사람 확인, 게스트 격리, 전송, 소켓, 푸시, 활동 생성은 dmService가 한다(소켓·MCP와 같은 경로)
    const dm = await sendDirectMessage({ userId: req.user!.userId, role: req.user!.role }, toUserId, { content, fileIds });
    res.status(201).json(dm);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof InvalidFileIdsError) {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }
    logError('Send DM error', error);
    res.status(500).json({ error: 'Failed to send DM' });
  }
});

// GET /dms - List all DM conversations
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.json(await listDirectConversations(req.user!.userId, req.user!.role));
  } catch (error) {
    logError('Get DM conversations error', error);
    res.status(500).json({ error: 'Failed to get DM conversations' });
  }
});

// PUT /dms/:userId/star - 1:1 DM 상대 즐겨찾기 추가 (멱등)
router.put('/:userId/star', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const otherUserId = parseIntParam(req.params.userId);
    if (!otherUserId || otherUserId === req.user!.userId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }
    const userId = req.user!.userId;
    const other = await prisma.user.findUnique({ where: { id: otherUserId }, select: { id: true, deactivatedAt: true } });
    if (!other || other.deactivatedAt) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    await prisma.dMStar.upsert({
      where: { userId_otherUserId: { userId, otherUserId } },
      create: { userId, otherUserId },
      update: {},
    });
    getIO()?.to(`user:${userId}`).emit('star:updated', { type: 'dm', id: otherUserId, isStarred: true });
    res.json({ userId: otherUserId, isStarred: true });
  } catch (error) {
    logError('Star DM error', error);
    res.status(500).json({ error: 'Failed to star conversation' });
  }
});

// DELETE /dms/:userId/star - 1:1 DM 상대 즐겨찾기 해제 (멱등)
router.delete('/:userId/star', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const otherUserId = parseIntParam(req.params.userId);
    if (!otherUserId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }
    const userId = req.user!.userId;
    await prisma.dMStar.deleteMany({ where: { userId, otherUserId } });
    getIO()?.to(`user:${userId}`).emit('star:updated', { type: 'dm', id: otherUserId, isStarred: false });
    res.json({ userId: otherUserId, isStarred: false });
  } catch (error) {
    logError('Unstar DM error', error);
    res.status(500).json({ error: 'Failed to unstar conversation' });
  }
});

/**
 * 1:1 DM의 읽음 기준점(쿼리 1번). DM은 메시지별 readAt이라, 내 앞으로 온 첫 안 읽음 메시지 바로 앞 메시지가 기준점이다.
 * 안 읽음이 없으면 최신 메시지가 기준점이다. unreadCount는 기준점 이후 최상위 메시지 수(내 것 포함, 채널 응답과 같은 규칙).
 * 읽기 전용이다: 호출하는 쪽이 읽음 처리(readAt)보다 먼저 끝내야 열기 직전 값이 된다.
 */
async function getDmUnreadBaseline(
  currentUserId: number,
  otherUserId: number,
): Promise<{ lastReadId: number | null; unreadCount: number }> {
  const [row] = await prisma.$queryRaw<Array<{ lastReadId: number | null; unreadCount: number }>>`
    WITH conv AS (
      SELECT id, "fromUserId", "readAt" FROM "DirectMessage"
      WHERE "groupId" IS NULL AND "deletedAt" IS NULL AND "threadId" IS NULL
        AND (("fromUserId" = ${currentUserId} AND "toUserId" = ${otherUserId})
          OR ("fromUserId" = ${otherUserId} AND "toUserId" = ${currentUserId}))
    ),
    first_unread AS (
      -- 나와의 대화는 안 읽음이 없다
      SELECT CASE WHEN ${currentUserId}::int = ${otherUserId}::int THEN NULL ELSE MIN(id) END AS id
      FROM conv WHERE "fromUserId" = ${otherUserId} AND "readAt" IS NULL
    )
    SELECT
      (SELECT MAX(c.id) FROM conv c, first_unread f WHERE f.id IS NULL OR c.id < f.id)::int AS "lastReadId",
      (SELECT COUNT(*) FROM conv c, first_unread f WHERE f.id IS NOT NULL AND c.id >= f.id)::int AS "unreadCount"
  `;
  return { lastReadId: row?.lastReadId ?? null, unreadCount: row?.unreadCount ?? 0 };
}

// GET /dms/:userId - Get DM conversation with specific user
router.get('/:userId', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user!.userId;
    const otherUserId = parseIntParam(req.params.userId);
    if (!otherUserId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    // Check if the other user exists
    const otherUser = await prisma.user.findUnique({
      where: { id: otherUserId },
      select: { id: true, name: true, avatar: true, status: true },
    });

    if (!otherUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Guests can only view DM conversations with shared-channel members
    if (req.user!.role === 'GUEST' && currentUserId !== otherUserId) {
      if (!(await sharesChannel(currentUserId, otherUserId))) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
    }

    // Get messages between the two users
    const { limit, cursor } = parsePagination(req);
    const aroundRaw = req.query.around ? parseInt(req.query.around as string) : undefined;
    const around = aroundRaw !== undefined && !isNaN(aroundRaw) && aroundRaw > 0 ? aroundRaw : undefined;

    const dmWhere = {
      OR: [
        { fromUserId: currentUserId, toUserId: otherUserId },
        { fromUserId: otherUserId, toUserId: currentUserId },
      ],
      deletedAt: null,
      threadId: null, // Exclude thread replies from main conversation
    };

    const dmInclude = {
      ...DM_INCLUDE_USERS,
      _count: { select: { replies: { where: { deletedAt: null } } } },
      replies: {
        where: { deletedAt: null },
        select: {
          fromUser: { select: { id: true, name: true, avatar: true } },
        },
        distinct: ['fromUserId' as const],
        take: 5,
      },
    };

    const enrichDMMessages = (msgs: any[]) =>
      msgs.map((msg) => {
        const { replies, ...rest } = msg;
        const threadParticipants = replies
          ? replies.map((r: { fromUser: { id: number; name: string; avatar: string | null } }) => r.fromUser)
          : [];
        return { ...rest, threadParticipants };
      });

    let enrichedMessages: any[];
    let nextCursor: number | undefined;
    let hasMore: boolean;
    // 안 읽음 구분선 기준점(?withUnread=1, 첫 페이지만). 아래 읽음 처리(readAt)보다 먼저 계산해야 열기 직전 값이 된다.
    let unreadBaseline: { lastReadId: number | null; unreadCount: number } | undefined;

    if (around) {
      const half = Math.floor(limit / 2);
      const [before, target, after] = await Promise.all([
        prisma.directMessage.findMany({
          where: { ...dmWhere, id: { lt: around } },
          include: dmInclude,
          orderBy: { createdAt: 'desc' },
          take: half,
        }),
        prisma.directMessage.findMany({
          where: { ...dmWhere, id: around },
          include: dmInclude,
          take: 1,
        }),
        prisma.directMessage.findMany({
          where: { ...dmWhere, id: { gt: around } },
          include: dmInclude,
          orderBy: { createdAt: 'asc' },
          take: half,
        }),
      ]);
      enrichedMessages = enrichDMMessages([...before.reverse(), ...target, ...after]);
      nextCursor = undefined;
      hasMore = false;
    } else {
      const messagesQuery = prisma.directMessage.findMany({
        where: dmWhere,
        include: dmInclude,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(cursor && {
          cursor: { id: cursor },
          skip: 1,
        }),
      });
      const markRead = () => Promise.all([
        prisma.directMessage.updateMany({
          where: {
            fromUserId: otherUserId,
            toUserId: currentUserId,
            deletedAt: null,
            readAt: null,
          },
          data: {
            readAt: new Date(),
          },
        }).catch((err) => logError('DM read-status update failed', err)),
        markDmMentionsRead(currentUserId, otherUserId).catch((err) => logError('DM mention read update failed', err)),
      ]);
      let messages;
      if (req.query.withUnread === '1' && !cursor) {
        // 기준점 계산은 읽기 전용이라 메시지 조회와 병렬로 돌리고, 둘 다 끝난 뒤에 읽음 처리한다
        let baseline;
        [messages, baseline] = await Promise.all([messagesQuery, getDmUnreadBaseline(currentUserId, otherUserId)]);
        unreadBaseline = baseline;
        await markRead();
      } else {
        // Run message fetch and mark-read in parallel — saves one DB round-trip
        [messages] = await Promise.all([messagesQuery, markRead()]);
      }

      const paginated = paginateResults(messages, limit);
      enrichedMessages = enrichDMMessages(paginated.results);
      nextCursor = paginated.nextCursor;
      hasMore = paginated.hasMore;
    }

    res.json({
      user: otherUser,
      messages: enrichedMessages,
      nextCursor,
      hasMore,
      ...unreadBaseline,
    });
  } catch (error) {
    logError('Get DM conversation error', error);
    res.status(500).json({ error: 'Failed to get DM conversation' });
  }
});

// POST /dms/messages/:id/reply - Reply to a DM (creates thread)
router.post('/messages/:id/reply', authMiddleware, requireDmAccess, async (req: AuthRequest, res: Response) => {
  try {
    const parentId = req.dm.id;
    const fromUserId = req.user!.userId;
    const parentDm = req.dm;

    // Prevent nested threads
    if (parentDm.threadId !== null) {
      res.status(400).json({ error: 'Cannot reply to a reply. Reply to the parent message instead.' });
      return;
    }

    const replySchema = z.object({
      content: z.string().max(MAX_MESSAGE_LENGTH)
        .refine(val => !val.includes('\u0000'), { message: 'Content cannot contain null bytes' }),
      fileIds: z.array(z.number().int().positive()).max(10).optional(),
    }).refine(
      (data) => (data.content?.trim().length ?? 0) > 0 || (data.fileIds && data.fileIds.length > 0),
      { message: 'Reply must have content or file attachments' },
    );
    const { content, fileIds } = replySchema.parse(req.body);

    // 그룹 메시지의 답글은 같은 그룹으로 간다(멤버 여부는 requireDmAccess가 확인했다)
    if (parentDm.groupId !== null) {
      const groupReply = await sendGroupMessage({ groupId: parentDm.groupId, fromUserId, content, fileIds, threadId: parentId });
      res.status(201).json(groupReply);
      return;
    }

    // Reply goes to the same conversation (same from/to pair)
    const toUserId: number = parentDm.fromUserId === fromUserId ? parentDm.toUserId : parentDm.fromUserId;

    // Block replies to deactivated users (same check as POST /dms)
    if (fromUserId !== toUserId) {
      const recipient = await prisma.user.findUnique({
        where: { id: toUserId },
        select: { id: true, deactivatedAt: true },
      });
      if (!recipient || recipient.deactivatedAt) {
        res.status(400).json({ error: 'Unable to send message' });
        return;
      }

      // Guests can only reply to DMs with shared-channel members
      if (req.user!.role === 'GUEST') {
        if (!(await sharesChannel(fromUserId, toUserId))) {
          res.status(400).json({ error: 'Unable to send message' });
          return;
        }
      }
    }

    const reply = await prisma.$transaction(async (tx) => {
      const created = await tx.directMessage.create({
        data: {
          content,
          fromUserId,
          toUserId,
          threadId: parentId,
          // Self-DMs are auto-read
          ...(fromUserId === toUserId && { readAt: new Date() }),
        },
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

      return tx.directMessage.findUnique({
        where: { id: created.id },
        include: DM_INCLUDE_USERS,
      });
    });

    // Broadcast to both users so the thread updates in real-time
    const io = getIO();
    if (io) {
      const payload = { ...reply, threadId: parentId };
      io.to(`user:${fromUserId}`).emit('dm:reply', payload);
      if (fromUserId !== toUserId) {
        io.to(`user:${toUserId}`).emit('dm:reply', payload);
      }
    }

    // Push notification for DM thread reply (fire-and-forget)
    if (reply && fromUserId !== toUserId) {
      if (!isUserOnline(toUserId)) {
        const senderName = reply.fromUser?.name || 'Someone';
        sendPushToUser(toUserId, {
          titleKey: 'dmThread', sender: senderName, content, plainBody: true,
          url: `/d/${fromUserId}`,
        }, { kind: 'dm' }).catch((err) => logError('Push notification dispatch failed', err));
      }
    }

    res.status(201).json(reply);

    if (reply) void createActivitiesForDm({ ...reply, threadId: parentId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    if (error instanceof InvalidFileIdsError) {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }
    logError('DM reply error', error);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// GET /dms/messages/:id/thread - Get DM thread
router.get('/messages/:id/thread', authMiddleware, requireDmAccess, async (req: AuthRequest, res: Response) => {
  try {
    const parentId = req.dm.id;

    const parent = await prisma.directMessage.findUnique({
      where: { id: parentId },
      include: DM_INCLUDE_USERS,
    });

    if (!parent) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const replies = await prisma.directMessage.findMany({
      where: { threadId: parentId, deletedAt: null },
      include: DM_INCLUDE_USERS,
      orderBy: { createdAt: 'asc' },
    });

    res.json({ parent, replies });
  } catch (error) {
    logError('Get DM thread error', error);
    res.status(500).json({ error: 'Failed to get thread' });
  }
});

// PATCH /dms/messages/:id - Edit a direct message
router.patch('/messages/:id', authMiddleware, requireDmOwnership, async (req: AuthRequest, res: Response) => {
  try {
    const contentSchema = z.object({
      content: z.string().min(1).max(MAX_MESSAGE_LENGTH)
        .refine(val => !val.includes('\u0000'), { message: 'Content cannot contain null bytes' }),
    });
    const { content } = contentSchema.parse(req.body);

    // 다른 참여자에게 알리는 소켓 이벤트와 멘션 활동 갱신은 dmService가 한다
    res.json(await editDirectMessage(req.user!.userId, req.dm, content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logError('Edit DM error', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// DELETE /dms/messages/:id - Delete a direct message (soft delete)
router.delete('/messages/:id', authMiddleware, requireDmOwnership, async (req: AuthRequest, res: Response) => {
  try {
    await deleteDirectMessage(req.user!.userId, req.dm);
    res.json({ message: 'Message deleted successfully' });
  } catch (error) {
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logError('Delete DM error', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Matches either a Unicode emoji sequence or a shortcode (with or without colons)
const emojiShortcodeRegex = /^:?[a-z0-9_+-]+:?$/;
const unicodeEmojiRegex = /^(\p{Regional_Indicator}{2}|(\p{Extended_Pictographic})(\p{Emoji_Modifier}|\uFE0F|\u200d(\p{Extended_Pictographic}))*)+$/u;

const dmReactionSchema = z.object({
  emoji: z.string().min(1).max(32)
    .refine(val => unicodeEmojiRegex.test(val) || emojiShortcodeRegex.test(val), { message: 'Invalid emoji format' }),
});

// POST /dms/messages/:id/reactions - Add reaction to a DM
router.post('/messages/:id/reactions', authMiddleware, requireDmAccess, async (req: AuthRequest, res: Response) => {
  try {
    const dmId = req.dm.id;
    const userId = req.user!.userId;
    const { emoji } = dmReactionSchema.parse(req.body);

    const existing = await prisma.dMReaction.findUnique({
      where: { userId_dmId_emoji: { userId, dmId, emoji } },
    });

    if (existing) {
      res.status(400).json({ error: 'Reaction already exists' });
      return;
    }

    const reaction = await prisma.dMReaction.create({
      data: { emoji, userId, dmId },
      include: { user: { select: { id: true, name: true } } },
    });

    const dm = req.dm;
    void createReactionActivity({
      actorId: userId,
      targetUserId: dm.fromUserId,
      emoji,
      dmId,
      ...(dm.groupId !== null && { dmGroupId: dm.groupId }),
    });

    // Broadcast to both DM participants (그룹이면 멤버 전원)
    const io = getIO();
    if (dm.groupId !== null) {
      await emitToGroup(dm.groupId, 'dm:reaction:added', {
        dmId, groupId: dm.groupId, reaction: { id: reaction.id, emoji, userId, user: reaction.user },
      });
    } else if (io) {
      const payload = { dmId, reaction: { id: reaction.id, emoji, userId, user: reaction.user } };
      io.to(`user:${dm.fromUserId}`).emit('dm:reaction:added', payload);
      if (dm.fromUserId !== dm.toUserId) {
        io.to(`user:${dm.toUserId}`).emit('dm:reaction:added', payload);
      }
    }

    res.status(201).json(reaction);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Add DM reaction error', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// DELETE /dms/messages/:id/reactions/:emoji - Remove reaction from a DM
router.delete('/messages/:id/reactions/:emoji', authMiddleware, requireDmAccess, async (req: AuthRequest, res: Response) => {
  try {
    const dmId = req.dm.id;
    const userId = req.user!.userId;
    const rawEmoji = decodeURIComponent(req.params.emoji as string);

    if (!rawEmoji || rawEmoji.length > 32 || !(unicodeEmojiRegex.test(rawEmoji) || emojiShortcodeRegex.test(rawEmoji))) {
      res.status(400).json({ error: 'Invalid emoji format' });
      return;
    }

    const reaction = await prisma.dMReaction.findUnique({
      where: { userId_dmId_emoji: { userId, dmId, emoji: rawEmoji } },
    });

    if (!reaction) {
      res.status(404).json({ error: 'Reaction not found' });
      return;
    }

    await prisma.dMReaction.delete({ where: { id: reaction.id } });
    void removeReactionActivity({ actorId: userId, emoji: rawEmoji, dmId });

    const dm = req.dm;
    const io = getIO();
    if (dm.groupId !== null) {
      await emitToGroup(dm.groupId, 'dm:reaction:removed', { dmId, groupId: dm.groupId, emoji: rawEmoji, userId });
    } else if (io) {
      const payload = { dmId, emoji: rawEmoji, userId };
      io.to(`user:${dm.fromUserId}`).emit('dm:reaction:removed', payload);
      if (dm.fromUserId !== dm.toUserId) {
        io.to(`user:${dm.toUserId}`).emit('dm:reaction:removed', payload);
      }
    }

    res.json({ message: 'Reaction removed' });
  } catch (error) {
    logError('Remove DM reaction error', error);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

// POST /dms/:userId/read - Mark all messages from a user as read
router.post('/:userId/read', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user!.userId;
    const otherUserId = parseIntParam(req.params.userId);
    if (!otherUserId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: otherUserId },
      select: { id: true },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Guests can only interact with shared-channel members
    if (req.user!.role === 'GUEST' && currentUserId !== otherUserId) {
      if (!(await sharesChannel(currentUserId, otherUserId))) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
    }

    // Mark all unread messages from the other user as read
    const result = await prisma.directMessage.updateMany({
      where: {
        fromUserId: otherUserId,
        toUserId: currentUserId,
        deletedAt: null,
        readAt: null,
      },
      data: {
        readAt: new Date(),
      },
    });

    await markDmMentionsRead(currentUserId, otherUserId).catch((err) => logError('DM mention read update failed', err));

    res.json({ markedAsRead: result.count });
  } catch (error) {
    logError('Mark DMs as read error', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// POST /dms/:userId/unread - Mark DM conversation as unread from a specific message
const markDmUnreadSchema = z.object({
  messageId: z.number().int().positive(),
});

router.post('/:userId/unread', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user!.userId;
    const otherUserId = parseIntParam(req.params.userId);
    if (!otherUserId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    const { messageId } = markDmUnreadSchema.parse(req.body);

    // Guests can only interact with shared-channel members
    if (req.user!.role === 'GUEST') {
      if (!(await sharesChannel(currentUserId, otherUserId))) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
    }

    // Verify the message belongs to this DM conversation
    const targetMessage = await prisma.directMessage.findFirst({
      where: {
        id: messageId,
        fromUserId: otherUserId,
        toUserId: currentUserId,
        deletedAt: null,
      },
    });
    if (!targetMessage) {
      res.status(404).json({ error: 'Message not found in this conversation' });
      return;
    }

    // Set readAt to null on messages from the other user starting from messageId
    const result = await prisma.directMessage.updateMany({
      where: {
        fromUserId: otherUserId,
        toUserId: currentUserId,
        deletedAt: null,
        id: { gte: messageId },
      },
      data: {
        readAt: null,
      },
    });

    res.json({ markedAsUnread: result.count });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Mark DMs as unread error', error);
    res.status(500).json({ error: 'Failed to mark messages as unread' });
  }
});

// POST /dms/messages/:id/pin - Pin a DM
router.post('/messages/:id/pin', authMiddleware, requireDmAccess, async (req: AuthRequest, res: Response) => {
  try {
    const dmId = parseIntParam(req.params.id);
    if (!dmId) { res.status(400).json({ error: 'Invalid message ID' }); return; }
    const userId = req.user!.userId;

    const updated = await prisma.directMessage.update({
      where: { id: dmId },
      data: { isPinned: true, pinnedBy: userId, pinnedAt: new Date() },
      include: DM_INCLUDE_USERS,
    });

    // Broadcast to both participants
    const io = getIO();
    if (updated.groupId !== null) {
      await emitToGroup(updated.groupId, 'dm:updated', updated);
    } else if (io) {
      const room1 = `dm:${updated.fromUserId}:${updated.toUserId}`;
      const room2 = `dm:${updated.toUserId}:${updated.fromUserId}`;
      io.to(room1).to(room2).emit('dm:updated', updated);
    }

    res.json(updated);
  } catch (error) {
    logError('Pin DM error', error);
    res.status(500).json({ error: 'Failed to pin message' });
  }
});

// DELETE /dms/messages/:id/pin - Unpin a DM
router.delete('/messages/:id/pin', authMiddleware, requireDmAccess, async (req: AuthRequest, res: Response) => {
  try {
    const dmId = parseIntParam(req.params.id);
    if (!dmId) { res.status(400).json({ error: 'Invalid message ID' }); return; }

    const updated = await prisma.directMessage.update({
      where: { id: dmId },
      data: { isPinned: false, pinnedBy: null, pinnedAt: null },
      include: DM_INCLUDE_USERS,
    });

    const io = getIO();
    if (updated.groupId !== null) {
      await emitToGroup(updated.groupId, 'dm:updated', updated);
    } else if (io) {
      const room1 = `dm:${updated.fromUserId}:${updated.toUserId}`;
      const room2 = `dm:${updated.toUserId}:${updated.fromUserId}`;
      io.to(room1).to(room2).emit('dm:updated', updated);
    }

    res.json(updated);
  } catch (error) {
    logError('Unpin DM error', error);
    res.status(500).json({ error: 'Failed to unpin message' });
  }
});

// GET /dms/:userId/pins - Get pinned messages in a DM conversation
router.get('/:userId/pins', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const currentUserId = req.user!.userId;
    const otherUserId = parseIntParam(req.params.userId);
    if (!otherUserId) { res.status(400).json({ error: 'Invalid user ID' }); return; }

    // Guests can only view pins with shared-channel members
    if (req.user!.role === 'GUEST' && currentUserId !== otherUserId) {
      if (!(await sharesChannel(currentUserId, otherUserId))) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
    }

    const pinned = await prisma.directMessage.findMany({
      where: {
        isPinned: true,
        deletedAt: null,
        OR: [
          { fromUserId: currentUserId, toUserId: otherUserId },
          { fromUserId: otherUserId, toUserId: currentUserId },
        ],
      },
      include: DM_INCLUDE_USERS,
      orderBy: { pinnedAt: 'desc' },
    });

    res.json(pinned);
  } catch (error) {
    logError('Get pinned DMs error', error);
    res.status(500).json({ error: 'Failed to get pinned messages' });
  }
});

export default router;
