import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { getVapidPublicKey } from '../services/pushService.js';
import { logError } from '../utils/logger.js';

const router = Router();

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
});

// GET /push/vapid-key — public, returns VAPID public key
router.get('/vapid-key', (_req, res: Response) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(404).json({ error: 'Push notifications not configured' });
    return;
  }
  res.json({ vapidPublicKey: key });
});

// POST /push/subscribe — authenticated, upserts subscription
router.post('/subscribe', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { endpoint, keys } = subscribeSchema.parse(req.body);

    await prisma.pushSubscription.upsert({
      where: { userId_endpoint: { userId, endpoint } },
      create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
      update: { p256dh: keys.p256dh, auth: keys.auth },
    });

    res.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Push subscribe error', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// DELETE /push/subscribe — authenticated, removes subscription
router.delete('/subscribe', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { endpoint } = z.object({ endpoint: z.string().url().max(2048) }).parse(req.body);

    await prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });

    res.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Push unsubscribe error', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

export default router;
