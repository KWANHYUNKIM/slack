import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { getIO } from '../websocket/index.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { deleteStoredFile } from './fileStorage.js';
import { emitRemoved } from './mentionService.js';
import { onThreadReplyDeleted, onThreadParentDeleted } from './threadService.js';
import { getGroupMemberIds, groupVisibilityWhere } from './dmGroupService.js';

// 데이터 보존(E5). 워크스페이스 기본 + 채널별 덮어쓰기로 "N일 지난 메시지"를 영구 삭제한다.
//
// 삭제 방식: 소프트 삭제(deletedAt)가 아니라 하드 삭제다. 소프트 삭제는 내용을 DB에 남겨 두므로 보존 정책의 목적(데이터 제거)에 맞지 않는다.
// 스레드: 답글이 남아 있는 부모는 지우지 않고 "자리표시자"로 바꾼다(deletedAt 설정 + 내용·첨부·리액션 제거).
// 이렇게 하면 04의 삭제된 부모 표시 규칙이 그대로 통하고 답글의 threadId가 끊어지지 않는다. 답글이 모두 사라진 뒤 다음 배치가 부모를 지운다.
// 리마인더는 지우지 않는다(스키마 규칙: FK 없이 남아 화면에서 "삭제된 메시지"로 보인다).
// 소켓 이벤트는 사용자 삭제 경로(messageService, dmService)와 같은 것을 보낸다.

export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_BATCH = 1000;
export const PURGE_MAX_ROWS = 100_000; // 한 번에 처리하는 행 수 상한(채널 메시지, DM, 자리표시자 전환, 고아 파일 합계). 남은 것은 다음 날 이어서 한다.
const SETTING_ID = 1;

// ── 법적 보존 제외 조건(E6) ──────────────────────────────────────────
// 활성 보존 건(LegalHold.releasedAt 없음)의 대상자이거나 User.legalHold 플래그가 켜져 있으면 보존 대상이다(둘 중 하나라도).
// 플래그는 legalHoldService가 동기화하는 캐시지만 정리는 관계를 직접 본다. 선택한 뒤에 보존이 걸려도 지우지 않도록
// 선택 문장과 삭제 문장(deleteMany, 자리표시자 전환) 모두에 같은 조건을 넣고, 파일 본체를 지우기 직전에 한 번 더 거른다.
const HELD_USER: Prisma.UserWhereInput = { OR: [{ legalHold: true }, { legalHoldCustody: { some: { hold: { releasedAt: null } } } }] };
const NOT_HELD_USER: Prisma.UserWhereInput = { legalHold: false, legalHoldCustody: { none: { hold: { releasedAt: null } } } };
const CHANNEL_NOT_HELD: Prisma.ChannelWhereInput = { legalHold: false, members: { none: { user: HELD_USER } } };
const MESSAGE_NOT_HELD: Prisma.MessageWhereInput = { user: NOT_HELD_USER, channel: CHANNEL_NOT_HELD };

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
  partial: boolean; // 행 수 상한 때문에 할 일이 남았다
}

const emptyCounts = (): PurgeCounts => ({ messages: 0, files: 0, placeholders: 0, partial: false });
const add = (a: PurgeCounts, b: PurgeCounts) => {
  a.messages += b.messages;
  a.files += b.files;
  a.placeholders += b.placeholders;
  a.partial = a.partial || b.partial;
};

/** 처리한 행 수를 세는 공용 예산 */
interface Budget {
  left: number;
  /** 테스트용: 배치를 고른 직후(지우기 전)에 부른다. 선택과 삭제 사이에 보존이 걸리는 경우를 재현한다. */
  afterSelect?: () => Promise<void>;
}

type FileRow = { id: number; filename: string; gcsPath: string | null; messageId: number | null; dmId: number | null };
const FILE_SELECT = { id: true, filename: true, gcsPath: true, messageId: true, dmId: true } as const;

/**
 * 파일 본체를 저장소에서 먼저 지운다. 지우지 못한 파일의 주인(메시지 또는 DM) id와, 지운 파일 id를 돌려준다.
 * 지우지 못한 주인은 이번에 지우지 않고 다음에 다시 시도한다.
 * 본체를 먼저 지우는 이유: 반대로 하면 DB만 지워지고 본체가 남아 영영 못 찾는다. 본체만 없는 행은 404로 끝나 해롭지 않다.
 */
