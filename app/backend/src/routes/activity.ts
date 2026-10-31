import { Router, Response } from 'express';
import { z } from 'zod';
import type { ActivityType } from '@prisma/client';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { paginateResults } from '../utils/pagination.js';
import { logError } from '../utils/logger.js';
import {
  MENTION_TYPES,
  markActivitiesRead,
  serializeActivities,
  visibleActivityWhere,
} from '../services/mentionService.js';

const router = Router();

const TYPE_FILTERS: Record<string, ActivityType[] | undefined> = {
  all: undefined,
  mentions: MENTION_TYPES,
  threads: ['THREAD_REPLY'],
  reactions: ['REACTION'],
};

const listQuerySchema = z.object({
  type: z.enum(['all', 'mentions', 'threads', 'reactions']).default('all'),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();

const readBodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200).optional(),
  all: z.boolean().optional(),
}).strict().refine((d) => d.all === true || (d.ids && d.ids.length > 0), {
  message: 'Provide ids or all: true',
});

// GET /activity - 내 활동 목록(최신순, 커서 페이지네이션). 항상 요청자 본인의 활동만 돌려준다.
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { type, cursor, limit } = listQuerySchema.parse(req.query);
    const types = TYPE_FILTERS[type];

    const rows = await prisma.activity.findMany({
      where: {
        ...(await visibleActivityWhere(userId)),
        ...(types && { type: { in: types } }),
        // 커서 행이 지워져도 다음 페이지가 나오도록 cursor+skip 대신 id 비교를 쓴다
        ...(cursor && { id: { lt: cursor } }),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const { results, nextCursor } = paginateResults(rows, limit);

    res.json({ items: await serializeActivities(results), nextCursor: nextCursor ?? null });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid query', details: error.issues });
      return;
    }
    logError('List activity error', error);
    res.status(500).json({ error: 'Failed to list activity' });
  }
});

// GET /activity/unread-count - 사이드바 배지용
router.get('/unread-count', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const where = { ...(await visibleActivityWhere(req.user!.userId)), readAt: null };
    const [total, mentions] = await Promise.all([
      prisma.activity.count({ where }),
      prisma.activity.count({ where: { ...where, type: { in: MENTION_TYPES } } }),
    ]);
    res.json({ total, mentions });
  } catch (error) {
    logError('Activity unread count error', error);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// GET /activity/mention-counts - 채널별/DM 상대별 안 읽은 멘션 수. 활동이 읽힘/삭제될 때 사이드바 배지를 가볍게 맞추는 용도
router.get('/mention-counts', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const where = { ...(await visibleActivityWhere(req.user!.userId)), readAt: null, type: { in: MENTION_TYPES } };
    const [channelRows, dmRows] = await Promise.all([
      prisma.activity.groupBy({ by: ['channelId'], where: { ...where, channelId: { not: null } }, _count: { _all: true } }),
      prisma.activity.groupBy({ by: ['actorId'], where: { ...where, dmId: { not: null } }, _count: { _all: true } }),
    ]);
    res.json({
      channels: Object.fromEntries(channelRows.map((r) => [r.channelId as number, r._count._all])),
      dms: Object.fromEntries(dmRows.map((r) => [r.actorId, r._count._all])),
    });
  } catch (error) {
    logError('Activity mention counts error', error);
    res.status(500).json({ error: 'Failed to get mention counts' });
  }
});

// POST /activity/read - 일부(ids) 또는 전부(all) 읽음 처리. 남의 활동 id는 조용히 무시된다.
router.post('/read', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { ids, all } = readBodySchema.parse(req.body);
    const updated = await markActivitiesRead(req.user!.userId, { ids, all });
    res.json({ updated: updated.length, ids: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid body', details: error.issues });
      return;
    }
    logError('Mark activity read error', error);
    res.status(500).json({ error: 'Failed to mark activity as read' });
  }
});

export default router;
