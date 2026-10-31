import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { getIO } from '../websocket/index.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { deleteStoredFile } from './fileStorage.js';
import { deleteActivitiesForMessage, deleteActivitiesForDm } from './mentionService.js';

// 데이터 보존(E5). 워크스페이스 기본 + 채널별 덮어쓰기로 "N일 지난 메시지"를 영구 삭제한다.
//
// 삭제 방식: 소프트 삭제(deletedAt)가 아니라 하드 삭제다. 소프트 삭제는 내용을 DB에 남겨 두므로 보존 정책의 목적(데이터 제거)에 맞지 않는다.
// 스레드: 답글이 남아 있는 부모는 지우지 않고 "자리표시자"로 바꾼다(deletedAt 설정 + 내용·첨부·리액션 제거).
// 이렇게 하면 04의 삭제된 부모 표시 규칙이 그대로 통하고 답글의 threadId가 끊어지지 않는다. 답글이 모두 사라진 뒤 다음 배치가 부모를 지운다.

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_BATCH = 1000;
const PURGE_MAX_BATCHES = 100; // 한 번에 최대 10만 건. 남은 것은 다음 날 이어서 지운다.
const SETTING_ID = 1;

// ── 정책 ────────────────────────────────────────────────────────────

export async function getWorkspaceRetentionDays(): Promise<number | null> {
  const row = await prisma.workspaceSetting.findUnique({ where: { id: SETTING_ID } });
  return row?.messageRetentionDays ?? null;
}

export async function setWorkspaceRetentionDays(days: number | null): Promise<void> {
  await prisma.workspaceSetting.upsert({
    where: { id: SETTING_ID },
    create: { id: SETTING_ID, messageRetentionDays: days },
    update: { messageRetentionDays: days },
  });
}

/** 채널에 실제로 적용되는 일수. override: null=기본을 따름, 0=이 채널만 무기한. 결과 null은 무기한. */
export function effectiveDays(override: number | null, workspaceDays: number | null): number | null {
  if (override === null) return workspaceDays;
  return override > 0 ? override : null;
}

const cutoffFor = (days: number, now: Date) => new Date(now.getTime() - days * DAY_MS);

// ── 정리 ────────────────────────────────────────────────────────────

export interface PurgeCounts {
  messages: number; // 지운 메시지
  files: number; // 지운 첨부 파일
  placeholders: number; // 답글이 남아 자리표시자로 바꾼 부모
}

const emptyCounts = (): PurgeCounts => ({ messages: 0, files: 0, placeholders: 0 });
const add = (a: PurgeCounts, b: PurgeCounts) => {
  a.messages += b.messages;
  a.files += b.files;
  a.placeholders += b.placeholders;
};

type FileRow = { id: number; filename: string; gcsPath: string | null; messageId: number | null; dmId: number | null };

/**
 * 파일 본체를 저장소에서 먼저 지운다. 지우지 못한 파일의 주인 메시지 id를 돌려준다(그 메시지는 이번에 지우지 않고 다음에 다시 시도한다).
 * 본체를 먼저 지우는 이유: 반대로 하면 DB만 지워지고 본체가 남아 영영 못 찾는다. 본체만 없는 행은 404로 끝나 해롭지 않다.
 */
async function removeStoredFiles(files: FileRow[]): Promise<{ failedOwners: Set<number>; removedIds: number[] }> {
  const failedOwners = new Set<number>();
  const removedIds: number[] = [];
  for (const f of files) {
    if (await deleteStoredFile(f)) removedIds.push(f.id);
    else failedOwners.add((f.messageId ?? f.dmId)!);
  }
  return { failedOwners, removedIds };
}

