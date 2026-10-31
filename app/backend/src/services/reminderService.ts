import type { Reminder } from '@prisma/client';
import prisma from '../db.js';
import { getIO, isUserOnline } from '../websocket/index.js';
import { logError } from '../utils/logger.js';
import { sendPushToUser } from './pushService.js';
import { createReminderActivity, deleteReminderActivities } from './mentionService.js';

// 리마인더 생성·조회·변경과 시각 도달 처리. 알림은 활동(REMINDER)과 푸시로 보내고,
// 방해금지 억제는 pushService.shouldNotify(kind: 'reminder')가 맡는다(활동은 남는다).

export const MAX_PENDING_REMINDERS = 200;
export const MAX_REMINDER_TEXT = 500;
export const MIN_FUTURE_MS = 1000;
export const MAX_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;
const DUE_BATCH = 50;
/** 발송 실패를 이만큼 겪으면 failedAt을 찍고 더 시도하지 않는다 */
export const MAX_DELIVERY_ATTEMPTS = 3;
const EXCERPT_LENGTH = 200;

export interface ReminderView {
  id: number;
  messageId: number | null;
  dmId: number | null;
  channelId: number | null;
  text: string | null;
  remindAt: Date;
  firedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  channel: { id: number; name: string } | null;
  /** 대상이 있었는데 지워졌거나 더는 볼 수 없으면 true(화면에서 "삭제된 메시지") */
  messageDeleted: boolean;
  message: { id: number; excerpt: string; user: { id: number; name: string }; threadId: number | null } | null;
  /** 1:1 DM이면 상대 id, 그룹 DM이면 groupId (이동용) */
  dmUserId: number | null;
  dmGroupId: number | null;
}

const excerpt = (c: string) => (c.length > EXCERPT_LENGTH ? `${c.slice(0, EXCERPT_LENGTH)}…` : c);

// ── 접근 권한 ────────────────────────────────────────────────────────

/** 채널 메시지: 존재하고 지워지지 않았으며 내가 채널 멤버여야 한다. */
export async function resolveMessageTarget(userId: number, messageId: number): Promise<{ channelId: number } | null> {
  const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { channelId: true, deletedAt: true } });
  if (!msg || msg.deletedAt) return null;
  const member = await prisma.channelMember.findUnique({
    where: { userId_channelId: { userId, channelId: msg.channelId } },
    select: { userId: true },
  });
  return member ? { channelId: msg.channelId } : null;
}

/** DM 메시지: 1:1이면 보낸 사람 또는 받는 사람, 그룹이면 멤버여야 한다. */
export async function resolveDmTarget(userId: number, dmId: number): Promise<boolean> {
  const dm = await prisma.directMessage.findUnique({
    where: { id: dmId },
    select: { fromUserId: true, toUserId: true, groupId: true, deletedAt: true },
  });
  if (!dm || dm.deletedAt) return false;
  if (dm.groupId !== null) {
    const m = await prisma.dMGroupMember.findFirst({ where: { groupId: dm.groupId, userId }, select: { userId: true } });
    return !!m;
  }
  return dm.fromUserId === userId || dm.toUserId === userId;
}

// ── 직렬화 ───────────────────────────────────────────────────────────

