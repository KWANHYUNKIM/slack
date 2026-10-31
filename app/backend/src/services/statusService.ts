import prisma from '../db.js';
import { getIO, getSharedUsers } from '../websocket/index.js';
import { logError } from '../utils/logger.js';

// 커스텀 상태와 방해금지(DND). 프레즌스(User.status)와는 별개 축이다.
// 만료는 저장된 시각으로 매번 계산한다(스케줄러가 늦어도 조회와 푸시 판단은 정확하다).

export const MAX_STATUS_TEXT = 100;
export const MAX_EMOJI_LENGTH = 50;
export const MIN_FUTURE_MS = 60_000;
export const MAX_FUTURE_MS = 7 * 24 * 60 * 60 * 1000;

export const STATUS_SELECT = {
  customStatusEmoji: true,
  customStatusText: true,
  customStatusExpiresAt: true,
  dndUntil: true,
  dndWithStatus: true,
} as const;

export interface StatusFields {
  customStatusEmoji: string | null;
  customStatusText: string | null;
  customStatusExpiresAt: Date | null;
  dndUntil: Date | null;
  dndWithStatus: boolean;
}

export interface CustomStatusView { emoji: string | null; text: string | null; expiresAt: Date | null }
export interface DndView { active: boolean; until: Date | null }

/** 제어문자와 HTML 태그를 지우고 공백을 정리한다. React가 출력을 이스케이프하지만 API 층에서도 한 번 거른다. */
export function cleanStatusText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 이모지가 한 글자(자소 하나)이고 태그나 공백이 없는지 확인한다. */
export function isSingleEmoji(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMOJI_LENGTH) return false;
  if (/[\u0000-\u001f\u007f-\u009f<>&"'`\s]/.test(value)) return false;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  if ([...segmenter.segment(value)].length !== 1) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣/u.test(value);
}

function hasStatus(u: StatusFields): boolean {
  return !!(u.customStatusEmoji || u.customStatusText);
}

/** 만료가 지났거나 비어 있으면 null */
export function computeCustomStatus(u: StatusFields, now = new Date()): CustomStatusView | null {
  if (!hasStatus(u)) return null;
  if (u.customStatusExpiresAt && u.customStatusExpiresAt <= now) return null;
  return { emoji: u.customStatusEmoji, text: u.customStatusText, expiresAt: u.customStatusExpiresAt };
}

/** DND는 dndUntil이 미래이거나, 만료 없는 상태에 묶인 DND(dndWithStatus)가 살아 있으면 켜진 것이다. */
export function computeDnd(u: StatusFields, now = new Date()): DndView {
  if (u.dndUntil && u.dndUntil > now) return { active: true, until: u.dndUntil };
  if (u.dndWithStatus && !u.dndUntil && computeCustomStatus(u, now)) return { active: true, until: null };
  return { active: false, until: null };
}

export function isDndActive(u: StatusFields, now = new Date()): boolean {
  return computeDnd(u, now).active;
}

export function statusView(u: StatusFields) {
  return { customStatus: computeCustomStatus(u), dnd: computeDnd(u) };
}

/** 푸시 억제 판단용. 사용자가 없으면 false(보낼 곳이 없다). */
export async function isUserDnd(userId: number): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: STATUS_SELECT });
  return u ? isDndActive(u) : false;
}

/** 본인(모든 탭)과 같은 채널·DM을 쓰는 사용자에게 user:status를 보낸다. DB에 커밋한 뒤 부른다. */
export async function broadcastUserStatus(userId: number, fields: StatusFields): Promise<void> {
  const io = getIO();
  if (!io) return;
  try {
    const targets = new Set<number>(await getSharedUsers(userId));
    targets.add(userId);
    io.to([...targets].map((id) => `user:${id}`)).emit('user:status', { userId, ...statusView(fields) });
  } catch (err) {
    logError('user:status broadcast failed', err);
  }
}

export interface SetStatusInput {
  emoji: string | null;
  text: string | null;
  expiresAt: Date | null;
  pauseNotifications: boolean;
}

