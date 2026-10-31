import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { channelTimelineWhere } from '../db/timeline.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireChannelMembership, requirePublicChannelReadAccess } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { USER_SELECT_BASIC, FILE_SELECT, MESSAGE_INCLUDE_FULL, MESSAGE_INCLUDE_WITH_FILES } from '../db/selects.js';
import { parsePagination, paginateResults } from '../utils/pagination.js';
import { logError } from '../utils/logger.js';
import { ServiceError, messageContentSchema, sendChannelMessage } from '../services/messageService.js';
import { PARENT_EXCERPT_INCLUDE, blankIfDeleted, toParentExcerpt, withParentExcerpt, onThreadReplyCreated } from '../services/threadService.js';

const router = Router();

const createMessageSchema = z.object({
  content: messageContentSchema,
  threadId: z.number().int().positive().optional(),
  alsoSendToChannel: z.boolean().optional(),
  fileIds: z.array(z.number().int().positive()).max(10).optional(),
}).refine(
  (data) => (data.content?.trim().length ?? 0) > 0 || (data.fileIds && data.fileIds.length > 0),
  { message: 'Message must have content or file attachments' },
);

// POST /channels/:id/messages - Send message
router.post('/:id/messages', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const input = createMessageSchema.parse(req.body);
    // 보관 채널·스레드 검증, 저장, 소켓 이벤트, 멘션 활동·푸시는 MCP 쓰기 도구와 같은 서비스가 처리한다
    const message = await sendChannelMessage(req.user!.userId, req.channelId!, input);
    res.status(201).json(message);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logError('Send message error', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// GET /channels/:id/messages - Get messages (paginated)
router.get('/:id/messages', authMiddleware, requirePublicChannelReadAccess, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const { limit, cursor } = parsePagination(req);
    const aroundRaw = req.query.around ? parseInt(req.query.around as string) : undefined;
    const around = aroundRaw !== undefined && !isNaN(aroundRaw) && aroundRaw > 0 ? aroundRaw : undefined;

    // 채널 타임라인: 최상위 메시지 + "채널에도 보내기" 답글 + 답글이 남은 삭제된 부모(자리표시자)
    const timelineWhere = channelTimelineWhere(channelId);

    const messageInclude = {
      ...MESSAGE_INCLUDE_FULL,
      ...PARENT_EXCERPT_INCLUDE,
      replies: {
        select: {
          user: {
            select: { id: true, name: true, avatar: true },
          },
        },
        distinct: ['userId' as const],
        take: 5,
      },
    };

    const enrichMessages = (msgs: any[]) =>
      msgs.map((msg) => {
        const { replies, parent, ...rest } = msg;
        const threadParticipants = replies
          ? replies.map((r: { user: { id: number; name: string; avatar: string | null } }) => r.user)
          : [];
        return { ...blankIfDeleted(rest), parent: toParentExcerpt(parent), threadParticipants };
      });

    // "around" mode: fetch messages surrounding a target message ID
    if (around) {
      const half = Math.floor(limit / 2);
      const [before, target, after] = await Promise.all([
        prisma.message.findMany({
          where: { ...timelineWhere, id: { lt: around } },
          include: messageInclude,
          orderBy: { createdAt: 'desc' },
          take: half,
        }),
        prisma.message.findMany({
          where: { ...timelineWhere, id: around },
          include: messageInclude,
          take: 1,
        }),
        prisma.message.findMany({
          where: { ...timelineWhere, id: { gt: around } },
          include: messageInclude,
          orderBy: { createdAt: 'asc' },
          take: half,
        }),
      ]);
      const combined = [...before.reverse(), ...target, ...after];
      res.json({
        messages: enrichMessages(combined),
        nextCursor: undefined,
        hasMore: false,
      });
      return;
    }

    const messages = await prisma.message.findMany({
      where: timelineWhere,
      include: messageInclude,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor && {
        cursor: { id: cursor },
        skip: 1,
      }),
    });

    const { results: resultMessages, nextCursor, hasMore } = paginateResults(messages, limit);

    res.json({
      messages: enrichMessages(resultMessages),
      nextCursor,
      hasMore,
    });
  } catch (error) {
    logError('Get messages error', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

export default router;
