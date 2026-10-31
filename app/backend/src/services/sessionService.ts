import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Request } from 'express';
import prisma from '../db.js';
import { JWT_SECRET, getSessionMaxAgeDays, getSessionIdleTimeoutHours } from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// lastSeenAt은 쓰기 부하를 줄이려고 1분에 한 번만 갱신한다.
export const LAST_SEEN_INTERVAL_MS = 60_000;
// 폐기된 행은 하루 남겼다가 지운다(폐기 직후 같은 토큰이 오면 행이 없어도 어차피 거부된다).
const REVOKED_KEEP_MS = DAY_MS;

// 세션 상태 확인은 요청마다 DB를 치지 않게 5초 캐시한다(tokenVersion 캐시와 같은 TTL). 폐기는 캐시를 바로 비운다.
// 테스트에서는 DB를 직접 고치는 경우가 있어 끈다.
const SESSION_CACHE_TTL = process.env.NODE_ENV === 'test' ? 0 : 5_000;
interface CachedSession { userId: number; lastSeenAt: number; expiresAt: number; revoked: boolean; cachedUntil: number }
const sessionCache = new Map<string, CachedSession>();

if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of sessionCache) if (entry.cachedUntil < now) sessionCache.delete(key);
  }, 10 * 60 * 1000).unref();
}

export function invalidateSessionCache(sid: string): void {
  sessionCache.delete(sid);
}

export function clearSessionCache(): void {
  sessionCache.clear();
}

/** IPv4는 마지막 옥텟, IPv6는 앞 3그룹 뒤를 가린다. 원문 IP는 저장하지 않는다. */
export function maskIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.replace(/\.\d{1,3}$/, '.x');
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::x';
  return null;
}

/** User-Agent를 "브라우저 / OS" 정도로 줄인다. 원문 전체는 저장하지 않는다(식별 정보가 되지 않게). */
export function summarizeUserAgent(ua: string | undefined | null): string | null {
  if (!ua) return null;
  const s = ua.slice(0, 512);
  // 순서가 중요하다: Edge/Opera/Electron은 Chrome 문자열을 함께 가진다.
  const browser =
    /Electron\//.test(s) ? 'Desktop app'
    : /Edg(e|A|iOS)?\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /Firefox\/|FxiOS\//.test(s) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : /curl\//i.test(s) ? 'curl'
    : 'Unknown browser';
  const os =
    /Windows/.test(s) ? 'Windows'
    : /Android/.test(s) ? 'Android'
    : /iPhone|iPad|iPod/.test(s) ? 'iOS'
    : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /CrOS/.test(s) ? 'ChromeOS'
    : /Linux/.test(s) ? 'Linux'
    : null;
  return os ? `${browser} / ${os}` : browser;
}

/** 로그인(또는 가입, 비밀번호 변경)마다 세션 한 행을 만들고 JWT를 서명해 돌려준다. */
export async function createSessionToken(
  user: { id: number; tokenVersion: number },
  req: Pick<Request, 'ip' | 'headers'>,
): Promise<{ token: string; sid: string; expiresAt: Date }> {
  const now = Date.now();
  const sid = crypto.randomBytes(16).toString('hex');
  const maxAgeMs = getSessionMaxAgeDays() * DAY_MS;
  const expiresAt = new Date(now + maxAgeMs);
  await prisma.session.create({
    data: {
      id: sid,
      userId: user.id,
      createdAt: new Date(now),
      lastSeenAt: new Date(now),
      expiresAt,
      userAgent: summarizeUserAgent(req.headers['user-agent'] as string | undefined),
      ip: maskIp(req.ip),
    },
  });
  // JWT 만료도 세션 최대 수명과 맞춘다. 세션 행이 어떻게 되든 토큰이 그보다 오래 살지 않는다.
  const token = jwt.sign({ userId: user.id, tokenVersion: user.tokenVersion, sid }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: Math.floor(maxAgeMs / 1000),
  });
  return { token, sid, expiresAt };
}

