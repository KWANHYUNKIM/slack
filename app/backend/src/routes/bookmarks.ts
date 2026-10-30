import { Router, Response } from 'express';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireMessageAccess } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { USER_SELECT_BASIC, FILE_SELECT } from '../db/selects.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';

const router = Router();

// POST /messages/:id/bookmark - Bookmark a message
router.post('/:id/bookmark', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    const messageId = parseIntParam(req.params.id)!;
    const userId = req.user!.userId;

    const existing = await prisma.bookmark.findUnique({
      where: { userId_messageId: { userId, messageId } },
    });

    if (existing) {
      res.status(400).json({ error: 'Already bookmarked' });
      return;
    }

    const bookmark = await prisma.bookmark.create({
      data: { userId, messageId },
    });

    res.status(201).json(bookmark);
  } catch (error) {
    logError('Add bookmark error', error);
    res.status(500).json({ error: 'Failed to add bookmark' });
  }
});

// DELETE /messages/:id/bookmark - Remove bookmark
router.delete('/:id/bookmark', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    const messageId = parseIntParam(req.params.id)!;
    const userId = req.user!.userId;

    const bookmark = await prisma.bookmark.findUnique({
      where: { userId_messageId: { userId, messageId } },
    });

    if (!bookmark) {
      res.status(404).json({ error: 'Bookmark not found' });
      return;
    }

    await prisma.bookmark.delete({
      where: { id: bookmark.id },
    });

    res.json({ message: 'Bookmark removed' });
  } catch (error) {
    logError('Remove bookmark error', error);
    res.status(500).json({ error: 'Failed to remove bookmark' });
  }
});

// GET /bookmarks - Get all bookmarked message IDs for the current user
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    // Get channels the user is a member of to filter bookmarks
    const memberChannelIds = (await prisma.channelMember.findMany({
      where: { userId },
      select: { channelId: true },
    })).map(m => m.channelId);

    const bookmarks = await prisma.bookmark.findMany({
      where: {
        userId,
        message: {
          channelId: { in: memberChannelIds },
          deletedAt: null,
        },
      },
      include: {
        message: {
          include: {
            user: { select: USER_SELECT_BASIC },
            files: { select: FILE_SELECT },
            channel: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const result = bookmarks.map((b) => ({
      messageId: b.messageId,
      createdAt: b.createdAt,
      message: b.message,
    }));

    res.json(result);
  } catch (error) {
    logError('Get bookmarks error', error);
    res.status(500).json({ error: 'Failed to get bookmarks' });
  }
});

export default router;
