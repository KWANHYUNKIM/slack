import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { ERR } from '../utils/errorCodes.js';
import {
  NAME_MAX_LENGTH,
  PATTERN_MAX_LENGTH,
  TEST_SAMPLE_MAX,
  builtinValidator,
  ensureBuiltinRules,
  invalidateDlpCache,
  testPattern,
  validatePattern,
} from '../services/dlpService.js';

const router = Router();

// 이 라우터는 /admin 아래에서 admin.ts보다 먼저 연결된다. 모두 관리자(ADMIN/OWNER)만.
router.use('/dlp-rules', authMiddleware, requireAdmin);

const CUSTOM_RULE_LIMIT = 50;

const nameSchema = z.string().trim().min(1).max(NAME_MAX_LENGTH);
// pattern 길이는 여기서 자르지 않고 validatePattern이 이유(reason)와 함께 거부하게 둔다
const patternSchema = z.string().max(PATTERN_MAX_LENGTH * 5);
const actionSchema = z.enum(['BLOCK', 'WARN']);

const createSchema = z.object({
  name: nameSchema,
  pattern: patternSchema,
  action: actionSchema,
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  name: nameSchema.optional(),
  pattern: patternSchema.optional(),
  action: actionSchema.optional(),
  enabled: z.boolean().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

const testSchema = z.object({
  pattern: patternSchema.optional(),
  ruleId: z.number().int().positive().optional(),
  sample: z.string().max(TEST_SAMPLE_MAX),
}).refine((v) => (v.pattern === undefined) !== (v.ruleId === undefined), { message: 'Provide either pattern or ruleId' });

const RULE_SELECT = {
  id: true, key: true, name: true, pattern: true, action: true, enabled: true, builtin: true,
  createdAt: true, updatedAt: true, createdBy: { select: { id: true, name: true } },
} as const;

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

function invalidPattern(res: Response, reason: string): void {
  res.status(400).json({ error: 'Invalid pattern', code: ERR.DLP_PATTERN_INVALID, reason });
}

function nameTaken(res: Response): void {
  res.status(409).json({ error: 'A rule with this name already exists', code: ERR.DLP_RULE_NAME_TAKEN });
}

// GET /admin/dlp-rules - 내장 규칙(먼저) + 사용자 정의 규칙
router.get('/dlp-rules', async (_req: AuthRequest, res: Response) => {
  try {
    await ensureBuiltinRules();
    const items = await prisma.dlpRule.findMany({ select: RULE_SELECT, orderBy: [{ builtin: 'desc' }, { id: 'asc' }] });
    res.json({ items, limits: { patternMax: PATTERN_MAX_LENGTH, nameMax: NAME_MAX_LENGTH, sampleMax: TEST_SAMPLE_MAX } });
  } catch (error) {
    logError('Admin list DLP rules error', error);
    res.status(500).json({ error: 'Failed to list DLP rules' });
  }
});

// POST /admin/dlp-rules/test - 패턴(또는 저장된 규칙)이 샘플 글과 일치하는지. 저장하지 않는다.
router.post('/dlp-rules/test', async (req: AuthRequest, res: Response) => {
  try {
    const body = testSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid input', details: body.error.issues });
      return;
    }
    const { sample, ruleId } = body.data;
    let pattern = body.data.pattern;
    let validate: ((m: string) => boolean) | undefined;
    if (ruleId !== undefined) {
      const rule = await prisma.dlpRule.findUnique({ where: { id: ruleId }, select: { pattern: true, key: true } });
      if (!rule) {
        res.status(404).json({ error: 'DLP rule not found' });
        return;
      }
      pattern = rule.pattern;
      validate = builtinValidator(rule.key);
    } else {
      // 저장 때와 같은 검증을 통과한 패턴만 실행한다(테스트 입력란이 ReDoS 통로가 되지 않게)
      const problem = validatePattern(pattern!);
      if (problem) {
        invalidPattern(res, problem);
        return;
      }
    }
    res.json(testPattern(pattern!, sample, validate));
  } catch (error) {
    logError('Admin test DLP rule error', error);
    res.status(500).json({ error: 'Failed to test DLP rule' });
  }
});

// POST /admin/dlp-rules - 사용자 정의 규칙 추가
router.post('/dlp-rules', async (req: AuthRequest, res: Response) => {
  try {
    const body = createSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid DLP rule', details: body.error.issues });
      return;
    }
    const problem = validatePattern(body.data.pattern);
    if (problem) {
      invalidPattern(res, problem);
      return;
    }
    if ((await prisma.dlpRule.count({ where: { builtin: false } })) >= CUSTOM_RULE_LIMIT) {
      res.status(400).json({ error: 'Too many DLP rules', code: ERR.DLP_RULE_LIMIT });
      return;
    }
    const created = await prisma.dlpRule.create({
      data: { ...body.data, createdById: req.user!.userId },
      select: RULE_SELECT,
    });
    invalidateDlpCache();
    await writeAuditLog({
      action: 'dlp.rule_created',
      actorId: req.user!.userId,
      targetType: 'dlp_rule',
      targetId: created.id,
      targetName: created.name,
      details: `action=${created.action} enabled=${created.enabled}`,
    });
    res.status(201).json(created);
  } catch (error) {
    if (isUniqueViolation(error)) {
      nameTaken(res);
      return;
    }
    logError('Admin create DLP rule error', error);
    res.status(500).json({ error: 'Failed to create DLP rule' });
  }
});