async function removeStoredFiles(files: FileRow[]): Promise<{ failedOwners: Set<number>; removed: FileRow[] }> {
  const failedOwners = new Set<number>();
  const removed: FileRow[] = [];
  for (const f of files) {
    if (await deleteStoredFile(f)) removed.push(f);
    else if (f.messageId ?? f.dmId) failedOwners.add((f.messageId ?? f.dmId)!);
  }
  return { failedOwners, removed };
}

/** 지운 파일 중 주인이 실제로 사라진 것만 DB 행을 지운다(주인 FK가 SetNull이라 messageId/dmId가 null이 된 행). */
async function deleteFileRows(removed: FileRow[], goneOwners: Set<number>, key: 'messageId' | 'dmId'): Promise<number> {
  const ids = removed.filter((f) => goneOwners.has(f[key]!)).map((f) => f.id);
  if (ids.length === 0) return 0;
  const { count } = await prisma.file.deleteMany({ where: { id: { in: ids }, [key]: null } });
  return count;
}

/**
 * 활동 정리: 지운 메시지·DM을 가리키는 활동을 한 번에 지우고 클라이언트에 알린다.
 * 리마인더 활동은 남긴다(리마인더 행이 남으므로. 사용자 삭제 경로와 같다).
 */
async function cleanupActivities(where: Prisma.ActivityWhereInput): Promise<void> {
  try {
    const rows = await prisma.activity.findMany({ where: { ...where, type: { not: 'REMINDER' } }, select: { id: true, userId: true } });
    if (rows.length === 0) return;
    await prisma.activity.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    emitRemoved(rows);
  } catch (error) {
    logError('Retention activity cleanup failed', error);
  }
}

type ChannelRow = { id: number; userId: number; threadId: number | null };

/** 채널 메시지 한 채널분. */
async function purgeChannel(channelId: number, cutoff: Date, budget: Budget): Promise<PurgeCounts> {
  const counts = emptyCounts();
  // 잎 먼저: 답글이 남은 부모는 건드리지 않는다. 법적 보존 대상 사용자의 메시지는 제외한다.
  const leafWhere: Prisma.MessageWhereInput = { channelId, createdAt: { lt: cutoff }, ...MESSAGE_NOT_HELD, replies: { none: {} } };
  for (;;) {
    const take = Math.min(PURGE_BATCH, budget.left);
    if (take <= 0) {
      counts.partial = (await prisma.message.findFirst({ where: leafWhere, select: { id: true } })) !== null;
      break;
    }
    const rows = await prisma.message.findMany({ where: leafWhere, select: { id: true, userId: true, threadId: true }, orderBy: { id: 'asc' }, take });
    if (rows.length === 0) break;
    budget.left -= rows.length;
    await budget.afterSelect?.();
    const done = await deleteMessages(rows, channelId);
    add(counts, done);
    // 답글을 지우면 그 부모가 다음 조회에서 잎이 된다. 진행이 없으면(저장소 오류 등) 멈춘다.
    if (done.messages === 0) break;
  }
  add(counts, await blankParents(channelId, cutoff, budget));
  return counts;
}

/** 지금도 보존 대상이 아닌 메시지 id만 남긴다(선택 뒤에 보존이 걸렸을 수 있다) */
async function stillPurgeableMessages(ids: number[]): Promise<number[]> {
  const rows = await prisma.message.findMany({ where: { id: { in: ids }, ...MESSAGE_NOT_HELD }, select: { id: true } });
  return rows.map((r) => r.id);
}

