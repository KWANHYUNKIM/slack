import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../db.js';

export const EXPORT_MAX_ROWS = 100_000;
const EXPORT_BATCH = 1000;

// 날짜는 ISO 8601만 받는다. 시간대 표기가 없으면 UTC로 본다(사용자 timeZone은 쓰지 않는다).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const isoDate = z
  .string()
  .regex(ISO_DATE)
  .transform((v, ctx) => {
    const hasTime = v.includes('T');
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(v) && hasTime;
    const d = new Date(hasTime && !hasZone ? `${v}Z` : v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Invalid date' });
      return z.NEVER;
    }
    return d;
  });

// action은 ?action=a&action=b 또는 ?action=a,b 둘 다 받는다
const actionList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean))
  .pipe(z.array(z.string().max(100)).max(50));

export const auditFilterSchema = z.object({
  action: actionList.optional(),
  actorId: z.coerce.number().int().positive().optional(),
  targetType: z.string().max(50).optional(),
  targetId: z.coerce.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export type AuditFilter = z.infer<typeof auditFilterSchema>;

export function buildAuditWhere(f: AuditFilter): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (f.action && f.action.length > 0) where.action = { in: f.action };
  if (f.actorId !== undefined) where.actorId = f.actorId;
  if (f.targetType) where.targetType = f.targetType;
  if (f.targetId !== undefined) where.targetId = f.targetId;
  if (f.from || f.to) {
    where.createdAt = { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) };
  }
  return where;
}

const ACTOR_SELECT = { id: true, name: true, avatar: true } as const;

/** 최신순(id 내림차순) 커서 페이지. id는 삽입 순서대로 늘어나므로 createdAt 순서와 같다. */
export async function listAuditLogs(f: AuditFilter, limit: number, cursor: number | undefined) {
  const rows = await prisma.auditLog.findMany({
    where: { ...buildAuditWhere(f), ...(cursor ? { id: { lt: cursor } } : {}) },
    include: { actor: { select: ACTOR_SELECT } },
    orderBy: { id: 'desc' },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export const CSV_COLUMNS = ['id', 'createdAt', 'action', 'actorId', 'actorName', 'targetType', 'targetId', 'targetName', 'details'] as const;

/**
 * CSV 한 칸. =, +, -, @ (그리고 탭·CR)로 시작하면 스프레드시트가 수식으로 읽으므로 앞에 작은따옴표를 붙인다.
 * 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type ExportRow = Awaited<ReturnType<typeof fetchBatch>>[number];

function fetchBatch(f: AuditFilter, after: number | undefined, take: number) {
  return prisma.auditLog.findMany({
    where: { ...buildAuditWhere(f), ...(after ? { id: { lt: after } } : {}) },
    include: { actor: { select: { name: true } } },
    orderBy: { id: 'desc' },
    take,
  });
}

export function csvLine(row: ExportRow): string {
  return [row.id, row.createdAt, row.action, row.actorId, row.actor?.name, row.targetType, row.targetId, row.targetName, row.details]
    .map(csvCell)
    .join(',');
}

/** 필터에 맞는 행을 배치로 읽어 최신순으로 넘긴다. 최대 EXPORT_MAX_ROWS행에서 멈춘다. */
export async function* iterateAuditRows(f: AuditFilter): AsyncGenerator<ExportRow> {
  let after: number | undefined;
  let sent = 0;
  while (sent < EXPORT_MAX_ROWS) {
    const rows = await fetchBatch(f, after, Math.min(EXPORT_BATCH, EXPORT_MAX_ROWS - sent));
    if (rows.length === 0) return;
    for (const row of rows) yield row;
    sent += rows.length;
    after = rows[rows.length - 1].id;
    if (rows.length < EXPORT_BATCH) return;
  }
}

export function jsonRow(row: ExportRow) {
  const { actor, ...rest } = row;
  return { ...rest, actorName: actor?.name ?? null };
}
