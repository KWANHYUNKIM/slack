import { Router, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { getIO } from '../websocket/index.js';
import { MESSAGE_INCLUDE_WITH_FILES } from '../db/selects.js';

const router = Router();

// Validation schemas
const createWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  channelId: z.number().int().positive(),
});

const incomingWebhookSchema = z.object({
  content: z.string().min(1).max(40000),
});

// POST /webhooks - Create a new webhook (admin only)
router.post('/', authMiddleware, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, channelId } = createWebhookSchema.parse(req.body);
    const userId = req.user!.userId;

    // Verify channel exists and is not archived
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, name: true, archivedAt: true },
    });

    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    if (channel.archivedAt) {
      res.status(403).json({ error: 'Cannot create webhook for archived channel' });
      return;
    }

    // Generate secure random token
    const token = crypto.randomBytes(32).toString('hex');

    const webhook = await prisma.webhook.create({
      data: {
        name,
        channelId,
        token,
        createdBy: userId,
      },
      include: {
        channel: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    await writeAuditLog({
      action: 'webhook.created',
      actorId: userId,
      targetType: 'webhook',
      targetId: webhook.id,
      targetName: webhook.name,
      details: `Channel: ${channel.name}`,
    });

    res.status(201).json(webhook);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Create webhook error', error);
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

// GET /webhooks - List webhooks (admin only, optionally filtered by channelId)
router.get('/', authMiddleware, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const channelIdRaw = req.query.channelId as string | undefined;
    const channelId = channelIdRaw ? parseInt(channelIdRaw, 10) : undefined;

    const webhooks = await prisma.webhook.findMany({
      where: channelId ? { channelId } : undefined,
      include: {
        channel: { select: { id: true, name: true } },
        creator: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(webhooks);
  } catch (error) {
    logError('List webhooks error', error);
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

// DELETE /webhooks/:id - Delete a webhook (admin only)
router.delete('/:id', authMiddleware, requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const webhookId = parseIntParam(req.params.id);
    if (!webhookId) {
      res.status(400).json({ error: 'Invalid webhook ID' });
      return;
    }

    const webhook = await prisma.webhook.findUnique({
      where: { id: webhookId },
      include: {
        channel: { select: { name: true } },
      },
    });

    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    await prisma.webhook.delete({
      where: { id: webhookId },
    });

    await writeAuditLog({
      action: 'webhook.deleted',
      actorId: req.user!.userId,
      targetType: 'webhook',
      targetId: webhookId,
      targetName: webhook.name,
      details: `Channel: ${webhook.channel.name}`,
    });

    res.json({ message: 'Webhook deleted' });
  } catch (error) {
    logError('Delete webhook error', error);
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

// POST /webhooks/:token - Incoming webhook endpoint (no auth, uses token)
router.post('/:token', async (req, res: Response) => {
  try {
    const token = req.params.token;
    const { content } = incomingWebhookSchema.parse(req.body);

    // Find webhook by token
    const webhook = await prisma.webhook.findUnique({
      where: { token },
      include: {
        channel: { select: { id: true, name: true, archivedAt: true } },
        creator: { select: { id: true, name: true } },
      },
    });

    if (!webhook || !webhook.isActive) {
      res.status(403).json({ error: 'Invalid or inactive webhook' });
      return;
    }

    if (webhook.channel.archivedAt) {
      res.status(403).json({ error: 'Channel is archived' });
      return;
    }

    // Create message attributed to webhook creator
    const finalMessage = await prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          content,
          userId: webhook.createdBy,
          channelId: webhook.channelId,
        },
      });

      // Update webhook lastUsedAt
      await tx.webhook.update({
        where: { id: webhook.id },
        data: { lastUsedAt: new Date() },
      });

      return tx.message.findUnique({
        where: { id: msg.id },
        include: MESSAGE_INCLUDE_WITH_FILES,
      });
    });

    // Broadcast via WebSocket
    const io = getIO();
    if (io && finalMessage) {
      io.to(`channel:${webhook.channelId}`).emit('message:new', finalMessage);
    }

    res.status(201).json({ message: 'Message sent', messageId: finalMessage?.id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Incoming webhook error', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

export default router;