export async function setCustomStatus(userId: number, input: SetStatusInput): Promise<StatusFields> {
  // 상태와 DND를 한 트랜잭션으로 바꾼다. 체크를 풀고 저장하면 상태에 묶여 있던 DND만 풀리고,
  // 사용자가 따로 켠 DND(dndWithStatus=false)는 남는다.
  const user = await prisma.$transaction(async (tx) => {
    if (!input.pauseNotifications) {
      await tx.user.updateMany({ where: { id: userId, dndWithStatus: true }, data: { dndUntil: null } });
    }
    return tx.user.update({
      where: { id: userId },
      data: {
        customStatusEmoji: input.emoji,
        customStatusText: input.text,
        customStatusExpiresAt: input.expiresAt,
        ...(input.pauseNotifications
          ? { dndUntil: input.expiresAt, dndWithStatus: true }
          : { dndWithStatus: false }),
      },
      select: STATUS_SELECT,
    });
  });
  void broadcastUserStatus(userId, user);
  return user;
}

export async function clearCustomStatus(userId: number): Promise<StatusFields> {
  // 상태에 묶인 DND(dndWithStatus)는 함께 끈다. 사용자가 따로 켠 DND는 그대로 둔다.
  const [, user] = await prisma.$transaction([
    prisma.user.updateMany({ where: { id: userId, dndWithStatus: true }, data: { dndUntil: null } }),
    prisma.user.update({
      where: { id: userId },
      data: { customStatusEmoji: null, customStatusText: null, customStatusExpiresAt: null, dndWithStatus: false },
      select: STATUS_SELECT,
    }),
  ]);
  void broadcastUserStatus(userId, user);
  return user;
}

export async function setDnd(userId: number, until: Date): Promise<StatusFields> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { dndUntil: until, dndWithStatus: false },
    select: STATUS_SELECT,
  });
  void broadcastUserStatus(userId, user);
  return user;
}

export async function endDnd(userId: number): Promise<StatusFields> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { dndUntil: null, dndWithStatus: false },
    select: STATUS_SELECT,
  });
  void broadcastUserStatus(userId, user);
  return user;
}

/**
 * 만료된 상태와 DND를 정리하고 바뀐 사용자에게 user:status를 보낸다(scheduler.ts가 호출).
 * 정리한 사용자 수를 돌려준다.
 */
export async function clearExpired(now = new Date()): Promise<number> {
  const changed = new Set<number>();

  // 만료된 상태: 비우고, 상태에 묶인 DND도 함께 끈다.
  const expiredStatus = await prisma.user.findMany({
    where: { customStatusExpiresAt: { lte: now } },
    select: { id: true },
    take: 500,
  });
  if (expiredStatus.length > 0) {
    const ids = expiredStatus.map((u) => u.id);
    await prisma.user.updateMany({
      where: { id: { in: ids }, customStatusExpiresAt: { lte: now }, dndWithStatus: true },
      data: { dndUntil: null },
    });
    await prisma.user.updateMany({
      where: { id: { in: ids }, customStatusExpiresAt: { lte: now } },
      data: { customStatusEmoji: null, customStatusText: null, customStatusExpiresAt: null, dndWithStatus: false },
    });
    ids.forEach((id) => changed.add(id));
  }

  // 만료된 DND
  const expiredDnd = await prisma.user.findMany({
    where: { dndUntil: { lte: now } },
    select: { id: true },
    take: 500,
  });
  if (expiredDnd.length > 0) {
    const ids = expiredDnd.map((u) => u.id);
    await prisma.user.updateMany({
      where: { id: { in: ids }, dndUntil: { lte: now } },
      data: { dndUntil: null },
    });
    ids.forEach((id) => changed.add(id));
  }

  if (changed.size > 0) {
    const users = await prisma.user.findMany({ where: { id: { in: [...changed] } }, select: { id: true, ...STATUS_SELECT } });
    for (const u of users) await broadcastUserStatus(u.id, u);
  }
  return changed.size;
}
