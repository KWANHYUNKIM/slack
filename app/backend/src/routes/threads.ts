import { Router, Response } from 'express';
import { z } from 'zod';
import { MAX_MESSAGE_LENGTH } from '../utils/params.js';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireMessageAccess, requireThreadReadAccess, canAccessDm, canReadChannel } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { getIO } from '../websocket/index.js';
import { USER_SELECT_BASIC, MESSAGE_INCLUDE_FULL, MESSAGE_INCLUDE_WITH_FILES, THREAD_REPLY_INCLUDE } from '../db/selects.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { isUserOnline } from '../websocket/index.js';
import { sendPushToUser } from '../services/pushService.js';
import { blankIfDeleted, PARENT_EXCERPT_INCLUDE, withParentExcerpt, onThreadReplyCreated, setReplyBroadcast } from '../services/threadService.js';
import { processNewChannelMessage, markThreadMentionsRead } from '../services/mentionService.js';
import { ServiceError, editChannelMessage, deleteChannelMessage } from '../services/messageService.js';

const router = Router();

const replySchema = z.object({
  content: z.string().min(1).max(MAX_MESSAGE_LENGTH)
    .refine(val => !val.includes('\u0000'), { message: 'Content cannot contain null bytes' }),
  alsoSendToChannel: z.boolean().optional(),
  fileIds: z.array(z.number().int().positive()).max(10).optional(),
});

const editMessageSchema = z.object({
  content: z.string().min(1).max(MAX_MESSAGE_LENGTH)
    .refine(val => !val.includes('\u0000'), { message: 'Content cannot contain null bytes' }),
});

// POST /messages/:id/reply - Reply to message (creates thread)
router.post('/:id/reply', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    const parentId = parseIntParam(req.params.id)!;
    const userId = req.user!.userId;
    const { content, fileIds, alsoSendToChannel } = replySchema.parse(req.body);
    const parentMessage = req.message;

    // Prevent nested threads - cannot reply to a reply
    if (parentMessage.threadId !== null) {
      res.status(400).json({ error: 'Cannot reply to a reply. Reply to the parent message instead.' });
      return;
    }

    // Block replies in archived channels
    const channel = await prisma.channel.findUnique({
      where: { id: parentMessage.channelId },
      select: { archivedAt: true },
    });
    if (channel?.archivedAt) {
      res.status(403).json({ error: 'This channel has been archived' });
      return;
    }

    const reply = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          content,
          userId,
          channelId: parentMessage.channelId,
          threadId: parentId,
          alsoSendToChannel: !!alsoSendToChannel,
        },
      });

      if (fileIds && fileIds.length > 0) {
        const updated = await tx.file.updateMany({
          where: { id: { in: fileIds }, userId, messageId: null, dmId: null },
          data: { messageId: msg.id },
        });
        if (updated.count !== fileIds.length) {
          throw new Error('Invalid file IDs or files already attached');
        }
      }

      return tx.message.findUnique({
        where: { id: msg.id },
        include: { ...THREAD_REPLY_INCLUDE, ...PARENT_EXCERPT_INCLUDE },
      });
    }).then((m) => (m ? withParentExcerpt(m) : m));

    // Broadcast to channel so other users see the thread count update
    const io = getIO();
    if (io && reply) {
      io.to(`channel:${parentMessage.channelId}`).emit('message:new', { ...reply, threadId: parentId });
    }

    res.status(201).json(reply);

    // 응답 뒤에: 스레드 답글·멘션 활동과 푸시(await하지 않는다)
    if (reply) {
      void processNewChannelMessage(reply);
      void onThreadReplyCreated(reply);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Reply error', error);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// GET /messages/:id/thread - Get thread messages
router.get('/:id/thread', authMiddleware, requireThreadReadAccess, async (req: AuthRequest, res: Response) => {
  try {
    const parentId = parseIntParam(req.params.id)!;

    // Re-fetch parent with user details for the response
    const parentMessage = await prisma.message.findUnique({
      where: { id: parentId },
      include: THREAD_REPLY_INCLUDE,
    });

    if (!parentMessage) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const replies = await prisma.message.findMany({
      where: { threadId: parentId, deletedAt: null },
      include: THREAD_REPLY_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    // 스레드를 열었으니 이 스레드 답글에 달린 내 멘션을 읽음 처리한다
    markThreadMentionsRead(req.user!.userId, parentId).catch((err) => logError('Mark thread mentions read failed', err));

    res.json({
      parent: blankIfDeleted(parentMessage),
      replies,
    });
  } catch (error) {
    logError('Get thread error', error);
    res.status(500).json({ error: 'Failed to get thread' });
  }
});

// PATCH /messages/:id - Edit message
router.patch('/:id', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    const { content } = editMessageSchema.parse(req.body);
    res.json(await editChannelMessage(req.user!.userId, req.message, content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logError('Edit message error', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// DELETE /messages/:id - Soft delete message
router.delete('/:id', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    await deleteChannelMessage(req.user!.userId, req.message);
    res.json({ message: 'Message deleted successfully' });
  } catch (error) {
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logError('Delete message error', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// POST /messages/:id/broadcast - 답글을 채널에도 보내기 (사후 켜기)
// DELETE /messages/:id/broadcast - 채널에서 답글 복사본 지우기 (스레드 답글은 남는다)
for (const [method, value] of [['post', true], ['delete', false]] as const) {
  router[method]('/:id/broadcast', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
    try {
      const result = await setReplyBroadcast(req.message, req.user!.userId, value);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result.message);
    } catch (error) {
      logError('Toggle broadcast error', error);
      res.status(500).json({ error: 'Failed to update reply broadcast' });
    }
  });
}

// POST /messages/:id/pin - Pin a message
router.post('/:id/pin', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    const messageId = parseIntParam(req.params.id)!;
    const userId = req.user!.userId;
    const message = req.message;

    // Block pinning in archived channels
    const pinChannel = await prisma.channel.findUnique({
      where: { id: message.channelId },
      select: { archivedAt: true },
    });
    if (pinChannel?.archivedAt) {
      res.status(403).json({ error: 'This channel has been archived' });
      return;
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { isPinned: true, pinnedBy: userId, pinnedAt: new Date() },
      include: MESSAGE_INCLUDE_FULL,
    });

    // Broadcast the updated message to all users in the channel
    const io = getIO();
    if (io) {
      io.to(`channel:${updated.channelId}`).emit('message:updated', updated);
    }

    res.json(updated);
  } catch (error) {
    logError('Pin message error', error);
    res.status(500).json({ error: 'Failed to pin message' });
  }
});

// DELETE /messages/:id/pin - Unpin a message
router.delete('/:id/pin', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    const messageId = parseIntParam(req.params.id)!;
    const userId = req.user!.userId;
    const message = req.message;

    // Block unpinning in archived channels
    const unpinChannel = await prisma.channel.findUnique({
      where: { id: message.channelId },
      select: { archivedAt: true },
    });
    if (unpinChannel?.archivedAt) {
      res.status(403).json({ error: 'This channel has been archived' });
      return;
    }

    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { isPinned: false, pinnedBy: null, pinnedAt: null },
      include: MESSAGE_INCLUDE_FULL,
    });

    // Broadcast the updated message to all users in the channel
    const io = getIO();
    if (io) {
      io.to(`channel:${updated.channelId}`).emit('message:updated', updated);
    }

    res.json(updated);
  } catch (error) {
    logError('Unpin message error', error);
    res.status(500).json({ error: 'Failed to unpin message' });
  }
});

