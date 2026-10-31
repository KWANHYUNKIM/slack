import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requireThreadReadAccess } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { parsePagination } from '../utils/pagination.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { listThreads, countUnreadThreads, markThreadRead } from '../services/threadService.js';
import { markThreadMentionsRead } from '../services/mentionService.js';

// 내가 참여한 스레드 모아보기. /messages 아래의 routes/threads.ts(답글·편집·삭제)와 경로가 겹치지 않는다.
const router = Router();

const readSchema = z.object({
  lastReadReplyId: z.number().int().positive().optional(),
});

// GET /threads - 참여한 스레드 목록 (마지막 답글 순, 커서 기반)
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { limit, cursor } = parsePagination(req);
    res.json(await listThreads(req.user!.userId, limit, cursor));
  } catch (error) {
    logError('List threads error', error);
    res.status(500).json({ error: 'Failed to list threads' });
  }
});

// GET /threads/unread-count - 안 읽은 답글이 있는 스레드 수
router.get('/unread-count', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ count: await countUnreadThreads(req.user!.userId) });
  } catch (error) {
    logError('Thread unread count error', error);
    res.status(500).json({ error: 'Failed to count unread threads' });
  }
});

// POST /threads/:id/read - 스레드 읽음 처리 (:id는 부모 메시지 id)
router.post('/:id/read', authMiddleware, requireThreadReadAccess, async (req: AuthRequest, res: Response) => {
  try {
    const parentId = parseIntParam(req.params.id)!;
    const userId = req.user!.userId;
    if (!req.isChannelMember) {
      res.status(403).json({ error: 'You must be a member of this channel' });
      return;
    }
    if (req.message.threadId !== null) {
      res.status(400).json({ error: 'Not a thread parent message' });
      return;
    }
    const { lastReadReplyId } = readSchema.parse(req.body ?? {});
    const result = await markThreadRead(userId, parentId, lastReadReplyId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    // 스레드를 읽었으니 그 답글에 달린 내 멘션 활동도 읽음 처리한다
    markThreadMentionsRead(userId, parentId).catch((err) => logError('Mark thread mentions read failed', err));
    res.json({ success: true, lastReadReplyId: result.lastReadReplyId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Mark thread read error', error);
    res.status(500).json({ error: 'Failed to mark thread read' });
  }
});

export default router;