// PATCH /admin/dlp-rules/:id - 수정. 내장 규칙은 enabled만 바꿀 수 있다.
router.patch('/dlp-rules/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    const body = updateSchema.safeParse(req.body);
    if (!id || !body.success) {
      res.status(400).json({ error: 'Invalid DLP rule', details: body.success ? undefined : body.error.issues });
      return;
    }
    const existing = await prisma.dlpRule.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'DLP rule not found' });
      return;
    }
    const { name, pattern, action, enabled } = body.data;
    if (existing.builtin && (name !== undefined || pattern !== undefined || action !== undefined)) {
      res.status(403).json({ error: 'Built-in rules can only be turned on or off', code: ERR.DLP_RULE_BUILTIN });
      return;
    }
    if (pattern !== undefined) {
      const problem = validatePattern(pattern);
      if (problem) {
        invalidPattern(res, problem);
        return;
      }
    }
    const updated = await prisma.dlpRule.update({
      where: { id },
      data: { name, pattern, action, enabled },
      select: RULE_SELECT,
    });
    invalidateDlpCache();
    const changed = Object.entries({ name, pattern, action, enabled })
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k);
    await writeAuditLog({
      action: 'dlp.rule_updated',
      actorId: req.user!.userId,
      targetType: 'dlp_rule',
      targetId: id,
      targetName: updated.name,
      details: `changed=${changed.join(',')} action=${updated.action} enabled=${updated.enabled}`,
    });
    res.json(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      nameTaken(res);
      return;
    }
    logError('Admin update DLP rule error', error);
    res.status(500).json({ error: 'Failed to update DLP rule' });
  }
});

// DELETE /admin/dlp-rules/:id - 사용자 정의 규칙 삭제. 내장 규칙은 지울 수 없다(끄기만 된다).
router.delete('/dlp-rules/:id', async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid DLP rule ID' });
      return;
    }
    const existing = await prisma.dlpRule.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'DLP rule not found' });
      return;
    }
    if (existing.builtin) {
      res.status(403).json({ error: 'Built-in rules can only be turned on or off', code: ERR.DLP_RULE_BUILTIN });
      return;
    }
    await prisma.dlpRule.delete({ where: { id } });
    invalidateDlpCache();
    await writeAuditLog({
      action: 'dlp.rule_deleted',
      actorId: req.user!.userId,
      targetType: 'dlp_rule',
      targetId: id,
      targetName: existing.name,
    });
    res.json({ message: 'DLP rule deleted' });
  } catch (error) {
    logError('Admin delete DLP rule error', error);
    res.status(500).json({ error: 'Failed to delete DLP rule' });
  }
});

export default router;