export async function serializeReminders(userId: number, rows: Reminder[]): Promise<ReminderView[]> {
  if (rows.length === 0) return [];
  const messageIds = [...new Set(rows.map((r) => r.messageId).filter((v): v is number => v !== null))];
  const dmIds = [...new Set(rows.map((r) => r.dmId).filter((v): v is number => v !== null))];
  const channelIds = [...new Set(rows.map((r) => r.channelId).filter((v): v is number => v !== null))];
  const [messages, dms, memberships, groups, channels] = await Promise.all([
    messageIds.length
      ? prisma.message.findMany({
          where: { id: { in: messageIds }, deletedAt: null },
          select: { id: true, content: true, channelId: true, threadId: true, user: { select: { id: true, name: true } } },
        })
      : [],
    dmIds.length
      ? prisma.directMessage.findMany({
          where: { id: { in: dmIds }, deletedAt: null },
          select: { id: true, content: true, fromUserId: true, toUserId: true, groupId: true, threadId: true, fromUser: { select: { id: true, name: true } } },
        })
      : [],
    prisma.channelMember.findMany({ where: { userId }, select: { channelId: true } }),
    prisma.dMGroupMember.findMany({ where: { userId }, select: { groupId: true } }),
    channelIds.length ? prisma.channel.findMany({ where: { id: { in: channelIds } }, select: { id: true, name: true } }) : [],
  ]);
  const channelMap = new Map(channels.map((c) => [c.id, c]));
  const myChannels = new Set(memberships.map((m) => m.channelId));
  const myGroups = new Set(groups.map((g) => g.groupId));
  const messageMap = new Map(messages.map((m) => [m.id, m]));
  const dmMap = new Map(dms.map((d) => [d.id, d]));

  return rows.map((r) => {
    let message: ReminderView['message'] = null;
    let dmUserId: number | null = null;
    let dmGroupId: number | null = null;
    if (r.messageId !== null) {
      const m = messageMap.get(r.messageId);
      // 채널을 나갔다면 내용을 보여주지 않는다
      if (m && myChannels.has(m.channelId)) message = { id: m.id, excerpt: excerpt(m.content), user: m.user, threadId: m.threadId };
    } else if (r.dmId !== null) {
      const d = dmMap.get(r.dmId);
      if (d) {
        const allowed = d.groupId !== null ? myGroups.has(d.groupId) : d.fromUserId === userId || d.toUserId === userId;
        if (allowed) {
          message = { id: d.id, excerpt: excerpt(d.content), user: d.fromUser, threadId: d.threadId };
          dmGroupId = d.groupId;
          dmUserId = d.groupId === null ? (d.fromUserId === userId ? d.toUserId : d.fromUserId) : null;
        }
      }
    }
    return {
      id: r.id,
      messageId: r.messageId,
      dmId: r.dmId,
      channelId: r.channelId,
      text: r.text,
      remindAt: r.remindAt,
      firedAt: r.firedAt,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
      channel: r.channelId !== null ? channelMap.get(r.channelId) ?? null : null,
      messageDeleted: (r.messageId !== null || r.dmId !== null) && message === null,
      message,
      dmUserId,
      dmGroupId,
    };
  });
}

// ── 푸시 문구 ────────────────────────────────────────────────────────

// 서버에는 사용자 로캘이 없다. 리마인더를 만들 때 요청의 Accept-Language를 저장해 두고 그 언어로 푸시를 보낸다.
// 해석하지 못하면 기본 ko.
export type PushLocale = 'ko' | 'en';
export const DEFAULT_PUSH_LOCALE: PushLocale = 'ko';

const PUSH_TEXT: Record<PushLocale, { title: string; fallbackBody: string }> = {
  ko: { title: '리마인더', fallbackBody: '메시지에 대한 리마인더' },
  en: { title: 'Reminder', fallbackBody: 'Reminder about a message' },
};

/** Accept-Language 헤더에서 지원 언어를 고른다(앞선 항목 우선). 지원하지 않으면 null. */
export function pickLocale(header: string | undefined | null): PushLocale | null {
  if (!header) return null;
  for (const part of header.split(',').slice(0, 8)) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (tag === 'ko' || tag.startsWith('ko-')) return 'ko';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return null;
}

export function pushTextFor(locale: string | null | undefined, body: string): { title: string; body: string } {
  const texts = PUSH_TEXT[locale === 'en' ? 'en' : DEFAULT_PUSH_LOCALE];
  return { title: texts.title, body: body.trim() ? body.slice(0, 100) : texts.fallbackBody };
}

// ── 소켓 ─────────────────────────────────────────────────────────────

/** 직렬화를 이미 한 뷰를 본인 모든 탭에 보낸다(경로마다 직렬화는 한 번만). */
export function emitReminder(event: 'reminder:due' | 'reminder:updated', userId: number, reminder: ReminderView): void {
  try {
    getIO()?.to(`user:${userId}`).emit(event, { reminder });
  } catch (err) {
    logError(`${event} emit failed`, err);
  }
}

export function emitReminderRemoved(userId: number, id: number): void {
  getIO()?.to(`user:${userId}`).emit('reminder:removed', { id });
}

// ── 시각 도달 처리 ───────────────────────────────────────────────────