// GET /messages/:id/locate?kind=channel|dm - 퍼말링크의 메시지가 어느 대화에 있는지 알려 준다.
// 메시지가 없거나 삭제됐거나 볼 권한이 없으면 모두 같은 404로 답해 존재 여부를 숨긴다.
// channel(기본)은 Message, dm은 DirectMessage 테이블이다(두 테이블의 id는 서로 독립이다).
router.get('/:id/locate', authMiddleware, async (req: AuthRequest, res: Response) => {
  const notFound = () => res.status(404).json({ error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
  try {
    const messageId = parseIntParam(req.params.id);
    const kind = req.query.kind === 'dm' ? 'dm' : req.query.kind === undefined || req.query.kind === 'channel' ? 'channel' : null;
    if (!messageId || !kind) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const userId = req.user!.userId;

    if (kind === 'dm') {
      const dm = await prisma.directMessage.findUnique({
        where: { id: messageId },
        select: { id: true, fromUserId: true, toUserId: true, groupId: true, threadId: true, deletedAt: true },
      });
      if (!dm || dm.deletedAt || !(await canAccessDm(dm, userId))) return notFound();
      // 1:1 DM의 주소는 상대방 id다
      const dmUserId = dm.groupId === null ? (dm.fromUserId === userId ? dm.toUserId : dm.fromUserId) : undefined;
      res.json({
        messageId: dm.id,
        ...(dm.groupId !== null ? { groupId: dm.groupId } : { dmUserId }),
        ...(dm.threadId !== null && { parentId: dm.threadId }),
      });
      return;
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, channelId: true, threadId: true, deletedAt: true },
    });
    if (!message) return notFound();
    // 삭제됐어도 살아 있는 답글이 남은 부모는 자리표시자로 열 수 있다. 그 외 삭제 메시지는 404.
    const deleted = !!message.deletedAt;
    if (deleted) {
      const liveReplies = message.threadId === null
        ? await prisma.message.count({ where: { threadId: message.id, deletedAt: null } })
        : 0;
      if (liveReplies === 0) return notFound();
    }
    const access = await canReadChannel(userId, req.user!.role, message.channelId);
    if (!access.exists || !access.allowed) return notFound();
    res.json({
      messageId: message.id,
      channelId: message.channelId,
      ...(message.threadId !== null && { parentId: message.threadId }),
      ...(deleted && { deleted: true }),
    });
  } catch (error) {
    logError('Locate message error', error);
    res.status(500).json({ error: 'Failed to locate message' });
  }
});

// GET /channels/:channelId/pins - Get pinned messages (mounted on /channels)
// NOTE: This is added in channels routes

export default router;
