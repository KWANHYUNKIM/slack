import crypto from 'crypto';
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
    return { date: d, dateOnly: !hasTime };
  });

const DAY_MS = 24 * 60 * 60 * 1000;

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
  from: isoDate.transform((v) => v.date).optional(),
  // 날짜만 오면 그 날의 끝까지(다음 날 00:00 미만)로 본다
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
    where.createdAt = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? (f.to.dateOnly ? { lt: new Date(f.to.date.getTime() + DAY_MS) } : { lte: f.to.date }) : {}),
    };
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

/** 쓰기 쪽 최소 인터페이스(http.ServerResponse가 만족한다). 테스트에서 가짜로 바꿀 수 있게 따로 둔다. */
export interface WritableLike {
  destroyed: boolean;
  write(chunk: string): boolean;
  once(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
  off(event: 'drain' | 'close' | 'error', listener: () => void): unknown;
}

/**
 * 한 덩어리를 쓰고, 버퍼가 차면 drain을 기다린다. 기다리는 동안 연결이 끊기면(close·error) 영원히 기다리지 않고 false를 돌려준다.
 * false면 호출자는 그만 쓰고 멈춘다.
 */
export async function writeWithBackpressure(res: WritableLike, chunk: string): Promise<boolean> {
  if (res.destroyed) return false;
  if (!res.write(chunk)) {
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off('drain', done);
        res.off('close', done);
        res.off('error', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
      res.once('error', done);
    });
  }
  return !res.destroyed;
}

// ---- 내보내기 일회용 토큰 ----
// 브라우저가 <a href>로 파일을 바로 받으려면 Authorization 헤더를 못 보내므로, 60초짜리 1회용 토큰으로 인증한다.
// 토큰은 발급한 관리자와 (형식 + 필터)에 묶인다. 메모리에만 두며(단일 인스턴스 가정), 해시만 저장하고 어디에도 기록하지 않는다.
export const EXPORT_TOKEN_TTL_MS = 60_000;
const EXPORT_TOKEN_MAX = 1000;
const exportTokens = new Map<string, { userId: number; binding: string; expiresAt: number }>();

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** 형식과 필터를 정규화한 문자열. 발급 때와 사용 때 같은 값이어야 토큰이 통한다. */
export function exportBinding(format: string, f: AuditFilter): string {
  return JSON.stringify({
    format,
    action: [...(f.action ?? [])].sort(),
    actorId: f.actorId ?? null,
    targetType: f.targetType ?? null,
    targetId: f.targetId ?? null,
    from: f.from?.toISOString() ?? null,
    to: f.to ? `${f.to.date.toISOString()}${f.to.dateOnly ? ':day' : ''}` : null,
  });
}

export function issueExportToken(userId: number, binding: string, now = Date.now()): { token: string; expiresAt: number } | null {
  for (const [k, v] of exportTokens) if (v.expiresAt <= now) exportTokens.delete(k);
  if (exportTokens.size >= EXPORT_TOKEN_MAX) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = now + EXPORT_TOKEN_TTL_MS;
  exportTokens.set(hashToken(token), { userId, binding, expiresAt });
  return { token, expiresAt };
}

/** 한 번 꺼내면 맞든 틀리든 지운다(재사용 불가). 유효하면 발급한 사용자 id를 돌려준다. */
export function consumeExportToken(token: string, binding: string, now = Date.now()): number | null {
  const key = hashToken(token);
  const entry = exportTokens.get(key);
  if (!entry) return null;
  exportTokens.delete(key);
  if (entry.expiresAt <= now || entry.binding !== binding) return null;
  return entry.userId;
}
