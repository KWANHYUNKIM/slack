import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import {
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  effectiveDays,
  getWorkspaceRetentionDays,
  setWorkspaceRetentionDays,
} from '../services/retentionService.js';

const router = Router();

// 이 라우터는 /admin 아래에서 admin.ts보다 먼저 연결된다. 모두 관리자(ADMIN/OWNER)만.
router.use('/retention', authMiddleware, requireAdmin);

// days: 1 이상 정수 또는 null(무기한). 하한이 있어 0이나 음수로 "전부 지우기"를 만들 수 없다.
const policySchema = z.object({
  days: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS).nullable(),
});

const channelView = (c: { id: number; name: string; retentionDays: number | null; legalHold: boolean }, workspaceDays: number | null) => ({
  id: c.id,
  name: c.name,
  // override: 덮어쓰기가 없으면 null, 있으면 { days } (days가 null이면 이 채널만 무기한)
  override: c.retentionDays === null ? null : { days: c.retentionDays > 0 ? c.retentionDays : null },
  effectiveDays: effectiveDays(c.retentionDays, workspaceDays),
  legalHold: c.legalHold,
});

const CHANNEL_SELECT = { id: true, name: true, retentionDays: true, legalHold: true } as const;

// GET /admin/retention - 워크스페이스 기본 정책 + 채널별 적용 상태
router.get('/retention', async (_req: AuthRequest, res: Response) => {
  try {
    const workspaceDays = await getWorkspaceRetentionDays();
    const channels = await prisma.channel.findMany({ select: CHANNEL_SELECT, orderBy: { name: 'asc' } });
    res.json({
      workspace: { days: workspaceDays },
      minDays: MIN_RETENTION_DAYS,
      maxDays: MAX_RETENTION_DAYS,
      channels: channels.map((c) => channelView(c, workspaceDays)),
    });
  } catch (error) {
    logError('Admin get retention error', error);
    res.status(500).json({ error: 'Failed to get retention policy' });
  }
});

// PUT /admin/retention/workspace - 기본 정책 변경. { days: number | null }
router.put('/retention/workspace', async (req: AuthRequest, res: Response) => {
  try {
    const body = policySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid retention policy', details: body.error.issues });
      return;
    }
    const before = await getWorkspaceRetentionDays();
    await setWorkspaceRetentionDays(body.data.days);
    await writeAuditLog({
      action: 'retention.workspace_updated',
      actorId: req.user!.userId,
      targetType: 'workspace',
      details: `days=${before ?? 'none'} -> ${body.data.days ?? 'none'}`,
    });
    res.json({ workspace: { days: body.data.days } });
  } catch (error) {
    logError('Admin set workspace retention error', error);
    res.status(500).json({ error: 'Failed to update retention policy' });
  }
});

// PUT /admin/retention/channels/:id - 채널 덮어쓰기. { days: number | null } (null이면 이 채널만 무기한)
router.put('/retention/channels/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    const body = policySchema.safeParse(req.body);
    if (!id || !body.success) {
      res.status(400).json({ error: 'Invalid retention policy', details: body.success ? undefined : body.error.issues });
      return;
    }
    const existing = await prisma.channel.findUnique({ where: { id }, select: CHANNEL_SELECT });
    if (!existing) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const updated = await prisma.channel.update({ where: { id }, data: { retentionDays: body.data.days ?? 0 }, select: CHANNEL_SELECT });
    await writeAuditLog({
      action: 'retention.channel_updated',
      actorId: req.user!.userId,
      targetType: 'channel',
      targetId: id,
      targetName: existing.name,
      details: `days=${existing.retentionDays === null ? 'inherit' : existing.retentionDays || 'none'} -> ${body.data.days ?? 'none'}`,
    });
    res.json(channelView(updated, await getWorkspaceRetentionDays()));
  } catch (error) {
    logError('Admin set channel retention error', error);
    res.status(500).json({ error: 'Failed to update channel retention policy' });
  }
});

// DELETE /admin/retention/channels/:id - 덮어쓰기를 지우고 워크스페이스 기본을 따르게 한다
router.delete('/retention/channels/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }
    const existing = await prisma.channel.findUnique({ where: { id }, select: CHANNEL_SELECT });
    if (!existing) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const updated = await prisma.channel.update({ where: { id }, data: { retentionDays: null }, select: CHANNEL_SELECT });
    await writeAuditLog({
      action: 'retention.channel_cleared',
      actorId: req.user!.userId,
      targetType: 'channel',
      targetId: id,
      targetName: existing.name,
      details: `days=${existing.retentionDays === null ? 'inherit' : existing.retentionDays || 'none'} -> inherit`,
    });
    res.json(channelView(updated, await getWorkspaceRetentionDays()));
  } catch (error) {
    logError('Admin clear channel retention error', error);
    res.status(500).json({ error: 'Failed to clear channel retention policy' });
  }
});

export default router;