async function deleteMessages(rows: ChannelRow[], channelId: number): Promise<PurgeCounts> {
  const ids = await stillPurgeableMessages(rows.map((r) => r.id));
  if (ids.length === 0) return emptyCounts();
  const files = await prisma.file.findMany({ where: { messageId: { in: ids } }, select: FILE_SELECT });
  const { failedOwners, removed } = await removeStoredFiles(files);
  const targets = ids.filter((id) => !failedOwners.has(id));
  if (targets.length === 0) return emptyCounts();

  // replies none: 조회 뒤에 새 답글이 달렸다면 그 부모는 지우지 않는다(답글의 threadId가 끊어지지 않게).
  // 리액션·북마크·스레드 읽음은 FK cascade, 읽음 위치는 SetNull, 첨부 행은 SetNull이라 따로 지운다.
  await prisma.message.deleteMany({ where: { id: { in: targets }, replies: { none: {} }, ...MESSAGE_NOT_HELD } });
  const remaining = new Set((await prisma.message.findMany({ where: { id: { in: targets } }, select: { id: true } })).map((m) => m.id));
  const gone = new Set(targets.filter((id) => !remaining.has(id)));
  if (gone.size === 0) return emptyCounts();

  const fileCount = await deleteFileRows(removed, gone, 'messageId');
  await cleanupActivities({ messageId: { in: [...gone] } });

  const io = getIO();
  const goneRows = rows.filter((r) => gone.has(r.id));
  for (const r of goneRows) io?.to(`channel:${channelId}`).emit('message:deleted', { messageId: r.id, threadId: r.threadId ?? null, channelId });

  // 사용자 삭제 경로처럼 답글 수·참여자를 갱신한다. 부모별로 한 번만 부르고, 부모가 이미 없으면 건너뛴다.
  const lastReplyByParent = new Map<number, ChannelRow>();
  for (const r of goneRows) if (r.threadId) lastReplyByParent.set(r.threadId, r);
  if (lastReplyByParent.size > 0) {
    const alive = await prisma.message.findMany({ where: { id: { in: [...lastReplyByParent.keys()] } }, select: { id: true } });
    for (const p of alive) {
      const r = lastReplyByParent.get(p.id)!;
      void onThreadReplyDeleted({ id: r.id, userId: r.userId, channelId, threadId: p.id });
    }
  }
  return { messages: gone.size, files: fileCount, placeholders: 0, partial: false };
}

/** 만료됐지만 답글이 남은 부모를 자리표시자로 바꾼다. 이미 바뀐 것은 다시 건드리지 않는다. */
async function blankParents(channelId: number, cutoff: Date, budget: Budget): Promise<PurgeCounts> {
  const counts = emptyCounts();
  const where: Prisma.MessageWhereInput = {
    channelId,
    createdAt: { lt: cutoff },
    ...MESSAGE_NOT_HELD,
    replies: { some: {} },
    OR: [{ deletedAt: null }, { content: { not: '' } }],
  };
  for (;;) {
    const take = Math.min(PURGE_BATCH, budget.left);
    if (take <= 0) {
      counts.partial = (await prisma.message.findFirst({ where, select: { id: true } })) !== null;
      break;
    }
    const rows = await prisma.message.findMany({ where, select: { id: true, userId: true }, orderBy: { id: 'asc' }, take });
    if (rows.length === 0) break;
    budget.left -= rows.length;
    await budget.afterSelect?.();
    const ids = new Set(await stillPurgeableMessages(rows.map((r) => r.id)));
    if (ids.size === 0) break;
    const files = await prisma.file.findMany({ where: { messageId: { in: [...ids] } }, select: FILE_SELECT });
    const { failedOwners, removed } = await removeStoredFiles(files);
    const targets = rows.filter((r) => ids.has(r.id) && !failedOwners.has(r.id));
    if (targets.length === 0) break; // 저장소 오류. 같은 행만 다시 잡히므로 멈추고 다음 실행에 맡긴다.
    const targetIds = targets.map((r) => r.id);
    const [fileDel] = await prisma.$transaction([
      prisma.file.deleteMany({ where: { id: { in: removed.map((f) => f.id) }, message: MESSAGE_NOT_HELD } }),
      prisma.reaction.deleteMany({ where: { messageId: { in: targetIds }, message: MESSAGE_NOT_HELD } }),
      prisma.bookmark.deleteMany({ where: { messageId: { in: targetIds }, message: MESSAGE_NOT_HELD } }),
      prisma.message.updateMany({ where: { id: { in: targetIds }, deletedAt: null, ...MESSAGE_NOT_HELD }, data: { deletedAt: new Date() } }),
      prisma.message.updateMany({
        where: { id: { in: targetIds }, ...MESSAGE_NOT_HELD },
        data: { content: '', isPinned: false, pinnedBy: null, pinnedAt: null, alsoSendToChannel: false },
      }),
    ]);
    await cleanupActivities({ messageId: { in: targetIds } });
    // 사용자 삭제 경로와 같은 알림: 채널에 message:deleted, 참여자에게 thread:updated(자리표시자로 바뀜)
    const io = getIO();
    for (const r of targets) {
      io?.to(`channel:${channelId}`).emit('message:deleted', { messageId: r.id, threadId: null, channelId });
      void onThreadParentDeleted({ id: r.id, userId: r.userId, channelId, threadId: null });
    }
    counts.placeholders += targets.length;
    counts.files += fileDel.count;
    if (targets.length < rows.length) break;
  }
  return counts;
}

