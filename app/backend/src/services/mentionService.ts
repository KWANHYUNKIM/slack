import type { Activity, ActivityType } from '@prisma/client';
import prisma from '../db.js';
import { MAX_MESSAGE_LENGTH } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { getIO, isUserOnline } from '../websocket/index.js';
import { sendPushToUser } from './pushService.js';

// 멘션 파싱, 활동(Activity) 생성·동기화·정리를 한 곳에 모은다.
// HTTP 라우트와 WebSocket 핸들러가 모두 이 서비스를 불러야 두 경로의 동작이 같아진다.

export const MENTION_TYPES: ActivityType[] = ['MENTION', 'CHANNEL_MENTION', 'HERE_MENTION'];

const MAX_MENTIONS_PER_MESSAGE = 50;
const MAX_INT4 = 2147483647;
const EXCERPT_LENGTH = 200;

export interface ParsedMentions {
  userIds: number[];
  here: boolean;
  channel: boolean;
}

/**
 * 메시지 본문에서 멘션을 뽑는다. 규칙은 프런트 renderMessageContent.tsx와 같다:
 * `<@id|name>`, `<@here>`, `<@channel>`. 맨 `@word`는 멘션이 아니다.
 * ReDoS 방지: 먼저 본문 길이를 자르고, 이름 부분은 길이를 제한해 시작 위치마다 끝까지 훑지 않게 한다.
 */
export function parseMentions(content: string): ParsedMentions {
  const text = typeof content === 'string' ? content.slice(0, MAX_MESSAGE_LENGTH) : '';
  const userIds = new Set<number>();
  for (const m of text.matchAll(/<@(\d{1,10})\|([^>]{1,100})>/g)) {
    const id = Number(m[1]);
    if (id > 0 && id <= MAX_INT4) userIds.add(id);
    if (userIds.size >= MAX_MENTIONS_PER_MESSAGE) break;
  }
  return {
    userIds: [...userIds],
    here: text.includes('<@here>'),
    channel: text.includes('<@channel>'),
  };
}

// ── 직렬화와 이벤트 ──────────────────────────────────────────────────

export interface ActivityView {
  id: number;
  type: ActivityType;
  actor: { id: number; name: string; avatar: string | null };
  channel: { id: number; name: string } | null;
  channelId: number | null;
  messageId: number | null;
  dmId: number | null;
  threadId: number | null;
  message: { id: number; content: string; excerpt: string } | null;
  emoji: string | null;
  readAt: Date | null;
  createdAt: Date;
}

function excerpt(content: string): string {
  return content.length > EXCERPT_LENGTH ? `${content.slice(0, EXCERPT_LENGTH)}…` : content;
}

/** Activity 행들을 화면용 객체로 바꾼다(배우·채널·메시지를 한 번에 조회). 대상 메시지가 지워졌으면 뺀다. */
export async function serializeActivities(rows: Activity[]): Promise<ActivityView[]> {
  if (rows.length === 0) return [];
  const actorIds = [...new Set(rows.map((r) => r.actorId))];
  const channelIds = [...new Set(rows.map((r) => r.channelId).filter((v): v is number => v !== null))];
  const messageIds = [...new Set(rows.map((r) => r.messageId).filter((v): v is number => v !== null))];
  const dmIds = [...new Set(rows.map((r) => r.dmId).filter((v): v is number => v !== null))];

  const [actors, channels, messages, dms] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, avatar: true } }),
    channelIds.length ? prisma.channel.findMany({ where: { id: { in: channelIds } }, select: { id: true, name: true } }) : [],
    messageIds.length
      ? prisma.message.findMany({ where: { id: { in: messageIds }, deletedAt: null }, select: { id: true, content: true, threadId: true } })
      : [],
    dmIds.length
      ? prisma.directMessage.findMany({ where: { id: { in: dmIds }, deletedAt: null }, select: { id: true, content: true, threadId: true } })
      : [],
  ]);
  const actorMap = new Map(actors.map((a) => [a.id, a]));
  const channelMap = new Map(channels.map((c) => [c.id, c]));
  const messageMap = new Map(messages.map((m) => [m.id, m]));
  const dmMap = new Map(dms.map((d) => [d.id, d]));

  const views: ActivityView[] = [];
  for (const r of rows) {
    const target = r.messageId !== null ? messageMap.get(r.messageId) : r.dmId !== null ? dmMap.get(r.dmId) : undefined;
    const actor = actorMap.get(r.actorId);
    if (!target || !actor) continue;
    views.push({
      id: r.id,
      type: r.type,
      actor,
      channel: r.channelId !== null ? channelMap.get(r.channelId) ?? null : null,
      channelId: r.channelId,
      messageId: r.messageId,
      dmId: r.dmId,
      threadId: target.threadId,
      message: { id: target.id, content: target.content, excerpt: excerpt(target.content) },
      emoji: r.emoji,
      readAt: r.readAt,
      createdAt: r.createdAt,
    });
  }
  return views;
}