/** 채널 메시지 한 채널분. 배치 예산(budget.left)을 공유한다. */
async function purgeChannel(channelId: number, cutoff: Date, budget: { left: number }): Promise<PurgeCounts> {
  const counts = emptyCounts();
  while (budget.left > 0) {
    budget.left--;
    // 잎 먼저: 답글이 남은 부모는 건드리지 않는다. 법적 보존 대상 사용자의 메시지는 제외한다.
    const rows = await prisma.message.findMany({
      where: { channelId, createdAt: { lt: cutoff }, user: { legalHold: false }, replies: { none: {} } },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PURGE_BATCH,
    });
    if (rows.length === 0) break;
    const done = await deleteMessages(rows.map((r) => r.id), channelId);
    add(counts, done);
    // 답글을 지우면 그 부모가 다음 조회에서 잎이 된다. 진행이 없으면(저장소 오류 등) 멈춘다.
    if (done.messages === 0) break;
  }
  counts.placeholders += await blankParents(channelId, cutoff);
  return counts;
}

async function deleteMessages(ids: number[], channelId: number): Promise<PurgeCounts> {
  const files = await prisma.file.findMany({
    where: { messageId: { in: ids } },
    select: { id: true, filename: true, gcsPath: true, messageId: true, dmId: true },
  });
  const { failedOwners, removedIds } = await removeStoredFiles(files);
  const targets = ids.filter((id) => !failedOwners.has(id));
  if (targets.length === 0) return emptyCounts();

  // replies none: 조회 뒤에 새 답글이 달렸다면 그 부모는 지우지 않는다(답글의 threadId가 끊어지지 않게).
  // 리액션·북마크·스레드 읽음은 FK cascade, 읽음 위치는 SetNull, 첨부 행은 SetNull이라 아래에서 따로 지운다.
  await prisma.message.deleteMany({ where: { id: { in: targets }, replies: { none: {} } } });
  const remaining = new Set((await prisma.message.findMany({ where: { id: { in: targets } }, select: { id: true } })).map((m) => m.id));
  const gone = targets.filter((id) => !remaining.has(id));

  const fileIds = removedIds.filter((id) => gone.includes(files.find((f) => f.id === id)!.messageId!));
  if (fileIds.length > 0) await prisma.file.deleteMany({ where: { id: { in: fileIds }, messageId: null } });
  if (gone.length > 0) {
    await prisma.reminder.deleteMany({ where: { messageId: { in: gone } } });
    await cleanupActivities(gone.map((id) => ({ id, queue: () => deleteActivitiesForMessage(id) })), { messageId: { in: gone } });
    const io = getIO();
    if (io) for (const id of gone) io.to(`channel:${channelId}`).emit('message:deleted', { messageId: id, threadId: null, channelId });
  }
  return { messages: gone.length, files: fileIds.length, placeholders: 0 };
}

/**
 * 활동 정리. 활동 큐(메시지별 직렬화)를 거쳐 지우면 아직 돌고 있는 생성 작업과 경쟁하지 않는다.
 * 큐가 놓치는 종류(리마인더 활동)는 마지막에 직접 지운다.
 */
async function cleanupActivities(
  targets: { id: number; queue: () => Promise<unknown> }[],
  where: Prisma.ActivityWhereInput,
): Promise<void> {
  try {
    const withActivity = new Set(
      (await prisma.activity.findMany({ where, select: { messageId: true, dmId: true } })).map((a) => a.messageId ?? a.dmId),
    );
    for (const t of targets) if (withActivity.has(t.id)) await t.queue();
    await prisma.activity.deleteMany({ where });
  } catch (error) {
    logError('Retention activity cleanup failed', error);
  }
}

