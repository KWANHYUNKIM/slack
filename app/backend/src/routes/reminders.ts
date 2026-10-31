import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { cleanStatusText } from '../services/statusService.js';
import {
  MAX_FUTURE_MS,
  MAX_PENDING_REMINDERS,
  MAX_REMINDER_TEXT,
  MIN_FUTURE_MS,
  deleteReminderActivities,
  emitReminder,
  emitReminderRemoved,
  resolveDmTarget,
  resolveMessageTarget,
  serializeReminders,
} from '../services/reminderService.js';

const router = Router();

const createSchema = z.object({
  messageId: z.number().int().positive().optional(),
  dmId: z.number().int().positive().optional(),
  text: z.string().max(MAX_REMINDER_TEXT).optional(),
  remindAt: z.string().datetime(),
}).strict().refine((d) => !(d.messageId && d.dmId), { message: 'Provide messageId or dmId, not both' })
  .refine((d) => d.messageId || d.dmId || (d.text && d.text.trim().length > 0), { message: 'Provide messageId, dmId, or text' });

const patchSchema = z.object({
  remindAt: z.string().datetime().optional(),
  completed: z.boolean().optional(),
}).strict().refine((d) => (d.remindAt === undefined) !== (d.completed === undefined), {
  message: 'Provide exactly one of remindAt or completed',
});

const listSchema = z.object({
  status: z.enum(['pending', 'done']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

/** 현재 이후 1년 이내인지 확인한다. 아니면 에러 문구를 돌려준다. */
function checkRemindAt(value: string): string | null {
  const diff = new Date(value).getTime() - Date.now();
  if (diff < MIN_FUTURE_MS) return 'remindAt must be in the future';
  if (diff > MAX_FUTURE_MS) return 'remindAt must be within one year';
  return null;
}

// POST /reminders - 리마인더 만들기. 접근할 수 없는 메시지는 존재 여부를 숨기려고 404로 답한다.
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const body = createSchema.parse(req.body);
    const invalid = checkRemindAt(body.remindAt);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    const text = body.text !== undefined ? cleanStatusText(body.text) : '';

    let channelId: number | null = null;
    if (body.messageId) {
      const target = await resolveMessageTarget(userId, body.messageId);
      if (!target) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      channelId = target.channelId;
    } else if (body.dmId && !(await resolveDmTarget(userId, body.dmId))) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const pending = await prisma.reminder.count({ where: { userId, completedAt: null } });
    if (pending >= MAX_PENDING_REMINDERS) {
      res.status(400).json({ error: `Maximum of ${MAX_PENDING_REMINDERS} pending reminders allowed` });
      return;
    }

    const row = await prisma.reminder.create({
      data: {
        userId,
        messageId: body.messageId ?? null,
        dmId: body.dmId ?? null,
        channelId,
        text: text || null,
        remindAt: new Date(body.remindAt),
      },
    });
    const [reminder] = await serializeReminders(userId, [row]);
    void emitReminder('reminder:updated', userId, row);
    res.status(201).json(reminder);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: error.issues });
      return;
    }
    logError('Create reminder error', error);
    res.status(500).json({ error: 'Failed to create reminder' });
  }
});

// GET /reminders?status=pending|done - 내 리마인더만. 미완료는 예정 순, 완료는 최근 완료 순.
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { status, limit } = listSchema.parse(req.query);
    const rows = status === 'pending'
      ? await prisma.reminder.findMany({ where: { userId, completedAt: null }, orderBy: [{ remindAt: 'asc' }, { id: 'asc' }], take: limit })
      : await prisma.reminder.findMany({ where: { userId, completedAt: { not: null } }, orderBy: [{ completedAt: 'desc' }, { id: 'desc' }], take: limit });
    // 미완료는 한도(200)가 곧 상한이라 한 번에 다 나온다. 완료 목록은 최근 limit개만 준다.
    res.json({ items: await serializeReminders(userId, rows), nextCursor: null });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid query', details: error.issues });
      return;
    }
    logError('List reminders error', error);
    res.status(500).json({ error: 'Failed to list reminders' });
  }
});

// PATCH /reminders/:id - { remindAt } 스누즈(다시 알림) 또는 { completed } 완료/되돌리기
router.patch('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid reminder ID' });
      return;
    }
    const body = patchSchema.parse(req.body);
    if (body.remindAt !== undefined) {
      const invalid = checkRemindAt(body.remindAt);
      if (invalid) {
        res.status(400).json({ error: invalid });
        return;
      }
    }

    const existing = await prisma.reminder.findFirst({ where: { id, userId } });
    if (!existing) {
      res.status(404).json({ error: 'Reminder not found' });
      return;
    }

    let row;
    if (body.remindAt !== undefined) {
      // 다시 알림: 새 시각에 한 번 더 울리도록 firedAt을 비우고 지난 알림 활동은 치운다
      row = await prisma.reminder.update({
        where: { id },
        data: { remindAt: new Date(body.remindAt), firedAt: null, completedAt: null },
      });
      await deleteReminderActivities(id);
    } else {
      row = await prisma.reminder.update({ where: { id }, data: { completedAt: body.completed ? new Date() : null } });
    }
    const [reminder] = await serializeReminders(userId, [row]);
    void emitReminder('reminder:updated', userId, row);
    res.json(reminder);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid request', details: error.issues });
      return;
    }
    logError('Update reminder error', error);
    res.status(500).json({ error: 'Failed to update reminder' });
  }
});

// DELETE /reminders/:id - 본인 것만. 남의 것이나 없는 것은 같은 404.
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid reminder ID' });
      return;
    }
    const removed = await prisma.reminder.deleteMany({ where: { id, userId } });
    if (removed.count === 0) {
      res.status(404).json({ error: 'Reminder not found' });
      return;
    }
    await deleteReminderActivities(id);
    emitReminderRemoved(userId, id);
    res.json({ message: 'Reminder deleted' });
  } catch (error) {
    logError('Delete reminder error', error);
    res.status(500).json({ error: 'Failed to delete reminder' });
  }
});

export default router;