async function emitNew(rows: Activity[]): Promise<void> {
  const io = getIO();
  if (!io || rows.length === 0) return;
  const views = await serializeActivities(rows);
  const byId = new Map(rows.map((r) => [r.id, r.userId]));
  for (const view of views) {
    io.to(`user:${byId.get(view.id)}`).emit('activity:new', { activity: view });
  }
}

function emitRemoved(rows: Pick<Activity, 'id' | 'userId'>[]): void {
  const io = getIO();
  if (!io || rows.length === 0) return;
  const perUser = new Map<number, number[]>();
  for (const r of rows) perUser.set(r.userId, [...(perUser.get(r.userId) ?? []), r.id]);
  for (const [userId, ids] of perUser) io.to(`user:${userId}`).emit('activity:removed', { ids });
}

export function emitRead(userId: number, ids: number[]): void {
  if (ids.length === 0) return;
  getIO()?.to(`user:${userId}`).emit('activity:read', { ids });
}

// ── 채널 메시지 ──────────────────────────────────────────────────────

interface ChannelMessageLike {
  id: number;
  content: string;
  userId: number;
  channelId: number;
  threadId: number | null;
}

/** 멘션 대상을 계산해 Activity를 맞춘다. 새 메시지와 편집이 같은 로직을 쓴다(없어진 멘션은 지우고 새 멘션만 추가). */
async function syncChannelMentions(msg: ChannelMessageLike): Promise<Activity[]> {
  const parsed = parseMentions(msg.content);
  const existing = await prisma.activity.findMany({
    where: { messageId: msg.id, type: { in: MENTION_TYPES } },
  });

  const stale = existing.filter(
    (a) =>
      !(a.type === 'MENTION' && parsed.userIds.includes(a.userId)) &&
      !(a.type === 'HERE_MENTION' && parsed.here) &&
      !(a.type === 'CHANNEL_MENTION' && parsed.channel),
  );
  if (stale.length > 0) {
    await prisma.activity.deleteMany({ where: { id: { in: stale.map((a) => a.id) } } });
    emitRemoved(stale);
  }
  const staleIds = new Set(stale.map((a) => a.id));
  const have = new Set(existing.filter((a) => !staleIds.has(a.id)).map((a) => a.userId));

  if (!parsed.userIds.length && !parsed.here && !parsed.channel) return [];

  // 채널 멤버이면서 비활성이 아닌 사람만 대상이 된다(비공개 채널의 비멤버는 여기서 빠진다).
  const wantIds = parsed.here || parsed.channel ? undefined : parsed.userIds;
  const members = await prisma.channelMember.findMany({
    where: { channelId: msg.channelId, ...(wantIds && { userId: { in: wantIds } }), user: { deactivatedAt: null } },
    select: { userId: true },
  });
  const memberIds = members.map((m) => m.userId);
  const memberSet = new Set(memberIds);

  const wanted = new Map<number, ActivityType>();
  if (parsed.channel) for (const id of memberIds) wanted.set(id, 'CHANNEL_MENTION');
  if (parsed.here) for (const id of memberIds) if (isUserOnline(id)) wanted.set(id, 'HERE_MENTION');
  for (const id of parsed.userIds) if (memberSet.has(id)) wanted.set(id, 'MENTION');

  const data = [...wanted]
    .filter(([userId]) => userId !== msg.userId && !have.has(userId))
    .map(([userId, type]) => ({ userId, actorId: msg.userId, type, messageId: msg.id, channelId: msg.channelId }));
  if (data.length === 0) return [];
  return prisma.activity.createManyAndReturn({ data });
}