/** 만료됐지만 답글이 남은 부모를 자리표시자로 바꾼다. 이미 바뀐 것은 다시 건드리지 않는다. 바꾼 수를 돌려준다. */
async function blankParents(channelId: number, cutoff: Date): Promise<number> {
  let total = 0;
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const rows = await prisma.message.findMany({
      where: {
        channelId,
        createdAt: { lt: cutoff },
        user: { legalHold: false },
        replies: { some: {} },
        OR: [{ deletedAt: null }, { content: { not: '' } }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PURGE_BATCH,
    });
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const files = await prisma.file.findMany({
      where: { messageId: { in: ids } },
      select: { id: true, filename: true, gcsPath: true, messageId: true, dmId: true },
    });
    const { failedOwners, removedIds } = await removeStoredFiles(files);
    const targets = ids.filter((id) => !failedOwners.has(id));
    if (targets.length === 0) break; // 저장소 오류. 같은 행만 다시 잡히므로 멈추고 다음 실행에 맡긴다.
    await prisma.$transaction([
      prisma.file.deleteMany({ where: { id: { in: removedIds } } }),
      prisma.reaction.deleteMany({ where: { messageId: { in: targets } } }),
      prisma.bookmark.deleteMany({ where: { messageId: { in: targets } } }),
      prisma.message.updateMany({ where: { id: { in: targets }, deletedAt: null }, data: { deletedAt: new Date() } }),
      prisma.message.updateMany({
        where: { id: { in: targets } },
        data: { content: '', isPinned: false, pinnedBy: null, pinnedAt: null, alsoSendToChannel: false },
      }),
    ]);
    await prisma.reminder.deleteMany({ where: { messageId: { in: targets } } });
    await cleanupActivities(targets.map((id) => ({ id, queue: () => deleteActivitiesForMessage(id) })), { messageId: { in: targets } });
    total += targets.length;
    if (rows.length < PURGE_BATCH || targets.length < ids.length) break;
  }
  return total;
}

// DM과 그룹 DM. 보호 대상은 보낸 사람, 받은 사람, 그룹 구성원 중 한 명이라도 법적 보존이면 제외한다.
const dmHeldFilter: Prisma.DirectMessageWhereInput = {
  fromUser: { legalHold: false },
  OR: [{ toUserId: null }, { toUser: { legalHold: false } }],
  AND: [{ OR: [{ groupId: null }, { group: { members: { none: { user: { legalHold: true } } } } }] }],
};

async function purgeDirectMessages(cutoff: Date, budget: { left: number }): Promise<PurgeCounts> {
  const counts = emptyCounts();
  while (budget.left > 0) {
    budget.left--;
    const rows = await prisma.directMessage.findMany({
      where: { createdAt: { lt: cutoff }, replies: { none: {} }, ...dmHeldFilter },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PURGE_BATCH,
    });
    if (rows.length === 0) break;
    const done = await deleteDms(rows.map((r) => r.id));
    add(counts, done);
    if (done.messages === 0) break;
  }
  counts.placeholders += await blankDmParents(cutoff);
  return counts;
}

async function deleteDms(ids: number[]): Promise<PurgeCounts> {
  const files = await prisma.file.findMany({
    where: { dmId: { in: ids } },
    select: { id: true, filename: true, gcsPath: true, messageId: true, dmId: true },
  });
  const { failedOwners, removedIds } = await removeStoredFiles(files);
  const targets = ids.filter((id) => !failedOwners.has(id));
  if (targets.length === 0) return emptyCounts();

  await prisma.directMessage.deleteMany({ where: { id: { in: targets }, replies: { none: {} } } });
  const remaining = new Set((await prisma.directMessage.findMany({ where: { id: { in: targets } }, select: { id: true } })).map((m) => m.id));
  const gone = targets.filter((id) => !remaining.has(id));

  const fileIds = removedIds.filter((id) => gone.includes(files.find((f) => f.id === id)!.dmId!));
  if (fileIds.length > 0) await prisma.file.deleteMany({ where: { id: { in: fileIds }, dmId: null } });
  if (gone.length > 0) {
    await prisma.reminder.deleteMany({ where: { dmId: { in: gone } } });
    await cleanupActivities(gone.map((id) => ({ id, queue: () => deleteActivitiesForDm(id) })), { dmId: { in: gone } });
  }
  return { messages: gone.length, files: fileIds.length, placeholders: 0 };
}

async function blankDmParents(cutoff: Date): Promise<number> {
  let total = 0;
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const rows = await prisma.directMessage.findMany({
      where: { createdAt: { lt: cutoff }, replies: { some: {} }, OR: [{ deletedAt: null }, { content: { not: '' } }], AND: [dmHeldFilter] },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: PURGE_BATCH,
    });
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const files = await prisma.file.findMany({
      where: { dmId: { in: ids } },
      select: { id: true, filename: true, gcsPath: true, messageId: true, dmId: true },
    });
    const { failedOwners, removedIds } = await removeStoredFiles(files);
    const targets = ids.filter((id) => !failedOwners.has(id));
    if (targets.length === 0) break;
    await prisma.$transaction([
      prisma.file.deleteMany({ where: { id: { in: removedIds } } }),
      prisma.dMReaction.deleteMany({ where: { dmId: { in: targets } } }),
      prisma.directMessage.updateMany({ where: { id: { in: targets }, deletedAt: null }, data: { deletedAt: new Date() } }),
      prisma.directMessage.updateMany({ where: { id: { in: targets } }, data: { content: '', isPinned: false, pinnedBy: null, pinnedAt: null } }),
    ]);
    await prisma.reminder.deleteMany({ where: { dmId: { in: targets } } });
    await cleanupActivities(targets.map((id) => ({ id, queue: () => deleteActivitiesForDm(id) })), { dmId: { in: targets } });
    total += targets.length;
    if (rows.length < PURGE_BATCH || targets.length < ids.length) break;
  }
  return total;
}

