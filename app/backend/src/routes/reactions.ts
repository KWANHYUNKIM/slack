import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireMessageAccess } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { ServiceError, addMessageReaction, removeMessageReaction, isValidEmoji, reactionEmojiSchema } from '../services/messageService.js';

const router = Router();

const reactionSchema = z.object({ emoji: reactionEmojiSchema });

// POST /messages/:id/reactions - Add reaction to message
router.post('/:id/reactions', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    const { emoji } = reactionSchema.parse(req.body);
    res.status(201).json(await addMessageReaction(req.user!.userId, req.message, emoji));
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logError('Add reaction error', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// DELETE /messages/:id/reactions/:emoji - Remove reaction from message
router.delete('/:id/reactions/:emoji', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    const rawEmoji = decodeURIComponent(req.params.emoji as string);
    // 보관 채널 검사가 이모지 형식 검사보다 먼저 응답하던 기존 순서는 서비스로 옮기면서 형식 검사가 앞선다(둘 다 4xx)
    if (!isValidEmoji(rawEmoji)) {
      res.status(400).json({ error: 'Invalid emoji format' });
      return;
    }
    await removeMessageReaction(req.user!.userId, req.message, rawEmoji);
    res.json({ message: 'Reaction removed' });
  } catch (error) {
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logError('Remove reaction error', error);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

// GET /messages/:id/reactions - Get all reactions for a message
router.get('/:id/reactions', authMiddleware, requireMessageAccess, async (req: AuthRequest, res: Response) => {
  try {
    const messageId = parseIntParam(req.params.id)!;

    const reactions = await prisma.reaction.findMany({
      where: { messageId },
      include: {
        user: {
          select: { id: true, name: true, avatar: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group reactions by emoji
    const grouped = reactions.reduce((acc, reaction) => {
      if (!acc[reaction.emoji]) {
        acc[reaction.emoji] = {
          emoji: reaction.emoji,
          count: 0,
          users: [],
        };
      }
      acc[reaction.emoji].count++;
      acc[reaction.emoji].users.push(reaction.user);
      return acc;
    }, {} as Record<string, { emoji: string; count: number; users: any[] }>);

    res.json(Object.values(grouped));
  } catch (error) {
    logError('Get reactions error', error);
    res.status(500).json({ error: 'Failed to get reactions' });
  }
});

export default router;