/** 스레드 답글이면 부모 작성자와 스레드 참여자에게 THREAD_REPLY를 만든다(이미 멘션 받은 사람 제외). */
async function createThreadReplyActivities(msg: ChannelMessageLike, skipUserIds: Set<number>): Promise<Activity[]> {
  if (!msg.threadId) return [];
  const participants = await prisma.message.findMany({
    where: { OR: [{ id: msg.threadId }, { threadId: msg.threadId }], deletedAt: null, user: { deactivatedAt: null } },
    select: { userId: true },
    distinct: ['userId'],
  });
  const candidateIds = participants.map((p) => p.userId).filter((id) => id !== msg.userId && !skipUserIds.has(id));
  if (candidateIds.length === 0) return [];
  const members = await prisma.channelMember.findMany({
    where: { channelId: msg.channelId, userId: { in: candidateIds } },
    select: { userId: true },
  });
  const existing = await prisma.activity.findMany({
    where: { messageId: msg.id, type: 'THREAD_REPLY', userId: { in: candidateIds } },
    select: { userId: true },
  });
  const done = new Set(existing.map((e) => e.userId));
  const data = members
    .filter((m) => !done.has(m.userId))
    .map((m) => ({ userId: m.userId, actorId: msg.userId, type: 'THREAD_REPLY' as const, messageId: msg.id, channelId: msg.channelId }));
  if (data.length === 0) return [];
  return prisma.activity.createManyAndReturn({ data });
}

async function pushMentions(msg: ChannelMessageLike, created: Activity[]): Promise<void> {
  const targets = created.filter((a) => MENTION_TYPES.includes(a.type) && !isUserOnline(a.userId));
  if (targets.length === 0) return;
  const [channel, actor] = await Promise.all([
    prisma.channel.findUnique({ where: { id: msg.channelId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: msg.userId }, select: { name: true } }),
  ]);
  for (const a of targets) {
    sendPushToUser(
      a.userId,
      {
        title: `#${channel?.name ?? 'channel'} mention`,
        body: `${actor?.name ?? 'Someone'}: ${msg.content.slice(0, 100)}`,
        url: `/c/${msg.channelId}`,
      },
      { kind: 'mention', channelId: msg.channelId },
    ).catch((err) => logError('Mention push dispatch failed', err));
  }
}

/** 채널 메시지 생성 직후 호출: 멘션과 스레드 답글 Activity를 만들고 `activity:new`와 푸시를 보낸다. */
export async function createActivitiesForMessage(msg: ChannelMessageLike): Promise<Activity[]> {
  try {
    const mentions = await syncChannelMentions(msg);
    const replies = await createThreadReplyActivities(msg, new Set(mentions.map((a) => a.userId)));
    const created = [...mentions, ...replies];
    await emitNew(created);
    await pushMentions(msg, mentions);
    return created;
  } catch (err) {
    logError('Create activities failed', err);
    return [];
  }
}

/** 채널 메시지 편집 후 호출: 바뀐 멘션을 동기화한다(추가분만 알림). */
export async function syncActivitiesOnEdit(msg: ChannelMessageLike): Promise<Activity[]> {
  try {
    const created = await syncChannelMentions(msg);
    await emitNew(created);
    await pushMentions(msg, created);
    return created;
  } catch (err) {
    logError('Sync activities on edit failed', err);
    return [];
  }
}