const countsDetails = (days: number, c: PurgeCounts) => `days=${days}; messages=${c.messages}; files=${c.files}; placeholders=${c.placeholders}`;

/**
 * 정책에 따라 만료된 메시지를 지운다. 채널별 결과는 감사 로그 retention.purged로 남긴다(건수가 0이면 남기지 않는다).
 * 한 채널이 실패해도 나머지는 계속하고, 하나라도 실패했으면 마지막에 던져 스케줄러가 1시간 뒤 다시 시도하게 한다.
 */
export async function purgeExpiredMessages(now: Date = new Date()): Promise<PurgeCounts> {
  const workspaceDays = await getWorkspaceRetentionDays();
  const total = emptyCounts();
  const budget = { left: PURGE_MAX_BATCHES };
  let failed = 0;

  // 법적 보존 채널은 목록에서 뺀다
  const channels = await prisma.channel.findMany({
    where: { legalHold: false },
    select: { id: true, name: true, retentionDays: true },
    orderBy: { id: 'asc' },
  });
  for (const ch of channels) {
    const days = effectiveDays(ch.retentionDays, workspaceDays);
    if (!days) continue;
    if (budget.left <= 0) break;
    try {
      const c = await purgeChannel(ch.id, cutoffFor(days, now), budget);
      add(total, c);
      if (c.messages > 0 || c.placeholders > 0) {
        await writeAuditLog({ action: 'retention.purged', targetType: 'channel', targetId: ch.id, targetName: ch.name, details: countsDetails(days, c) });
      }
    } catch (error) {
      failed++;
      logError(`Retention purge failed for channel ${ch.id}`, error);
    }
  }

  // DM과 그룹 DM은 워크스페이스 정책을 따른다
  if (workspaceDays && budget.left > 0) {
    try {
      const c = await purgeDirectMessages(cutoffFor(workspaceDays, now), budget);
      add(total, c);
      if (c.messages > 0 || c.placeholders > 0) {
        await writeAuditLog({ action: 'retention.purged', targetType: 'direct_message', targetName: 'dm', details: countsDetails(workspaceDays, c) });
      }
    } catch (error) {
      failed++;
      logError('Retention purge failed for direct messages', error);
    }
  }

  if (failed > 0) throw new Error(`Retention purge failed for ${failed} target(s)`);
  return total;
}
