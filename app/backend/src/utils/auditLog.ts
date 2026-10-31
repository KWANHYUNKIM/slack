import crypto from 'crypto';
import prisma from '../db.js';
import { JWT_SECRET } from '../config.js';
import { logError } from './logger.js';

interface AuditEntry {
  action: string;
  actorId?: number | null;
  targetType: string;
  targetId?: number;
  targetName?: string;
  details?: string;
}

const DETAILS_MAX = 1000;

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    const data = {
      ...entry,
      details: entry.details && entry.details.length > DETAILS_MAX ? entry.details.slice(0, DETAILS_MAX) : entry.details,
    };
    await prisma.auditLog.create({ data });
  } catch (error) {
    // Audit log failure should never block the admin action
    logError('Audit log write failed', error);
  }
}

/**
 * 로그인 실패 기록에 이메일 원문 대신 남기는 식별자. 비밀키를 넣은 HMAC이라 이메일 목록으로 되돌려 맞춰 볼 수 없고,
 * 같은 이메일의 반복 시도는 같은 값으로 묶인다.
 */
export function hashEmailForAudit(email: string): string {
  return crypto.createHmac('sha256', JWT_SECRET).update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

const PURGE_BATCH = 1000;
const PURGE_MAX_BATCHES = 100; // 한 번에 최대 10만 행. 남은 것은 다음 날 이어서 지운다.

/** 기준일(retentionDays)보다 오래된 행을 배치로 지운다. 지운 행 수를 돌려준다. 0 이하면 아무것도 하지 않는다. */
export async function purgeOldAuditLogs(retentionDays: number, now: Date = new Date()): Promise<number> {
  if (!(retentionDays > 0)) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  let total = 0;
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const rows = await prisma.auditLog.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PURGE_BATCH,
    });
    if (rows.length === 0) break;
    const { count } = await prisma.auditLog.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    total += count;
    if (rows.length < PURGE_BATCH) break;
  }
  return total;
}

// 존재하지 않는 이메일의 로그인 실패는 공격자가 마음대로 만들 수 있으므로 emailHash당 15분에 한 건만 기록한다.
// 그 사이 시도 횟수는 다음 기록의 count로 남긴다. 메모리 맵이라 상한을 두고, 가득 차면 만료된 항목부터 치운다.
const UNKNOWN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const UNKNOWN_LOGIN_MAX = 5000;
const unknownLoginSeen = new Map<string, { lastLoggedAt: number; pending: number }>();

/** 이번 시도를 기록해야 하면 그 사이 시도 횟수(이번 포함)를, 건너뛰어야 하면 null을 돌려준다. */
export function throttleUnknownLogin(emailHash: string, now = Date.now()): number | null {
  const entry = unknownLoginSeen.get(emailHash);
  if (entry && now - entry.lastLoggedAt < UNKNOWN_LOGIN_WINDOW_MS) {
    entry.pending++;
    return null;
  }
  if (!entry && unknownLoginSeen.size >= UNKNOWN_LOGIN_MAX) {
    for (const [k, v] of unknownLoginSeen) if (now - v.lastLoggedAt >= UNKNOWN_LOGIN_WINDOW_MS) unknownLoginSeen.delete(k);
    // 그래도 가득 차면(전부 15분 안) 새 해시는 기록하지 않는다. 메모리가 무한히 늘지 않게 하는 쪽을 택한다.
    if (unknownLoginSeen.size >= UNKNOWN_LOGIN_MAX) return null;
  }
  const count = (entry?.pending ?? 0) + 1;
  unknownLoginSeen.set(emailHash, { lastLoggedAt: now, pending: 0 });
  return count;
}

/** 테스트용: 집계 상태를 비운다 */
export function resetUnknownLoginThrottle(): void {
  unknownLoginSeen.clear();
}