/** 세션이 아직 유효한지(폐기, 최대 수명, 유휴 만료) 판단하는 순수 함수. */
export function isSessionAlive(
  s: { revokedAt?: Date | null; expiresAt: Date | number; lastSeenAt: Date | number },
  now = Date.now(),
): boolean {
  if (s.revokedAt) return false;
  if (new Date(s.expiresAt).getTime() <= now) return false;
  if (new Date(s.lastSeenAt).getTime() + getSessionIdleTimeoutHours() * HOUR_MS <= now) return false;
  return true;
}

/**
 * validateAccessToken이 부른다. sid의 세션이 이 사용자의 것이고 살아 있으면 true.
 * 살아 있으면 lastSeenAt을 1분 간격으로만 갱신한다(응답을 기다리지 않는다).
 */
export async function checkSession(sid: string, userId: number): Promise<boolean> {
  const now = Date.now();
  let entry = sessionCache.get(sid);
  if (!entry || entry.cachedUntil < now) {
    const row = await prisma.session.findUnique({
      where: { id: sid },
      select: { userId: true, lastSeenAt: true, expiresAt: true, revokedAt: true },
    });
    if (!row) return false;
    entry = {
      userId: row.userId,
      lastSeenAt: row.lastSeenAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
      revoked: row.revokedAt !== null,
      cachedUntil: now + SESSION_CACHE_TTL,
    };
    sessionCache.set(sid, entry);
  }
  if (entry.userId !== userId) return false;
  if (entry.revoked || !isSessionAlive({ expiresAt: entry.expiresAt, lastSeenAt: entry.lastSeenAt }, now)) return false;

  if (now - entry.lastSeenAt >= LAST_SEEN_INTERVAL_MS) {
    // 같은 요청이 몰려도 한 번만 쓰도록 캐시 값을 먼저 올린다.
    entry.lastSeenAt = now;
    void prisma.session
      .updateMany({ where: { id: sid, revokedAt: null }, data: { lastSeenAt: new Date(now) } })
      .catch(() => { /* 갱신 실패는 인증을 막지 않는다. 다음 요청이 다시 시도한다 */ });
  }
  return true;
}

/** 사용자의 살아 있는 세션 목록(최근 사용 순). */
export async function listActiveSessions(userId: number) {
  const now = new Date();
  const rows = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { lastSeenAt: 'desc' },
    take: 100,
  });
  return rows.filter((r) => isSessionAlive(r, now.getTime()));
}

/** 세션 한 개를 폐기한다. 이미 폐기됐거나 없거나 남의 것이면 null. 돌려주는 값은 폐기한 sid. */
export async function revokeSession(userId: number, sid: string): Promise<string | null> {
  const { count } = await prisma.session.updateMany({
    where: { id: sid, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  invalidateSessionCache(sid);
  return count > 0 ? sid : null;
}

/** 사용자의 살아 있는 세션을 폐기한다(exceptSid는 남긴다). 폐기한 sid 목록을 돌려준다. */
export async function revokeUserSessions(userId: number, exceptSid?: string): Promise<string[]> {
  const rows = await prisma.session.findMany({
    where: { userId, revokedAt: null, ...(exceptSid ? { id: { not: exceptSid } } : {}) },
    select: { id: true },
  });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await prisma.session.updateMany({ where: { id: { in: ids }, revokedAt: null }, data: { revokedAt: new Date() } });
  ids.forEach(invalidateSessionCache);
  return ids;
}

/** 만료, 유휴 초과, 폐기 후 하루가 지난 행을 지운다. 지운 행 수를 돌려준다. */
export async function purgeSessions(now: Date = new Date()): Promise<number> {
  const idleCutoff = new Date(now.getTime() - getSessionIdleTimeoutHours() * HOUR_MS);
  const revokedCutoff = new Date(now.getTime() - REVOKED_KEEP_MS);
  const { count } = await prisma.session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: now } },
        { lastSeenAt: { lt: idleCutoff } },
        { revokedAt: { lt: revokedCutoff } },
      ],
    },
  });
  return count;
}