// DM과 그룹 DM. 보낸 사람이나 받은 사람이 법적 보존이면 제외한다. 그룹 DM은 보존 대상자가 볼 수 있었던 메시지를 제외한다:
// 그 그룹에 구성원 이력(DMGroupMembership)이 있는 보존 대상자 중 누군가가 지금 구성원이거나, 메시지가 그 사람의 마지막 leftAt 이전에 쓰였으면 남긴다.
// 새 구성원도 가입 전 기록을 볼 수 있으므로 eDiscovery 범위(groupVisibilityWhere)와 같은 기준이다.
//
// Prisma 조건은 메시지의 createdAt을 다른 표(이력)의 열과 비교할 수 없어서, 보존 대상자의 이력 행을 먼저 읽어
// 그룹마다 (groupId, createdAt 상한) 조건으로 펼친다. 읽은 뒤에 보존이 새로 걸리거나 보존 대상자가 새로 들어와도 지우지 않도록,
// 읽어 둔 행이 아닌 "보존 대상자의 이력 행"이 하나라도 있는 그룹은 문장 안에서 통째로 건너뛴다(관계 조건이라 문장마다 다시 평가된다).
// 읽어 둔 구간이 그 뒤에 닫히거나 보존이 풀리면 더 많이 남길 뿐 덜 남기지는 않는다.
interface HeldSpans {
  rowIds: number[];
  spans: { groupId: number; leftAt: Date | null }[];
}

async function loadHeldSpans(): Promise<HeldSpans> {
  const rows = await prisma.dMGroupMembership.findMany({
    where: { user: HELD_USER },
    select: { id: true, groupId: true, leftAt: true },
  });
  return { rowIds: rows.map((r) => r.id), spans: rows };
}

function dmHeldFilter(held: HeldSpans): Prisma.DirectMessageWhereInput {
  const inHeldSpan = groupVisibilityWhere(held.spans);
  // 그룹 조건은 groupId null(1:1)을 먼저 따로 통과시킨다. SQL에서 NOT(groupId = x AND ...)은 groupId가 NULL이면 NULL이 되어 1:1 DM까지 빠진다.
  const groupNotHeld: Prisma.DirectMessageWhereInput = {
    group: { memberships: { none: { user: HELD_USER, id: { notIn: held.rowIds } } } },
    ...(inHeldSpan.length > 0 ? { NOT: { OR: inHeldSpan } } : {}),
  };
  return {
    fromUser: NOT_HELD_USER,
    OR: [{ toUserId: null }, { toUser: NOT_HELD_USER }],
    AND: [{ OR: [{ groupId: null }, groupNotHeld] }],
  };
}

/** 지금도 보존 대상이 아닌 DM id만 남긴다 */
async function stillPurgeableDms(ids: number[], heldFilter: Prisma.DirectMessageWhereInput): Promise<number[]> {
  const rows = await prisma.directMessage.findMany({ where: { id: { in: ids }, ...heldFilter }, select: { id: true } });
  return rows.map((r) => r.id);
}

type DmRow = { id: number; fromUserId: number; toUserId: number | null; groupId: number | null; threadId: number | null };
const DM_ROW_SELECT = { id: true, fromUserId: true, toUserId: true, groupId: true, threadId: true } as const;

/** 사용자 삭제 경로(dmService.deleteDirectMessage)와 같은 모양의 dm:deleted를 참여자에게 보낸다. 그룹 구성원은 배치 안에서 한 번만 읽는다. */
async function emitDmDeleted(rows: DmRow[]): Promise<void> {
  const io = getIO();
  if (!io) return;
  const groupMembers = new Map<number, number[]>();
  for (const dm of rows) {
    let ids: number[];
    if (dm.groupId !== null) {
      if (!groupMembers.has(dm.groupId)) groupMembers.set(dm.groupId, await getGroupMemberIds(dm.groupId));
      ids = groupMembers.get(dm.groupId)!;
    } else {
      ids = [...new Set([dm.fromUserId, ...(dm.toUserId !== null ? [dm.toUserId] : [])])];
    }
    if (ids.length === 0) continue;
    io.to(ids.map((id) => `user:${id}`)).emit('dm:deleted', {
      dmId: dm.id,
      fromUserId: dm.fromUserId,
      toUserId: dm.groupId !== null ? null : dm.toUserId,
      groupId: dm.groupId,
      threadId: dm.threadId,
    });
  }
}