/**
 * 시각이 지난 리마인더를 한 번만 발송한다. firedAt을 updateMany로 먼저 선점(fireSeq +1)하므로
 * 틱이 겹치거나 서버가 여러 대여도 한 회차는 한 번만 간다. 처리한 개수를 돌려준다.
 * 발송이 실패하면 선점을 되돌려 다음 틱에 다시 시도하고, MAX_DELIVERY_ATTEMPTS번 실패하면 failedAt을 찍는다.
 */
export async function processDueReminders(now = new Date()): Promise<number> {
  const due = await prisma.reminder.findMany({
    where: { firedAt: null, completedAt: null, failedAt: null, remindAt: { lte: now } },
    orderBy: { remindAt: 'asc' },
    take: DUE_BATCH,
    select: { id: true },
  });
  let fired = 0;
  for (const { id } of due) {
    let claimed: Reminder | null = null;
    try {
      const res = await prisma.reminder.updateMany({
        where: { id, firedAt: null, completedAt: null, failedAt: null },
        data: { firedAt: now, fireSeq: { increment: 1 } },
      });
      if (res.count === 0) continue;
      fired++;
      claimed = await prisma.reminder.findUnique({ where: { id } });
      if (claimed) await deliverReminder(claimed);
    } catch (err) {
      logError(`Reminder ${id} delivery failed`, err);
      if (claimed) await rollbackClaim(claimed);
    }
  }
  return fired;
}

/** 발송 실패: 이 회차의 활동을 치우고 선점을 되돌린다. 상한에 닿으면 failedAt을 찍는다. */
async function rollbackClaim(r: Reminder): Promise<void> {
  try {
    await deleteReminderActivities(r.id, r.fireSeq).catch((err) => logError('Reminder rollback cleanup failed', err));
    // 그사이 스누즈·삭제·완료로 회차가 바뀌었다면 건드리지 않는다
    const reverted = await prisma.reminder.updateMany({
      where: { id: r.id, fireSeq: r.fireSeq, firedAt: r.firedAt },
      data: { firedAt: null, failCount: { increment: 1 } },
    });
    if (reverted.count === 0) return;
    const cur = await prisma.reminder.findUnique({ where: { id: r.id }, select: { failCount: true } });
    if (cur && cur.failCount >= MAX_DELIVERY_ATTEMPTS) {
      await prisma.reminder.updateMany({ where: { id: r.id, failedAt: null }, data: { failedAt: new Date() } });
      logError(`Reminder ${r.id} gave up after ${cur.failCount} failed deliveries`, new Error('reminder delivery failed'));
    }
  } catch (err) {
    logError(`Reminder ${r.id} rollback failed`, err);
  }
}

/** 이 회차가 아직 유효한가: 스누즈(firedAt 초기화), 완료, 삭제가 끼어들지 않았는지. */
async function isStillCurrent(r: Reminder): Promise<boolean> {
  const cur = await prisma.reminder.findUnique({ where: { id: r.id }, select: { firedAt: true, fireSeq: true, completedAt: true } });
  return !!cur && cur.completedAt === null && cur.fireSeq === r.fireSeq && cur.firedAt !== null && cur.firedAt.getTime() === r.firedAt?.getTime();
}

async function deliverReminder(r: Reminder): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: r.userId }, select: { deactivatedAt: true } });
  if (!user || user.deactivatedAt) return;
  if (!(await isStillCurrent(r))) return;

  await createReminderActivity(r);
  // 활동을 만드는 사이 스누즈·완료·삭제가 지나갔다면 방금 만든 활동을 치우고 알리지 않는다
  if (!(await isStillCurrent(r))) {
    await deleteReminderActivities(r.id, r.fireSeq);
    return;
  }

  const [view] = await serializeReminders(r.userId, [r]);
  emitReminder('reminder:due', r.userId, view);

  // 푸시: 접속 중이면 토스트로 충분하다. 방해금지는 shouldNotify가 막는다.
  if (isUserOnline(r.userId)) return;
  const text = pushTextFor(r.locale, r.text ?? view.message?.excerpt ?? '');
  const url = view.dmGroupId ? `/g/${view.dmGroupId}` : view.dmUserId ? `/d/${view.dmUserId}` : r.channelId ? `/c/${r.channelId}` : '/';
  await sendPushToUser(r.userId, { ...text, url }, { kind: 'reminder', channelId: r.channelId ?? undefined })
    .catch((err) => logError('Reminder push failed', err));
}

export { deleteReminderActivities };
