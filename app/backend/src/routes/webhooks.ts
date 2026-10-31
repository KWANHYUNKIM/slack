import { ServiceError, serviceErrorBody } from '../services/messageService.js';
import { enforceDlp, recordDlpWarnings } from '../services/dlpService.js';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireDefaultWorkspaceAdmin } from '../middleware/adminAuth.js';
import { DEFAULT_WORKSPACE_ID } from '../services/workspaceService.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { getIO } from '../websocket/index.js';
import { MESSAGE_INCLUDE_WITH_FILES } from '../db/selects.js';
import { processNewChannelMessage } from '../services/mentionService.js';
import rateLimit from 'express-rate-limit';

const router = Router();

// 웹훅 토큰 하나당 분당 60회. 공개 엔드포인트라 토큰 단위로 묶어 한 웹훅이 다른 웹훅 채널을 막지 않게 한다.
// 테스트 환경에서도 켜 둔다(제한 동작을 테스트로 확인하려고).
const webhookSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  keyGenerator: (req) => `webhook:${req.params.token}`,
});

// 웹훅 관리는 /admin과 같은 기본 워크스페이스 범위다(E1c). 다른 워크스페이스 채널의 웹훅은 없는 것으로 답한다.
const managedChannelWhere = { workspaces: { some: { workspaceId: DEFAULT_WORKSPACE_ID } } };

// Validation schemas
const createWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  channelId: z.number().int().positive(),
});

const incomingWebhookSchema = z.object({
  content: z.string().min(1).max(40000),
});

// POST /webhooks - Create a new webhook (admin only)
router.post('/', authMiddleware, requireDefaultWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { name, channelId } = createWebhookSchema.parse(req.body);
    const userId = req.user!.userId;

    // Verify channel exists and is not archived
    const channel = await prisma.channel.findFirst({
      where: { id: channelId, ...managedChannelWhere },
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
router.get('/', authMiddleware, requireDefaultWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const channelIdRaw = req.query.channelId as string | undefined;
    const channelId = channelIdRaw ? parseInt(channelIdRaw, 10) : undefined;

    const webhooks = await prisma.webhook.findMany({
      where: { ...(channelId ? { channelId } : {}), channel: managedChannelWhere },
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
router.delete('/:id', authMiddleware, requireDefaultWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const webhookId = parseIntParam(req.params.id);
    if (!webhookId) {
      res.status(400).json({ error: 'Invalid webhook ID' });
      return;
    }

    const webhook = await prisma.webhook.findFirst({
      where: { id: webhookId, channel: managedChannelWhere },
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
router.post('/:token', webhookSendLimiter, async (req: Request<{ token: string }>, res: Response) => {
  try {
    const token = req.params.token;
    const { content } = incomingWebhookSchema.parse(req.body);

    // Find webhook by token
    const webhook = await prisma.webhook.findUnique({
      where: { token },
      include: {
        channel: { select: { id: true, name: true, archivedAt: true } },
        creator: { select: { id: true, name: true, deactivatedAt: true } },
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

    // 예약 발송과 같은 정책: 생성자가 비활성화됐거나 채널 멤버가 아니면 메시지를 만들지 않는다
    if (webhook.creator.deactivatedAt) {
      res.status(403).json({ error: 'Webhook creator is deactivated' });
      return;
    }
    const creatorMembership = await prisma.channelMember.findUnique({
      where: { userId_channelId: { userId: webhook.createdBy, channelId: webhook.channelId } },
      select: { userId: true },
    });
    if (!creatorMembership) {
      res.status(403).json({ error: 'Webhook creator is not a channel member' });
      return;
    }

    // 웹훅으로 들어오는 글도 같은 DLP 검사를 거친다(생성자 이름으로 올라가므로 생성자 기준으로 기록)
    const dlpWarned = await enforceDlp(webhook.createdBy, content, 'message');

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

    if (finalMessage) recordDlpWarnings(webhook.createdBy, 'message', finalMessage.id, dlpWarned);

    // Broadcast via WebSocket
    const io = getIO();
    if (io && finalMessage) {
      io.to(`channel:${webhook.channelId}`).emit('message:new', finalMessage);
    }

    res.status(201).json({ message: 'Message sent', messageId: finalMessage?.id });

    // 웹훅 메시지는 일반 푸시를 보내지 않는다. 멘션된 사람에게만 알린다(generalPush를 켜지 않는다).
    if (finalMessage) void processNewChannelMessage(finalMessage);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    if (error instanceof ServiceError) {
      res.status(error.status).json(serviceErrorBody(error));
      return;
    }
    logError('Incoming webhook error', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

export default router;