async function purgeDirectMessages(cutoff: Date, budget: Budget): Promise<PurgeCounts> {
  const counts = emptyCounts();
  const heldFilter = dmHeldFilter(await loadHeldSpans());
  const leafWhere: Prisma.DirectMessageWhereInput = { createdAt: { lt: cutoff }, replies: { none: {} }, ...heldFilter };
  for (;;) {
    const take = Math.min(PURGE_BATCH, budget.left);
    if (take <= 0) {
      counts.partial = (await prisma.directMessage.findFirst({ where: leafWhere, select: { id: true } })) !== null;
      break;
    }
    const rows = await prisma.directMessage.findMany({ where: leafWhere, select: DM_ROW_SELECT, orderBy: { id: 'asc' }, take });
    if (rows.length === 0) break;
    budget.left -= rows.length;
    await budget.afterSelect?.();
    const done = await deleteDms(rows, heldFilter);
    add(counts, done);
    if (done.messages === 0) break;
  }
  add(counts, await blankDmParents(cutoff, budget, heldFilter));
  return counts;
}

async function deleteDms(rows: DmRow[], heldFilter: Prisma.DirectMessageWhereInput): Promise<PurgeCounts> {
  const ids = await stillPurgeableDms(rows.map((r) => r.id), heldFilter);
  if (ids.length === 0) return emptyCounts();
  const files = await prisma.file.findMany({ where: { dmId: { in: ids } }, select: FILE_SELECT });
  const { failedOwners, removed } = await removeStoredFiles(files);
  const targets = ids.filter((id) => !failedOwners.has(id));
  if (targets.length === 0) return emptyCounts();

  await prisma.directMessage.deleteMany({ where: { id: { in: targets }, replies: { none: {} }, ...heldFilter } });
  const remaining = new Set((await prisma.directMessage.findMany({ where: { id: { in: targets } }, select: { id: true } })).map((m) => m.id));
  const gone = new Set(targets.filter((id) => !remaining.has(id)));
  if (gone.size === 0) return emptyCounts();

  const fileCount = await deleteFileRows(removed, gone, 'dmId');
  await cleanupActivities({ dmId: { in: [...gone] } });
  await emitDmDeleted(rows.filter((r) => gone.has(r.id)));
  return { messages: gone.size, files: fileCount, placeholders: 0, partial: false };
}

async function blankDmParents(cutoff: Date, budget: Budget, heldFilter: Prisma.DirectMessageWhereInput): Promise<PurgeCounts> {
  const counts = emptyCounts();
  const where: Prisma.DirectMessageWhereInput = {
    createdAt: { lt: cutoff },
    replies: { some: {} },
    OR: [{ deletedAt: null }, { content: { not: '' } }],
    AND: [heldFilter],
  };
  for (;;) {
    const take = Math.min(PURGE_BATCH, budget.left);
    if (take <= 0) {
      counts.partial = (await prisma.directMessage.findFirst({ where, select: { id: true } })) !== null;
      break;
    }
    const rows = await prisma.directMessage.findMany({ where, select: DM_ROW_SELECT, orderBy: { id: 'asc' }, take });
    if (rows.length === 0) break;
    budget.left -= rows.length;
    await budget.afterSelect?.();
    const ids = new Set(await stillPurgeableDms(rows.map((r) => r.id), heldFilter));
    if (ids.size === 0) break;
    const files = await prisma.file.findMany({ where: { dmId: { in: [...ids] } }, select: FILE_SELECT });
    const { failedOwners, removed } = await removeStoredFiles(files);
    const targets = rows.filter((r) => ids.has(r.id) && !failedOwners.has(r.id));
    if (targets.length === 0) break;
    const targetIds = targets.map((r) => r.id);
    const [fileDel] = await prisma.$transaction([
      prisma.file.deleteMany({ where: { id: { in: removed.map((f) => f.id) }, dm: heldFilter } }),
      prisma.dMReaction.deleteMany({ where: { dmId: { in: targetIds }, dm: heldFilter } }),
      prisma.directMessage.updateMany({ where: { id: { in: targetIds }, deletedAt: null, ...heldFilter }, data: { deletedAt: new Date() } }),
      prisma.directMessage.updateMany({ where: { id: { in: targetIds }, ...heldFilter }, data: { content: '', isPinned: false, pinnedBy: null, pinnedAt: null } }),
    ]);
    await cleanupActivities({ dmId: { in: targetIds } });
    await emitDmDeleted(targets);
    counts.placeholders += targets.length;
    counts.files += fileDel.count;
    if (targets.length < rows.length) break;
  }
  return counts;
}