/** 메시지(채널 또는 스레드 답글)가 지워질 때 그 메시지와 연결된 Activity를 정리한다. */
export async function deleteActivitiesForMessage(messageId: number): Promise<void> {
  try {
    const rows = await prisma.activity.findMany({ where: { messageId }, select: { id: true, userId: true } });
    if (rows.length === 0) return;
    await prisma.activity.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    emitRemoved(rows);
  } catch (err) {
    logError('Delete activities failed', err);
  }
}

// ── DM ───────────────────────────────────────────────────────────────

interface DmLike {
  id: number;
  content: string;
  fromUserId: number;
  toUserId: number;
  threadId: number | null;
}

async function syncDmMentions(dm: DmLike): Promise<Activity[]> {
  const parsed = parseMentions(dm.content);
  const existing = await prisma.activity.findMany({ where: { dmId: dm.id, type: 'MENTION' } });
  const mentioned = dm.fromUserId !== dm.toUserId && parsed.userIds.includes(dm.toUserId);

  if (!mentioned && existing.length > 0) {
    await prisma.activity.deleteMany({ where: { id: { in: existing.map((a) => a.id) } } });
    emitRemoved(existing);
  }
  if (!mentioned || existing.length > 0) return [];

  const recipient = await prisma.user.findUnique({ where: { id: dm.toUserId }, select: { deactivatedAt: true } });
  if (!recipient || recipient.deactivatedAt) return [];
  return prisma.activity.createManyAndReturn({
    data: [{ userId: dm.toUserId, actorId: dm.fromUserId, type: 'MENTION', dmId: dm.id }],
  });
}

/** DM 전송·답글 직후 호출: 상대를 멘션했으면 MENTION, 스레드 답글이면 THREAD_REPLY를 만든다. */
export async function createActivitiesForDm(dm: DmLike): Promise<Activity[]> {
  try {
    const created = await syncDmMentions(dm);
    if (dm.threadId && dm.fromUserId !== dm.toUserId && created.length === 0) {
      const recipient = await prisma.user.findUnique({ where: { id: dm.toUserId }, select: { deactivatedAt: true } });
      if (recipient && !recipient.deactivatedAt) {
        created.push(
          ...(await prisma.activity.createManyAndReturn({
            data: [{ userId: dm.toUserId, actorId: dm.fromUserId, type: 'THREAD_REPLY', dmId: dm.id }],
          })),
        );
      }
    }
    await emitNew(created);
    return created;
  } catch (err) {
    logError('Create DM activities failed', err);
    return [];
  }
}

export async function syncActivitiesOnDmEdit(dm: DmLike): Promise<Activity[]> {
  try {
    const created = await syncDmMentions(dm);
    await emitNew(created);
    return created;
  } catch (err) {
    logError('Sync DM activities on edit failed', err);
    return [];
  }
}

export async function deleteActivitiesForDm(dmId: number): Promise<void> {
  try {
    const rows = await prisma.activity.findMany({ where: { dmId }, select: { id: true, userId: true } });
    if (rows.length === 0) return;
    await prisma.activity.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    emitRemoved(rows);
  } catch (err) {
    logError('Delete DM activities failed', err);
  }
}

// ── 리액션 ───────────────────────────────────────────────────────────

interface ReactionTarget {
  actorId: number;
  targetUserId: number; // 리액션이 달린 메시지의 작성자
  emoji: string;
  messageId?: number;
  dmId?: number;
  channelId?: number;
}

