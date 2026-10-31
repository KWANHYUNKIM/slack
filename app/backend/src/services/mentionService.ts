import type { Activity, ActivityType, Prisma } from '@prisma/client';
import prisma from '../db.js';
import { MAX_MESSAGE_LENGTH } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { getIO, isUserOnline } from '../websocket/index.js';
import { sendPushToUser } from './pushService.js';
import { KeyedQueue, settleBackgroundWork, trackBackground } from '../utils/keyedQueue.js';

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

// 같은 메시지(또는 DM)의 활동 작업은 들어온 순서대로 하나씩 돌린다. 생성 후처리가 끝나기 전에
// 편집·삭제가 오면(소켓은 이벤트를 동시에 처리한다) 삭제 정리 뒤에 생성·편집 insert가 끝나
// 지운 메시지의 활동이 남거나, 생성 때 멘션이 편집 결과를 덮어쓴다.
// 작업은 호출 시점 스냅샷이 아니라 차례가 왔을 때 DB에서 다시 읽은 메시지로 동작한다.
export const activityQueue = new KeyedQueue<string>();
export const messageKey = (id: number) => `m:${id}`;
export const dmKey = (id: number) => `d:${id}`;
export { settleBackgroundWork };

// ── 직렬화와 이벤트 ──────────────────────────────────────────────────

export interface ActivityView {
  id: number;
  type: ActivityType;
  actor: { id: number; name: string; avatar: string | null };
  channel: { id: number; name: string } | null;
  channelId: number | null;
  messageId: number | null;
  dmId: number | null;
  dmGroupId: number | null;
  threadId: number | null;
  message: { id: number; content: string; excerpt: string } | null;
  emoji: string | null;
  readAt: Date | null;
  createdAt: Date;
}

type ActorLike = { id: number; name: string; avatar: string | null };
type TargetLike = { id: number; content: string; threadId: number | null };

/** 호출자가 이미 가진 객체. 있으면 해당 id는 다시 조회하지 않는다. */
interface Preload {
  actors?: ActorLike[];
  channels?: { id: number; name: string }[];
  messages?: TargetLike[];
  dms?: TargetLike[];
}

function excerpt(content: string): string {
  return content.length > EXCERPT_LENGTH ? `${content.slice(0, EXCERPT_LENGTH)}…` : content;
}

/** Activity 행들을 화면용 객체로 바꾼다(배우·채널·메시지를 한 번에 조회). 대상 메시지가 지워졌으면 뺀다. */
export async function serializeActivities(rows: Activity[], preload: Preload = {}): Promise<ActivityView[]> {
  if (rows.length === 0) return [];
  const actorMap = new Map<number, ActorLike>((preload.actors ?? []).map((a) => [a.id, a]));
  const channelMap = new Map((preload.channels ?? []).map((c) => [c.id, c]));
  const messageMap = new Map<number, TargetLike>((preload.messages ?? []).map((m) => [m.id, m]));
  const dmMap = new Map<number, TargetLike>((preload.dms ?? []).map((d) => [d.id, d]));

  const missing = (ids: (number | null)[], have: Map<number, unknown>): number[] =>
    [...new Set(ids.filter((v): v is number => v !== null && !have.has(v)))];
  const actorIds = missing(rows.map((r) => r.actorId), actorMap);
  const channelIds = missing(rows.map((r) => r.channelId), channelMap);
  const messageIds = missing(rows.map((r) => r.messageId), messageMap);
  const dmIds = missing(rows.map((r) => r.dmId), dmMap);

  const [actors, channels, messages, dms] = await Promise.all([
    actorIds.length ? prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, avatar: true } }) : [],
    channelIds.length ? prisma.channel.findMany({ where: { id: { in: channelIds } }, select: { id: true, name: true } }) : [],
    messageIds.length
      ? prisma.message.findMany({ where: { id: { in: messageIds }, deletedAt: null }, select: { id: true, content: true, threadId: true } })
      : [],
    dmIds.length
      ? prisma.directMessage.findMany({ where: { id: { in: dmIds }, deletedAt: null }, select: { id: true, content: true, threadId: true } })
      : [],
  ]);
  actors.forEach((a) => actorMap.set(a.id, a));
  channels.forEach((c) => channelMap.set(c.id, c));
  messages.forEach((m) => messageMap.set(m.id, m));
  dms.forEach((d) => dmMap.set(d.id, d));

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
      dmGroupId: r.dmGroupId,
      threadId: target.threadId,
      message: { id: target.id, content: target.content, excerpt: excerpt(target.content) },
      emoji: r.emoji,
      readAt: r.readAt,
      createdAt: r.createdAt,
    });
  }
  return views;
}