type DetachedRow = FileRow & { detachedFromMessageId: number | null; detachedFromDmId: number | null };
const ORPHAN_SELECT = { ...FILE_SELECT, detachedFromMessageId: true, detachedFromDmId: true } as const;

/**
 * 분리된 파일 중 원래 메시지·DM이 지금도 법적 보존에 걸려 있는 것을 뺀다. 원래 행이 이미 없으면(정리됨) 걸리지 않는다.
 * DM은 stillPurgeableDms(DM 보존 조건 한 곳)로, 채널 메시지는 MESSAGE_NOT_HELD로 판단한다.
 */
async function dropHeldDetached<T extends { detachedFromMessageId: number | null; detachedFromDmId: number | null }>(files: T[]): Promise<T[]> {
  const dmIds = [...new Set(files.flatMap((f) => (f.detachedFromDmId !== null ? [f.detachedFromDmId] : [])))];
  const msgIds = [...new Set(files.flatMap((f) => (f.detachedFromMessageId !== null ? [f.detachedFromMessageId] : [])))];
  const heldDms = new Set<number>();
  if (dmIds.length > 0) {
    const free = new Set(await stillPurgeableDms(dmIds, dmHeldFilter(await loadHeldSpans())));
    const existing = await prisma.directMessage.findMany({ where: { id: { in: dmIds } }, select: { id: true } });
    for (const d of existing) if (!free.has(d.id)) heldDms.add(d.id);
  }
  const heldMsgs = new Set<number>();
  if (msgIds.length > 0) {
    const free = new Set((await prisma.message.findMany({ where: { id: { in: msgIds }, ...MESSAGE_NOT_HELD }, select: { id: true } })).map((m) => m.id));
    const existing = await prisma.message.findMany({ where: { id: { in: msgIds } }, select: { id: true } });
    for (const m of existing) if (!free.has(m.id)) heldMsgs.add(m.id);
  }
  return files.filter((f) => !(f.detachedFromDmId !== null && heldDms.has(f.detachedFromDmId)) && !(f.detachedFromMessageId !== null && heldMsgs.has(f.detachedFromMessageId)));
}

/**
 * 이미 소프트 삭제되어 메시지에서 분리된 파일(messageId·dmId 모두 null)을 정리한다. 워크스페이스 기본 기간을 기준으로 한다.
 * 업로더가 보존 대상이거나, 분리 전 원래 메시지·DM이 보존 대상(채널·보낸/받은 사람·그룹 구성원)이면 남긴다.
 * 업로드만 하고 아직 보내지 않은 파일도 이 조건에 닿지만, 기간 하한이 1일이라 보내는 중인 파일을 지우지는 않는다.
 */
async function purgeOrphanFiles(cutoff: Date, budget: Budget): Promise<PurgeCounts> {
  const counts = emptyCounts();
  const base: Prisma.FileWhereInput = { messageId: null, dmId: null, createdAt: { lt: cutoff }, user: NOT_HELD_USER };
  // 남겨 둔(보존) 파일이 앞을 막지 않도록 id 커서로 넘어간다
  let lastId = 0;
  for (;;) {
    const where: Prisma.FileWhereInput = { ...base, id: { gt: lastId } };
    const take = Math.min(PURGE_BATCH, budget.left);
    if (take <= 0) {
      counts.partial = (await prisma.file.findFirst({ where, select: { id: true } })) !== null;
      break;
    }
    const rows: DetachedRow[] = await prisma.file.findMany({ where, select: ORPHAN_SELECT, orderBy: { id: 'asc' }, take });
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;
    budget.left -= rows.length;
    const files = await dropHeldDetached(rows);
    if (files.length === 0) continue;
    const { removed } = await removeStoredFiles(files);
    if (removed.length === 0) continue;
    const { count } = await prisma.file.deleteMany({ where: { id: { in: removed.map((f) => f.id) }, messageId: null, dmId: null, user: NOT_HELD_USER } });
    counts.files += count;
  }
  return counts;
}

