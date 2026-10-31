import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { parsePagination } from '../utils/pagination.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog, writeAuditLogs } from '../utils/auditLog.js';
import { ERR } from '../utils/errorCodes.js';
import {
  HOLD_NAME_MAX,
  HOLD_DESCRIPTION_MAX,
  CUSTODIANS_PER_REQUEST_MAX,
  listHolds,
  getHold,
  createHold,
  updateHold,
  addCustodians,
  removeCustodian,
  releaseHold,
} from '../services/legalHoldService.js';

const router = Router();

// 법적 보존 건 관리(E6). 이 라우터는 /admin 아래에서 admin.ts보다 먼저 연결된다. 모두 관리자(ADMIN/OWNER)만.
router.use('/legal-holds', authMiddleware, requireAdmin);

const userIdsSchema = z.array(z.number().int().positive()).max(CUSTODIANS_PER_REQUEST_MAX);
const nameSchema = z.string().trim().min(1).max(HOLD_NAME_MAX);
// 빈 설명은 null로 저장한다
const descriptionSchema = z.string().trim().max(HOLD_DESCRIPTION_MAX).nullable().transform((v) => v || null);

const createSchema = z
  .object({ name: nameSchema, description: descriptionSchema.optional(), userIds: userIdsSchema.default([]) })
  .strict();
const updateSchema = z
  .object({ name: nameSchema.optional(), description: descriptionSchema.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined, { message: 'Nothing to update' });
const addSchema = z.object({ userIds: userIdsSchema.min(1) }).strict();
const statusSchema = z.enum(['active', 'released', 'all']).default('active');

// 대상자마다 한 행(사용자별로 찾을 수 있게)을 한 번의 createMany로 남긴다
const custodianAddedLogs = (actorId: number, holdId: number, users: { id: number; name: string }[]) =>
  users.map((u) => ({ action: 'legal_hold.custodian_added', actorId, targetType: 'user', targetId: u.id, targetName: u.name, details: `holdId=${holdId}` }));

const invalidId = (res: Response) => res.status(400).json({ error: 'Invalid legal hold ID', code: ERR.BAD_REQUEST });
const notFound = (res: Response) => res.status(404).json({ error: 'Legal hold not found', code: ERR.LEGAL_HOLD_NOT_FOUND });

// GET /admin/legal-holds?status=active|released|all - 최신순 커서 페이지
router.get('/legal-holds', async (req: AuthRequest, res: Response) => {
  try {
    const status = statusSchema.safeParse(req.query.status);
    if (!status.success) {
      res.status(400).json({ error: 'Invalid status', details: status.error.issues });
      return;
    }
    const { limit, cursor } = parsePagination(req);
    res.json(await listHolds(status.data, limit, cursor));
  } catch (error) {
    logError('Admin list legal holds error', error);
    res.status(500).json({ error: 'Failed to list legal holds' });
  }
});

// GET /admin/legal-holds/:id - 보존 건과 대상자
router.get('/legal-holds/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) return void invalidId(res);
    const hold = await getHold(id);
    if (!hold) return void notFound(res);
    res.json(hold);
  } catch (error) {
    logError('Admin get legal hold error', error);
    res.status(500).json({ error: 'Failed to get legal hold' });
  }
});

// POST /admin/legal-holds - { name, description?, userIds? }
router.post('/legal-holds', async (req: AuthRequest, res: Response) => {
  try {
    const body = createSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid legal hold', details: body.error.issues });
      return;
    }
    const actorId = req.user!.userId;
    const result = await createHold({ name: body.data.name, description: body.data.description ?? null, userIds: body.data.userIds }, actorId);
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    const { id, added } = result.value;
    await writeAuditLogs([
      { action: 'legal_hold.created', actorId, targetType: 'legal_hold', targetId: id, targetName: body.data.name, details: `custodians=${added.length}` },
      ...custodianAddedLogs(actorId, id, added),
    ]);
    res.status(201).json(await getHold(id));
  } catch (error) {
    logError('Admin create legal hold error', error);
    res.status(500).json({ error: 'Failed to create legal hold' });
  }
});

// PATCH /admin/legal-holds/:id - { name?, description? }. 해제된 보존 건은 바꿀 수 없다.
router.patch('/legal-holds/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) return void invalidId(res);
    const body = updateSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid legal hold', details: body.error.issues });
      return;
    }
    const result = await updateHold(id, body.data);
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    const { before } = result.value;
    const changed = [
      body.data.name !== undefined && body.data.name !== before.name ? 'name' : null,
      body.data.description !== undefined && body.data.description !== before.description ? 'description' : null,
    ].filter(Boolean);
    const hold = await getHold(id);
    await writeAuditLog({
      action: 'legal_hold.updated',
      actorId: req.user!.userId,
      targetType: 'legal_hold',
      targetId: id,
      targetName: hold?.name,
      details: `changed=${changed.join(',') || 'none'}`,
    });
    res.json(hold);
  } catch (error) {
    logError('Admin update legal hold error', error);
    res.status(500).json({ error: 'Failed to update legal hold' });
  }
});

// POST /admin/legal-holds/:id/custodians - { userIds }. 이미 대상인 사용자는 건너뛴다.
router.post('/legal-holds/:id/custodians', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) return void invalidId(res);
    const body = addSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid custodians', details: body.error.issues });
      return;
    }
    const actorId = req.user!.userId;
    const result = await addCustodians(id, body.data.userIds, actorId);
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    await writeAuditLogs(custodianAddedLogs(actorId, id, result.value.added));
    res.json(await getHold(id));
  } catch (error) {
    logError('Admin add legal hold custodians error', error);
    res.status(500).json({ error: 'Failed to add custodians' });
  }
});

// DELETE /admin/legal-holds/:id/custodians/:userId
router.delete('/legal-holds/:id/custodians/:userId', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    const userId = parseIntParam(req.params.userId);
    if (!id || !userId) return void invalidId(res);
    const result = await removeCustodian(id, userId);
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    await writeAuditLog({
      action: 'legal_hold.custodian_removed',
      actorId: req.user!.userId,
      targetType: 'user',
      targetId: userId,
      targetName: result.value.userName,
      details: `holdId=${id}; stillHeld=${result.value.stillHeld}`,
    });
    res.json(await getHold(id));
  } catch (error) {
    logError('Admin remove legal hold custodian error', error);
    res.status(500).json({ error: 'Failed to remove custodian' });
  }
});

// POST /admin/legal-holds/:id/release - 해제. 되돌릴 수 없고, 보존 건과 대상자 목록은 기록으로 남는다.
router.post('/legal-holds/:id/release', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) return void invalidId(res);
    const result = await releaseHold(id, req.user!.userId);
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    await writeAuditLog({
      action: 'legal_hold.released',
      actorId: req.user!.userId,
      targetType: 'legal_hold',
      targetId: id,
      targetName: result.value.name,
      details: `custodians=${result.value.custodianCount}; freed=${result.value.freed}`,
    });
    res.json(await getHold(id));
  } catch (error) {
    logError('Admin release legal hold error', error);
    res.status(500).json({ error: 'Failed to release legal hold' });
  }
});

export default router;