async function emitNew(rows: Activity[], preload: Preload = {}): Promise<void> {
  const io = getIO();
  if (!io || rows.length === 0) return;
  const views = await serializeActivities(rows, preload);
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

/** 중복은 DB의 unique(NULLS NOT DISTINCT)가 막는다. 동시에 들어와도 먼저 들어간 행만 남고 충돌한 행은 조용히 건너뛴다. */
function insertActivities(data: Prisma.ActivityCreateManyInput[]): Promise<Activity[]> {
  if (data.length === 0) return Promise.resolve([]);
  return prisma.activity.createManyAndReturn({ data, skipDuplicates: true });
}

async function removeRows(rows: Pick<Activity, 'id' | 'userId'>[]): Promise<void> {
  if (rows.length === 0) return;
  await prisma.activity.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  emitRemoved(rows);
}

// ── 채널 메시지 ──────────────────────────────────────────────────────

interface ChannelMessageLike {
  id: number;
  content: string;
  userId: number;
  channelId: number;
  threadId: number | null;
  user?: ActorLike | null; // 있으면 배우 조회를 건너뛴다
}

type SyncMode = 'create' | 'edit';

/**
 * 큐 차례가 왔을 때 메시지를 다시 읽는다. 호출 시점 스냅샷은 그사이 커밋된 다른 편집(HTTP·소켓)이나
 * 삭제로 낡았을 수 있으므로 최신 내용으로 동기화한다. 지워졌으면 null.
 */
async function reloadChannelMessage(snapshot: ChannelMessageLike): Promise<ChannelMessageLike | null> {
  const m = await prisma.message.findUnique({
    where: { id: snapshot.id },
    select: { id: true, content: true, userId: true, channelId: true, threadId: true, deletedAt: true },
  });
  if (!m || m.deletedAt) return null;
  return { id: m.id, content: m.content, userId: m.userId, channelId: m.channelId, threadId: m.threadId, user: snapshot.user };
}

/**
 * 멘션 대상을 계산해 Activity를 맞춘다. 새 메시지와 편집이 같은 로직을 쓴다.
 * - 없어진 멘션은 지우고, 새로 생긴 멘션만 만든다.
 * - 직접 멘션과 @channel/@here 사이에서 종류만 바뀌면 행을 지우지 않고 type만 바꾼다(읽음 상태 보존, 재알림 없음).
 * - @here는 생성 때만 온라인 여부를 본다. 편집에서는 원래 대상만 유지한다.
 */
async function syncChannelMentions(
  msg: ChannelMessageLike,
  mode: SyncMode,
): Promise<{ created: Activity[]; removedUserIds: number[] }> {
  const parsed = parseMentions(msg.content);
  const existing = await prisma.activity.findMany({
    where: { messageId: msg.id, type: { in: MENTION_TYPES } },
  });
  const existingByUser = new Map(existing.map((a) => [a.userId, a]));

  const wantsAll = parsed.channel || (parsed.here && mode === 'create');
  const candidateIds = [...new Set([...parsed.userIds, ...existing.map((a) => a.userId)])];
  if (!wantsAll && candidateIds.length === 0) return { created: [], removedUserIds: [] };

  // 채널 멤버이면서 비활성이 아닌 사람만 대상이 된다(비공개 채널의 비멤버는 여기서 빠진다).
  const members = await prisma.channelMember.findMany({
    where: { channelId: msg.channelId, ...(!wantsAll && { userId: { in: candidateIds } }), user: { deactivatedAt: null } },
    select: { userId: true },
  });
  const memberSet = new Set(members.map((m) => m.userId));

  const typeFor = (userId: number): ActivityType | null => {
    if (!memberSet.has(userId)) return null;
    if (parsed.userIds.includes(userId)) return 'MENTION';
    if (parsed.channel) return 'CHANNEL_MENTION';
    if (parsed.here) {
      if (mode === 'create') return isUserOnline(userId) ? 'HERE_MENTION' : null;
      return existingByUser.has(userId) ? 'HERE_MENTION' : null;
    }
    return null;
  };

  const stale: Activity[] = [];
  for (const a of existing) {
    const t = typeFor(a.userId);
    if (!t) stale.push(a);
    else if (t !== a.type) await prisma.activity.update({ where: { id: a.id }, data: { type: t } });
  }
  await removeRows(stale);

  const data: Prisma.ActivityCreateManyInput[] = [];
  for (const userId of wantsAll ? memberSet : candidateIds) {
    if (userId === msg.userId || existingByUser.has(userId)) continue;
    const type = typeFor(userId);
    if (type) data.push({ userId, actorId: msg.userId, type, messageId: msg.id, channelId: msg.channelId });
  }
  return { created: await insertActivities(data), removedUserIds: stale.map((a) => a.userId) };
}

/** 스레드 답글이면 부모 작성자와 스레드 참여자에게 THREAD_REPLY를 만든다(skip 대상 제외, only가 있으면 그 사람들만). */
async function createThreadReplyActivities(msg: ChannelMessageLike, skipUserIds: Set<number>, only?: number[]): Promise<Activity[]> {
  if (!msg.threadId) return [];
  const participants = await prisma.message.findMany({
    where: { OR: [{ id: msg.threadId }, { threadId: msg.threadId }], deletedAt: null, user: { deactivatedAt: null } },
    select: { userId: true },
    distinct: ['userId'],
  });
  const candidateIds = participants
    .map((p) => p.userId)
    .filter((id) => id !== msg.userId && !skipUserIds.has(id) && (!only || only.includes(id)));
  if (candidateIds.length === 0) return [];
  const members = await prisma.channelMember.findMany({
    where: { channelId: msg.channelId, userId: { in: candidateIds } },
    select: { userId: true },
  });
  return insertActivities(
    members.map((m) => ({ userId: m.userId, actorId: msg.userId, type: 'THREAD_REPLY' as const, messageId: msg.id, channelId: msg.channelId })),
  );
}

/** 알림 후처리: 활동 이벤트와 푸시. 호출자가 가진 msg·배우·채널 이름을 재사용한다. */
async function notifyChannelActivities(
  msg: ChannelMessageLike,
  created: Activity[],
  opts: { generalPush?: boolean } = {},
): Promise<void> {
  const needsPush = opts.generalPush && !msg.threadId;
  if (created.length === 0 && !needsPush) return;

  const [channel, actor] = await Promise.all([
    prisma.channel.findUnique({ where: { id: msg.channelId }, select: { id: true, name: true } }),
    msg.user ?? prisma.user.findUnique({ where: { id: msg.userId }, select: { id: true, name: true, avatar: true } }),
  ]);
  await emitNew(created, {
    actors: actor ? [actor] : [],
    channels: channel ? [channel] : [],
    messages: [{ id: msg.id, content: msg.content, threadId: msg.threadId }],
  });

  const channelName = channel?.name ?? 'channel';
  const senderName = actor?.name ?? 'Someone';
  const url = `/c/${msg.channelId}`;
  const notified = new Set<number>();
  for (const a of created) {
    notified.add(a.userId);
    if (isUserOnline(a.userId)) continue;
    const isMention = MENTION_TYPES.includes(a.type);
    sendPushToUser(
      a.userId,
      isMention
        ? { title: `#${channelName} mention`, body: `${senderName}: ${msg.content.slice(0, 100)}`, url }
        : { title: `#${channelName} thread`, body: `${senderName}: ${msg.content.slice(0, 100)}`, url },
      { kind: isMention ? 'mention' : 'thread', channelId: msg.channelId },
    ).catch((err) => logError('Activity push dispatch failed', err));
  }

  // 일반 채널 푸시(오프라인 멤버 전체). 이미 멘션·스레드 푸시를 받은 사람은 뺀다.
  if (needsPush) {
    const members = await prisma.channelMember.findMany({ where: { channelId: msg.channelId }, select: { userId: true } });
    for (const m of members) {
      if (m.userId === msg.userId || notified.has(m.userId) || isUserOnline(m.userId)) continue;
      sendPushToUser(
        m.userId,
        { title: `#${channelName}`, body: `${senderName}: ${msg.content.slice(0, 100) || 'Sent an attachment'}`, url },
        { kind: 'message', channelId: msg.channelId },
      ).catch((err) => logError('Push notification dispatch failed', err));
    }
  }
}

/**
 * 채널 메시지 생성 후처리의 단일 진입점(HTTP, 소켓, 예약 발송, 웹훅이 모두 호출).
 * message:new 브로드캐스트와 HTTP/ack 응답 **뒤에** 부르고 await하지 않는다. 실패는 로그만 남긴다.
 */
async function processNewChannelMessageImpl(snapshot: ChannelMessageLike, opts: { generalPush?: boolean } = {}): Promise<Activity[]> {
  try {
    const msg = await reloadChannelMessage(snapshot);
    if (!msg) return [];
    const { created: mentions } = await syncChannelMentions(msg, 'create');
    const replies = await createThreadReplyActivities(msg, new Set(mentions.map((a) => a.userId)));
    const created = [...mentions, ...replies];
    await notifyChannelActivities(msg, created, opts);
    return created;
  } catch (err) {
    logError('Process new message failed', err);
    return [];
  }
}

/** 채널 메시지 편집 후 호출: 바뀐 멘션을 동기화한다(추가분만 알림). 응답 뒤에 await 없이 부른다. */
async function syncActivitiesOnEditImpl(snapshot: ChannelMessageLike): Promise<Activity[]> {
  try {
    const msg = await reloadChannelMessage(snapshot);
    if (!msg) return [];
    const { created, removedUserIds } = await syncChannelMentions(msg, 'edit');
    const all = [...created];
    if (msg.threadId) {
      // 새 멘션을 받은 사람의 THREAD_REPLY는 멘션으로 대체하고, 멘션이 빠진 사람은 THREAD_REPLY로 되돌린다.
      if (created.length > 0) {
        const dup = await prisma.activity.findMany({
          where: { messageId: msg.id, type: 'THREAD_REPLY', userId: { in: created.map((a) => a.userId) } },
          select: { id: true, userId: true },
        });
        await removeRows(dup);
      }
      if (removedUserIds.length > 0) {
        const holders = await prisma.activity.findMany({ where: { messageId: msg.id, type: { in: MENTION_TYPES } }, select: { userId: true } });
        all.push(...(await createThreadReplyActivities(msg, new Set(holders.map((h) => h.userId)), removedUserIds)));
      }
    }
    await notifyChannelActivities(msg, all);
    return all;
  } catch (err) {
    logError('Sync activities on edit failed', err);
    return [];
  }
}

/** 메시지(채널 또는 스레드 답글)가 지워질 때 그 메시지와 연결된 Activity를 정리한다. */
async function deleteActivitiesForMessageImpl(messageId: number): Promise<void> {
  try {
    await removeRows(await prisma.activity.findMany({ where: { messageId }, select: { id: true, userId: true } }));
  } catch (err) {
    logError('Delete activities failed', err);
  }
}

// ── DM ───────────────────────────────────────────────────────────────

interface DmLike {
  id: number;
  content: string;
  fromUserId: number;
  toUserId: number | null; // 그룹 메시지는 null
  groupId?: number | null;
  threadId: number | null;
  fromUser?: ActorLike | null;
}

/**
 * 그룹 DM의 활동을 맞춘다. 멤버 중 멘션된 사람은 MENTION, 스레드 답글이면 부모 작성자와 스레드 참여자(멘션 제외)는 THREAD_REPLY.
 * 멤버가 아니거나 비활성인 사람은 대상이 아니다(멘션 서비스는 그룹 멤버 한정).
 */
async function syncGroupDmActivities(dm: DmLike & { groupId: number }): Promise<Activity[]> {
  const members = await prisma.dMGroupMember.findMany({
    where: { groupId: dm.groupId, userId: { not: dm.fromUserId }, user: { deactivatedAt: null } },
    select: { userId: true },
  });
  const memberSet = new Set(members.map((m) => m.userId));
  const wanted = new Map<number, ActivityType>();
  for (const id of parseMentions(dm.content).userIds) if (memberSet.has(id)) wanted.set(id, 'MENTION');
  if (dm.threadId) {
    const participants = await prisma.directMessage.findMany({
      where: { OR: [{ id: dm.threadId }, { threadId: dm.threadId }], deletedAt: null },
      select: { fromUserId: true },
      distinct: ['fromUserId'],
    });
    for (const p of participants) {
      if (memberSet.has(p.fromUserId) && !wanted.has(p.fromUserId)) wanted.set(p.fromUserId, 'THREAD_REPLY');
    }
  }

  const existing = await prisma.activity.findMany({ where: { dmId: dm.id, type: { in: ['MENTION', 'THREAD_REPLY'] } } });
  await removeRows(existing.filter((a) => wanted.get(a.userId) !== a.type));
  const have = new Set(existing.filter((a) => wanted.get(a.userId) === a.type).map((a) => a.userId));
  const data: Prisma.ActivityCreateManyInput[] = [];
  for (const [userId, type] of wanted) {
    if (!have.has(userId)) data.push({ userId, actorId: dm.fromUserId, type, dmId: dm.id, dmGroupId: dm.groupId });
  }
  return insertActivities(data);
}

/** DM의 활동을 맞춘다: 상대를 멘션하면 MENTION, 아니면 스레드 답글일 때 THREAD_REPLY. 생성과 편집이 같이 쓴다. */
async function syncDmActivities(dm: DmLike): Promise<Activity[]> {
  if (dm.groupId) return syncGroupDmActivities({ ...dm, groupId: dm.groupId });
  if (dm.toUserId === null) return [];
  const mentioned = dm.fromUserId !== dm.toUserId && parseMentions(dm.content).userIds.includes(dm.toUserId);
  const existing = await prisma.activity.findMany({ where: { dmId: dm.id, type: { in: ['MENTION', 'THREAD_REPLY'] } } });

  let wanted: ActivityType | null = null;
  if (dm.fromUserId !== dm.toUserId) {
    if (mentioned) wanted = 'MENTION';
    else if (dm.threadId) wanted = 'THREAD_REPLY';
  }
  await removeRows(existing.filter((a) => a.type !== wanted));
  if (!wanted || existing.some((a) => a.type === wanted)) return [];

  const recipient = await prisma.user.findUnique({ where: { id: dm.toUserId }, select: { deactivatedAt: true } });
  if (!recipient || recipient.deactivatedAt) return [];
  return insertActivities([{ userId: dm.toUserId, actorId: dm.fromUserId, type: wanted, dmId: dm.id }]);
}

/** reloadChannelMessage의 DM판. */
async function reloadDm(snapshot: DmLike): Promise<DmLike | null> {
  const d = await prisma.directMessage.findUnique({
    where: { id: snapshot.id },
    select: { id: true, content: true, fromUserId: true, toUserId: true, groupId: true, threadId: true, deletedAt: true },
  });
  if (!d || d.deletedAt) return null;
  return {
    id: d.id,
    content: d.content,
    fromUserId: d.fromUserId,
    toUserId: d.toUserId,
    groupId: d.groupId,
    threadId: d.threadId,
    fromUser: snapshot.fromUser,
  };
}

async function notifyDmActivities(dm: DmLike, created: Activity[]): Promise<void> {
  if (created.length === 0) return;
  const actor = dm.fromUser ?? (await prisma.user.findUnique({ where: { id: dm.fromUserId }, select: { id: true, name: true, avatar: true } }));
  await emitNew(created, {
    actors: actor ? [actor] : [],
    dms: [{ id: dm.id, content: dm.content, threadId: dm.threadId }],
  });
}

/** DM 전송·답글 직후 호출. 응답 뒤에 await 없이 부른다. */
async function createActivitiesForDmImpl(snapshot: DmLike): Promise<Activity[]> {
  try {
    const dm = await reloadDm(snapshot);
    if (!dm) return [];
    const created = await syncDmActivities(dm);
    await notifyDmActivities(dm, created);
    return created;
  } catch (err) {
    logError('Create DM activities failed', err);
    return [];
  }
}

async function deleteActivitiesForDmImpl(dmId: number): Promise<void> {
  try {
    await removeRows(await prisma.activity.findMany({ where: { dmId }, select: { id: true, userId: true } }));
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
  dmGroupId?: number; // 그룹 DM 메시지의 리액션이면 그룹 id
  channelId?: number;
  actor?: ActorLike;
}

/** 내 메시지에 달린 리액션을 활동으로 남긴다. 자기 자신, 비활성 사용자, 채널을 떠난 작성자는 제외. */
async function createReactionActivityImpl(t: ReactionTarget): Promise<Activity | null> {
  try {
    if (t.targetUserId === t.actorId) return null;
    // 대상 삭제 여부와 작성자 상태를 한 번에 본다(삭제 정리가 먼저 끝났으면 만들지 않는다).
    const author = { select: { deactivatedAt: true } };
    const target = t.messageId
      ? await prisma.message.findUnique({ where: { id: t.messageId }, select: { deletedAt: true, user: author } })
      : t.dmId
        ? await prisma.directMessage
          .findUnique({ where: { id: t.dmId }, select: { deletedAt: true, fromUser: author } })
          .then((d) => d && { deletedAt: d.deletedAt, user: d.fromUser })
        : null;
    if (!target || target.deletedAt || target.user.deactivatedAt) return null;
    if (t.channelId) {
      const member = await prisma.channelMember.findUnique({
        where: { userId_channelId: { userId: t.targetUserId, channelId: t.channelId } },
      });
      if (!member) return null;
    }
    if (t.dmGroupId) {
      const member = await prisma.dMGroupMember.findUnique({
        where: { groupId_userId: { groupId: t.dmGroupId, userId: t.targetUserId } },
      });
      if (!member) return null; // 그룹을 나간 작성자에게는 남기지 않는다
    }
    const where = {
      userId: t.targetUserId,
      actorId: t.actorId,
      type: 'REACTION' as const,
      emoji: t.emoji,
      messageId: t.messageId ?? null,
      dmId: t.dmId ?? null,
    };
    const [created] = await insertActivities([{ ...where, channelId: t.channelId ?? null, dmGroupId: t.dmGroupId ?? null }]);
    if (!created) return null; // 이미 있음(동시 요청 포함)
    await emitNew([created], { actors: t.actor ? [t.actor] : [] });
    return created;
  } catch (err) {
    logError('Create reaction activity failed', err);
    return null;
  }
}

/** 리액션을 지우면 그 리액션이 만든 활동도 지운다. */
async function removeReactionActivityImpl(t: Pick<ReactionTarget, 'actorId' | 'emoji' | 'messageId' | 'dmId'>): Promise<void> {
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

/** 채널을 messageId까지 읽었을 때, 채널 최상위 메시지의 멘션만 읽음 처리한다(스레드 답글 멘션은 스레드를 열 때 읽는다). */
export async function markChannelMentionsRead(userId: number, channelId: number, upToMessageId: number): Promise<number[]> {
  const candidates = await prisma.activity.findMany({
    where: { userId, readAt: null, channelId, type: { in: MENTION_TYPES }, messageId: { lte: upToMessageId } },
    select: { messageId: true },
  });
  const ids = candidates.map((c) => c.messageId).filter((v): v is number => v !== null);
  if (ids.length === 0) return [];
  const topLevel = await prisma.message.findMany({ where: { id: { in: ids }, threadId: null }, select: { id: true } });
  if (topLevel.length === 0) return [];
  return markRead(userId, { channelId, type: { in: MENTION_TYPES }, messageId: { in: topLevel.map((m) => m.id) } });
}

/** 스레드를 열었을 때 그 스레드 답글에 달린 멘션을 읽음 처리한다. */
async function markThreadMentionsReadImpl(userId: number, parentId: number): Promise<number[]> {
  const replies = await prisma.message.findMany({ where: { threadId: parentId }, select: { id: true } });
  if (replies.length === 0) return [];
  return markRead(userId, { type: { in: MENTION_TYPES }, messageId: { in: replies.map((r) => r.id) } });
}

/** 1:1 DM 대화를 열어 읽었을 때 상대가 보낸 멘션을 읽음 처리한다(그룹 DM 멘션은 건드리지 않는다). */
export function markDmMentionsRead(userId: number, otherUserId: number): Promise<number[]> {
  return markRead(userId, { actorId: otherUserId, dmId: { not: null }, dmGroupId: null, type: { in: MENTION_TYPES } });
}

/** 그룹 DM을 열어 읽었을 때 그 그룹의 멘션을 읽음 처리한다. */
export function markDmGroupMentionsRead(userId: number, groupId: number): Promise<number[]> {
  return markRead(userId, { dmGroupId: groupId, type: { in: MENTION_TYPES } });
}

/** 활동 탭 API: id 목록 또는 전체. 내 활동만 건드린다. */
export function markActivitiesRead(userId: number, opts: { ids?: number[]; all?: boolean }): Promise<number[]> {
  return markRead(userId, opts.all ? {} : { id: { in: opts.ids ?? [] } });
}

/** 내가 지금 볼 수 있는 활동 범위: 1:1 DM 활동, 내가 멤버인 채널의 활동, 내가 멤버인 그룹 DM의 활동. */
export async function visibleActivityWhere(userId: number) {
  const [memberships, groups] = await Promise.all([
    prisma.channelMember.findMany({ where: { userId }, select: { channelId: true } }),
    prisma.dMGroupMember.findMany({ where: { userId }, select: { groupId: true } }),
  ]);
  return {
    userId,
    OR: [
      { channelId: null, dmGroupId: null },
      { channelId: { in: memberships.map((m) => m.channelId) } },
      { dmGroupId: { in: groups.map((g) => g.groupId) } },
    ],
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

/** 1:1 DM 상대별 안 읽은 멘션 수. */
export async function getMentionCountsByDmPartner(userId: number): Promise<Map<number, number>> {
  const rows = await prisma.activity.groupBy({
    by: ['actorId'],
    where: { userId, readAt: null, type: { in: MENTION_TYPES }, dmId: { not: null }, dmGroupId: null },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.actorId, r._count._all]));
}

/** 그룹 DM별 안 읽은 멘션 수(내가 멤버인 그룹만). */
export async function getMentionCountsByDmGroup(userId: number, groupIds: number[]): Promise<Map<number, number>> {
  if (groupIds.length === 0) return new Map();
  const rows = await prisma.activity.groupBy({
    by: ['dmGroupId'],
    where: { userId, readAt: null, type: { in: MENTION_TYPES }, dmGroupId: { in: groupIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.dmGroupId as number, r._count._all]));
}

// ── 공개 진입점(백그라운드 추적 포함) ────────────────────────────────

// 같은 대상의 생성·편집·삭제·리액션은 activityQueue로 순서를 지킨다. 각 Impl은 오류를 스스로 잡아 로그만 남기므로
// 돌려주는 promise는 reject하지 않는다. 호출자는 기다리지 않는다(삭제 응답이 앞선 @channel 생성 작업에 막히지 않게).

/** 리액션은 달린 메시지(또는 DM)의 키로 직렬화한다. 둘 다 없으면 모든 리액션이 한 키에 묶이므로 실행하지 않는다. */
function reactionKey(t: { messageId?: number; dmId?: number }): string | null {
  if (t.messageId) return messageKey(t.messageId);
  if (t.dmId) return dmKey(t.dmId);
  logError('Reaction activity without messageId or dmId', new Error('missing reaction target'));
  return null;
}

export const processNewChannelMessage = (...a: Parameters<typeof processNewChannelMessageImpl>) =>
  activityQueue.run(messageKey(a[0].id), () => processNewChannelMessageImpl(...a));
export const syncActivitiesOnEdit = (...a: Parameters<typeof syncActivitiesOnEditImpl>) =>
  activityQueue.run(messageKey(a[0].id), () => syncActivitiesOnEditImpl(...a));
export const deleteActivitiesForMessage = (messageId: number) =>
  activityQueue.run(messageKey(messageId), () => deleteActivitiesForMessageImpl(messageId));
export const createActivitiesForDm = (...a: Parameters<typeof createActivitiesForDmImpl>) =>
  activityQueue.run(dmKey(a[0].id), () => createActivitiesForDmImpl(...a));
export const syncActivitiesOnDmEdit = createActivitiesForDm;
export const deleteActivitiesForDm = (dmId: number) => activityQueue.run(dmKey(dmId), () => deleteActivitiesForDmImpl(dmId));
export function createReactionActivity(...a: Parameters<typeof createReactionActivityImpl>): Promise<Activity | null> {
  const key = reactionKey(a[0]);
  return key ? activityQueue.run(key, () => createReactionActivityImpl(...a)) : Promise.resolve(null);
}
export function removeReactionActivity(...a: Parameters<typeof removeReactionActivityImpl>): Promise<void> {
  const key = reactionKey(a[0]);
  return key ? activityQueue.run(key, () => removeReactionActivityImpl(...a)) : Promise.resolve();
}
export const markThreadMentionsRead = (...a: Parameters<typeof markThreadMentionsReadImpl>) => trackBackground(markThreadMentionsReadImpl(...a));