const countsDetails = (days: number, c: PurgeCounts) =>
  `days=${days}; messages=${c.messages}; files=${c.files}; placeholders=${c.placeholders}${c.partial ? '; partial=true' : ''}`;

/**
 * 정책에 따라 만료된 메시지를 지운다. 채널별 결과는 감사 로그 retention.purged로 남긴다(할 일이 없으면 남기지 않는다).
 * 한 채널이 실패해도 나머지는 계속하고, 하나라도 실패했으면 마지막에 던져 스케줄러가 1시간 뒤 다시 시도하게 한다.
 * 예산(maxRows)의 절반은 DM에 예약해 채널이 다 쓰더라도 DM이 굶지 않게 하고, 채널이 남긴 몫은 DM이 이어 쓴다.
 */
export async function purgeExpiredMessages(now: Date = new Date(), opts: { maxRows?: number; afterSelect?: () => Promise<void> } = {}): Promise<PurgeCounts> {
  const maxRows = opts.maxRows ?? PURGE_MAX_ROWS;
  const workspaceDays = await getWorkspaceRetentionDays();
  const total = emptyCounts();
  const channelBudget: Budget = { left: Math.floor(maxRows / 2), afterSelect: opts.afterSelect };
  const dmBudget: Budget = { left: maxRows - channelBudget.left, afterSelect: opts.afterSelect };
  let failed = 0;
  let skipped = 0;

  // 법적 보존 채널과, 법적 보존 사용자가 멤버인 채널은 통째로 뺀다
  const channels = await prisma.channel.findMany({
    where: CHANNEL_NOT_HELD,
    select: { id: true, name: true, retentionDays: true },
    orderBy: { id: 'asc' },
  });
  for (const ch of channels) {
    const days = effectiveDays(ch.retentionDays, workspaceDays);
    if (!days) continue;
    if (channelBudget.left <= 0) {
      skipped++;
      continue;
    }
    try {
      const c = await purgeChannel(ch.id, cutoffFor(days, now), channelBudget);
      add(total, c);
      if (c.messages > 0 || c.placeholders > 0 || c.partial) {
        await writeAuditLog({ action: 'retention.purged', targetType: 'channel', targetId: ch.id, targetName: ch.name, details: countsDetails(days, c) });
      }
    } catch (error) {
      failed++;
      logError(`Retention purge failed for channel ${ch.id}`, error);
    }
  }
  if (skipped > 0) {
    total.partial = true;
    await writeAuditLog({ action: 'retention.purged', targetType: 'workspace', details: `partial=true; skippedChannels=${skipped}` });
  }

  // DM과 그룹 DM, 분리된 파일은 워크스페이스 정책을 따른다. 채널이 남긴 예산을 이어 쓴다.
  if (workspaceDays) {
    dmBudget.left += channelBudget.left;
    const cutoff = cutoffFor(workspaceDays, now);
    try {
      const c = await purgeDirectMessages(cutoff, dmBudget);
      add(total, c);
      if (c.messages > 0 || c.placeholders > 0 || c.partial) {
        await writeAuditLog({ action: 'retention.purged', targetType: 'direct_message', targetName: 'dm', details: countsDetails(workspaceDays, c) });
      }
    } catch (error) {
      failed++;
      logError('Retention purge failed for direct messages', error);
    }
    try {
      const c = await purgeOrphanFiles(cutoff, dmBudget);
      add(total, c);
      if (c.files > 0 || c.partial) {
        await writeAuditLog({ action: 'retention.purged', targetType: 'file', targetName: 'detached', details: `days=${workspaceDays}; files=${c.files}${c.partial ? '; partial=true' : ''}` });
      }
    } catch (error) {
      failed++;
      logError('Retention purge failed for detached files', error);
    }
  }

  if (failed > 0) throw new Error(`Retention purge failed for ${failed} target(s)`);
  return total;
}