/** 내 메시지에 달린 리액션을 활동으로 남긴다. 자기 자신, 비활성 사용자, 채널을 떠난 작성자는 제외. */
export async function createReactionActivity(t: ReactionTarget): Promise<Activity | null> {
  try {
    if (t.targetUserId === t.actorId) return null;
    const author = await prisma.user.findUnique({ where: { id: t.targetUserId }, select: { deactivatedAt: true } });
    if (!author || author.deactivatedAt) return null;
    if (t.channelId) {
      const member = await prisma.channelMember.findUnique({
        where: { userId_channelId: { userId: t.targetUserId, channelId: t.channelId } },
      });
      if (!member) return null;
    }
    const where = {
      userId: t.targetUserId,
      actorId: t.actorId,
      type: 'REACTION' as const,
      emoji: t.emoji,
      messageId: t.messageId ?? null,
      dmId: t.dmId ?? null,
    };
    if (await prisma.activity.findFirst({ where, select: { id: true } })) return null;
    const created = await prisma.activity.create({ data: { ...where, channelId: t.channelId ?? null } });
    await emitNew([created]);
    return created;
  } catch (err) {
    logError('Create reaction activity failed', err);
    return null;
  }
}

/** 리액션을 지우면 그 리액션이 만든 활동도 지운다. */
export async function removeReactionActivity(t: Pick<ReactionTarget, 'actorId' | 'emoji' | 'messageId' | 'dmId'>): Promise<void> {
  try {
    const rows = await prisma.activity.findMany({
      where: { type: 'REACTION', actorId: t.actorId, emoji: t.emoji, messageId: t.messageId ?? null, dmId: t.dmId ?? null },
      select: { id: true, userId: true },
    });
    if (rows.length === 0) return;
    await prisma.activity.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    emitRemoved(rows);
  } catch (err) {
    logError('Remove reaction activity failed', err);
  }
}

// ── 읽음 처리와 카운트 ───────────────────────────────────────────────

async function markRead(userId: number, where: object): Promise<number[]> {
  const rows = await prisma.activity.findMany({ where: { userId, readAt: null, ...where }, select: { id: true } });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  await prisma.activity.updateMany({ where: { id: { in: ids }, userId }, data: { readAt: new Date() } });
  emitRead(userId, ids);
  return ids;
}

/** 채널을 messageId까지 읽었을 때 그 채널의 멘션을 읽음 처리한다. */
export function markChannelMentionsRead(userId: number, channelId: number, upToMessageId: number): Promise<number[]> {
  return markRead(userId, { channelId, type: { in: MENTION_TYPES }, messageId: { lte: upToMessageId } });
}

/** DM 대화를 열어 읽었을 때 상대가 보낸 멘션을 읽음 처리한다. */
export function markDmMentionsRead(userId: number, otherUserId: number): Promise<number[]> {
  return markRead(userId, { actorId: otherUserId, dmId: { not: null }, type: { in: MENTION_TYPES } });
}

/** 활동 탭 API: id 목록 또는 전체. 내 활동만 건드린다. */
export function markActivitiesRead(userId: number, opts: { ids?: number[]; all?: boolean }): Promise<number[]> {
  return markRead(userId, opts.all ? {} : { id: { in: opts.ids ?? [] } });
}

/** 내가 지금 볼 수 있는 활동 범위: DM 활동, 또는 내가 멤버인 채널의 활동. */
export async function visibleActivityWhere(userId: number) {
  const memberships = await prisma.channelMember.findMany({ where: { userId }, select: { channelId: true } });
  return {
    userId,
    OR: [{ channelId: null }, { channelId: { in: memberships.map((m) => m.channelId) } }],
  };
}

/** 채널별 안 읽은 멘션 수. */
export async function getMentionCountsByChannel(userId: number, channelIds: number[]): Promise<Map<number, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await prisma.activity.groupBy({
    by: ['channelId'],
    where: { userId, readAt: null, type: { in: MENTION_TYPES }, channelId: { in: channelIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.channelId as number, r._count._all]));
}

/** DM 상대별 안 읽은 멘션 수. */
export async function getMentionCountsByDmPartner(userId: number): Promise<Map<number, number>> {
  const rows = await prisma.activity.groupBy({
    by: ['actorId'],
    where: { userId, readAt: null, type: { in: MENTION_TYPES }, dmId: { not: null } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.actorId, r._count._all]));
}
