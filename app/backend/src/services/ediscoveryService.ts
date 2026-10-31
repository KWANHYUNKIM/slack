import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../db.js';
import { auditFilterSchema } from './auditLogService.js';
import { groupDmVisibleSql } from './dmGroupService.js';
import { utcTimestamp } from '../db/sqlTime.js';

// eDiscovery(E6). 보존 건의 대상자(custodian)를 기준으로 채널 메시지·DM·파일 메타데이터를 찾고 내보낸다.
//
// 범위
// - 채널 메시지: 대상자가 쓴 것(공개·비공개 채널 모두, 스레드 답글 포함)
// - DM: 대상자가 보냈거나 받은 1:1 DM, 대상자가 보낸 그룹 DM, 대상자가 볼 수 있었던 그룹 DM 메시지
//   (구성원 이력 DMGroupMembership에 행이 있는 그룹에서 마지막 구간의 leftAt 이전(경계 포함)에 쓴 것 전체, 지금 구성원이면 제한 없음).
//   새 구성원도 가입 전 기록을 보므로 가입 전 메시지와 나갔다가 재가입한 사이의 메시지도 들어가고, 마지막으로 나간 뒤의 메시지는 빠진다.
//   메시지 시각을 이력 시각과 견줘야 해서 DM과 파일은 raw SQL(상관 서브쿼리)로 id를 고른 뒤 그 id로 읽는다. 조건 크기는 대상자 수와 무관하다.
// - 파일: 대상자가 올린 파일과, 위 DM에 붙은 파일, 위 DM·채널 메시지에서 소프트 삭제로 분리된 파일의 메타데이터(본문은 담지 않는다)
// 한계: 구성원 이력(20261101090000)을 배포하기 전에 이미 그룹을 나간 사람의 과거 구간은 복원할 수 없어,
//   그런 대상자는 그 그룹 DM에서 본인이 보낸 메시지만 잡힌다.
// 소프트 삭제된 메시지도 넣고 deletedAt으로 표시한다. 수정 이력 테이블은 없으므로 editedAt(마지막 수정 시각)만 담는다.
// 일반 API의 멤버십 검사를 건너뛰므로 관리자 라우트(/admin/ediscovery)에서만 부른다.

export const SEARCH_KINDS = ['channel', 'dm', 'file'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

const QUERY_MAX = 200;
const EXPORT_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

export const discoveryFilterSchema = z.object({
  holdId: z.coerce.number().int().positive(),
  q: z.string().trim().max(QUERY_MAX).optional().transform((v) => v || undefined),
  from: auditFilterSchema.shape.from,
  to: auditFilterSchema.shape.to,
});

export type DiscoveryFilter = z.infer<typeof discoveryFilterSchema>;

/** 감사 로그 내보내기와 같은 규칙: from은 그 시각부터, to가 날짜만이면 그 날 끝까지 */
export function createdAtRange(f: DiscoveryFilter): { gte?: Date; lt?: Date; lte?: Date } | undefined {
  if (!f.from && !f.to) return undefined;
  return {
    ...(f.from ? { gte: f.from } : {}),
    ...(f.to ? (f.to.dateOnly ? { lt: new Date(f.to.date.getTime() + DAY_MS) } : { lte: f.to.date }) : {}),
  };
}

const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });

export async function custodianIds(holdId: number): Promise<number[] | null> {
  const hold = await prisma.legalHold.findUnique({ where: { id: holdId }, select: { custodians: { select: { userId: true } } } });
  return hold ? hold.custodians.map((c) => c.userId) : null;
}

/** 내보내기 머리 줄용: 보존 건과 대상자를 한 번에 읽는다 */
export async function holdWithCustodians(holdId: number) {
  const hold = await prisma.legalHold.findUnique({
    where: { id: holdId },
    select: {
      id: true,
      name: true,
      description: true,
      createdAt: true,
      releasedAt: true,
      custodians: { select: { user: PERSON }, orderBy: { userId: 'asc' } },
    },
  });
  if (!hold) return null;
  const { custodians, ...rest } = hold;
  return { hold: rest, custodians: custodians.map((c) => c.user) };
}

// ---- 검색 감사·건수 생략 ----
// 같은 관리자가 같은 보존 건·필터로 탭만 바꾸면 건수(count 3개)를 다시 세지 않고 감사 로그도 다시 남기지 않는다.
// 서버가 마지막 필터를 기억해서 판단하므로 클라이언트가 감사 로그를 건너뛰게 만들 수 없다(새 필터의 첫 검색은 항상 남는다).
const SEARCH_MEMO_TTL_MS = 10 * 60 * 1000;
const SEARCH_MEMO_MAX = 1000;
const lastSearch = new Map<number, { binding: string; at: number }>();

/** 이 관리자에게 새 필터(또는 기억이 만료된 필터)면 true를 돌려주고 기억한다 */
export function isNewSearchFilter(userId: number, f: DiscoveryFilter, now = Date.now()): boolean {
  const binding = discoveryBinding(f);
  const prev = lastSearch.get(userId);
  const fresh = !prev || prev.binding !== binding || now - prev.at > SEARCH_MEMO_TTL_MS;
  if (!fresh) return false;
  if (!lastSearch.has(userId) && lastSearch.size >= SEARCH_MEMO_MAX) lastSearch.clear();
  lastSearch.set(userId, { binding, at: now });
  return true;
}

/** 테스트용 */
export function resetSearchMemo(): void {
  lastSearch.clear();
}

function channelWhere(ids: number[], f: DiscoveryFilter): Prisma.MessageWhereInput {
  const createdAt = createdAtRange(f);
  return { userId: { in: ids }, ...(createdAt ? { createdAt } : {}), ...(f.q ? { content: contains(f.q) } : {}) };
}

// ---- DM·파일 조건(raw SQL). 메시지 별칭은 dm, 파일 별칭은 fl ----
const anyOf = (col: Prisma.Sql, ids: number[]) => Prisma.sql`${col} = ANY(${ids}::int[])`;

/** 대상자가 보냈거나 받은 DM, 또는 대상자가 볼 수 있었던 그룹 DM */
const dmScopeSql = (ids: number[]) =>
  Prisma.sql`(${anyOf(Prisma.sql`dm."fromUserId"`, ids)} OR ${anyOf(Prisma.sql`dm."toUserId"`, ids)} OR ${groupDmVisibleSql((col) => anyOf(col, ids))})`;

function rangeSql(col: Prisma.Sql, f: DiscoveryFilter): Prisma.Sql {
  const r = createdAtRange(f);
  const parts = [
    ...(r?.gte ? [Prisma.sql`${col} >= ${utcTimestamp(r.gte)}`] : []),
    ...(r?.lt ? [Prisma.sql`${col} < ${utcTimestamp(r.lt)}`] : []),
    ...(r?.lte ? [Prisma.sql`${col} <= ${utcTimestamp(r.lte)}`] : []),
  ];
  return parts.length > 0 ? Prisma.join(parts, ' AND ') : Prisma.sql`TRUE`;
}

/** 대소문자 무시 부분 일치. 검색어의 %, _, \는 글자 그대로 찾는다. */
const likeSql = (col: Prisma.Sql, q: string | undefined) =>
  q ? Prisma.sql`${col} ILIKE ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}` : Prisma.sql`TRUE`;

const dmWhereSql = (ids: number[], f: DiscoveryFilter) =>
  Prisma.sql`${dmScopeSql(ids)} AND ${rangeSql(Prisma.sql`dm."createdAt"`, f)} AND ${likeSql(Prisma.sql`dm.content`, f.q)}`;

/** 대상자가 올린 파일, 범위 안 DM에 붙은 파일, 범위 안 DM·채널 메시지에서 소프트 삭제로 분리된 파일 */
const fileWhereSql = (ids: number[], f: DiscoveryFilter) => Prisma.sql`(${anyOf(Prisma.sql`fl."userId"`, ids)}
  OR EXISTS (SELECT 1 FROM "DirectMessage" dm WHERE dm.id = fl."dmId" AND ${dmScopeSql(ids)})
  OR EXISTS (SELECT 1 FROM "DirectMessage" dm WHERE dm.id = fl."detachedFromDmId" AND ${dmScopeSql(ids)})
  OR EXISTS (SELECT 1 FROM "Message" om WHERE om.id = fl."detachedFromMessageId" AND ${anyOf(Prisma.sql`om."userId"`, ids)}))
  AND ${rangeSql(Prisma.sql`fl."createdAt"`, f)} AND ${likeSql(Prisma.sql`fl."originalName"`, f.q)}`;

type PageOpts = { cursor?: number; take: number; order: 'asc' | 'desc' };

/** 조건에 맞는 id 한 쪽. table과 alias는 이 파일의 상수만 넘긴다. */
async function pageIds(table: 'DirectMessage' | 'File', where: Prisma.Sql, opts: PageOpts): Promise<number[]> {
  const t = table === 'DirectMessage' ? Prisma.sql`"DirectMessage" dm` : Prisma.sql`"File" fl`;
  const id = table === 'DirectMessage' ? Prisma.sql`dm.id` : Prisma.sql`fl.id`;
  const cursor = opts.cursor ? (opts.order === 'desc' ? Prisma.sql`AND ${id} < ${opts.cursor}` : Prisma.sql`AND ${id} > ${opts.cursor}`) : Prisma.empty;
  const dir = opts.order === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`SELECT ${id} AS id FROM ${t} WHERE ${where} ${cursor} ORDER BY ${id} ${dir} LIMIT ${opts.take}`;
  return rows.map((r) => r.id);
}

async function countWhere(table: 'DirectMessage' | 'File', where: Prisma.Sql): Promise<number> {
  const t = table === 'DirectMessage' ? Prisma.sql`"DirectMessage" dm` : Prisma.sql`"File" fl`;
  const [row] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM ${t} WHERE ${where}`;
  return Number(row.n);
}

const PERSON = { select: { id: true, name: true, email: true } } as const;
const FILE_META = { select: { id: true, originalName: true, mimetype: true, size: true, createdAt: true, userId: true } } as const;

const CHANNEL_SELECT = {
  id: true,
  content: true,
  threadId: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  user: PERSON,
  channel: { select: { id: true, name: true, isPrivate: true } },
  files: FILE_META,
} as const;

const DM_SELECT = {
  id: true,
  content: true,
  threadId: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  fromUser: PERSON,
  toUser: PERSON,
  group: { select: { id: true, name: true } },
  files: FILE_META,
} as const;

const FILE_SELECT = {
  id: true,
  originalName: true,
  mimetype: true,
  size: true,
  createdAt: true,
  messageId: true,
  dmId: true,
  detachedFromMessageId: true,
  detachedFromDmId: true,
  user: PERSON,
  message: { select: { channel: { select: { id: true, name: true, isPrivate: true } }, deletedAt: true } },
  dm: { select: { deletedAt: true, groupId: true } },
} as const;

type FileMeta = Prisma.FileGetPayload<typeof FILE_META>;
type ChannelRef = { id: number; name: string; isPrivate: boolean };

type ChannelRow = Prisma.MessageGetPayload<{ select: typeof CHANNEL_SELECT }>;
type DmRow = Prisma.DirectMessageGetPayload<{ select: typeof DM_SELECT }>;
type FileRow = Prisma.FileGetPayload<{ select: typeof FILE_SELECT }>;

// 소프트 삭제된 메시지는 첨부가 분리돼(messageId=null) files 관계로 보이지 않는다. 분리 때 남긴 detachedFrom*로 되찾는다.
const channelRecord = (m: ChannelRow, detached: FileMeta[] = []) => ({
  kind: 'channel' as const,
  id: m.id,
  createdAt: m.createdAt,
  editedAt: m.editedAt,
  deletedAt: m.deletedAt,
  deleted: m.deletedAt !== null,
  threadId: m.threadId,
  channel: m.channel,
  author: m.user,
  content: m.content,
  files: [...m.files, ...detached],
});

const dmRecord = (m: DmRow, detached: FileMeta[] = []) => ({
  kind: 'dm' as const,
  id: m.id,
  createdAt: m.createdAt,
  editedAt: m.editedAt,
  deletedAt: m.deletedAt,
  deleted: m.deletedAt !== null,
  threadId: m.threadId,
  from: m.fromUser,
  to: m.toUser,
  group: m.group,
  content: m.content,
  files: [...m.files, ...detached],
});

const fileRecord = (f: FileRow, detachedChannel: ChannelRef | null = null) => ({
  kind: 'file' as const,
  id: f.id,
  createdAt: f.createdAt,
  originalName: f.originalName,
  mimetype: f.mimetype,
  size: f.size,
  uploader: f.user,
  messageId: f.messageId,
  dmId: f.dmId,
  detachedFromMessageId: f.detachedFromMessageId,
  detachedFromDmId: f.detachedFromDmId,
  channel: f.message?.channel ?? detachedChannel,
  groupId: f.dm?.groupId ?? null,
  // 붙어 있던 메시지가 소프트 삭제됐거나(그대로 붙어 있는 DM) 삭제되면서 분리됐으면(채널 메시지) 표시한다
  attachedToDeleted: Boolean(f.message?.deletedAt ?? f.dm?.deletedAt) || f.detachedFromMessageId !== null || f.detachedFromDmId !== null,
});

function groupBy<T>(rows: T[], key: (r: T) => number | null): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    map.set(k, [...(map.get(k) ?? []), r]);
  }
  return map;
}

const DETACHED_META = { ...FILE_META.select, detachedFromMessageId: true, detachedFromDmId: true } as const;
const stripDetached = ({ detachedFromMessageId: _m, detachedFromDmId: _d, ...meta }: FileMeta & { detachedFromMessageId: number | null; detachedFromDmId: number | null }): FileMeta => meta;

export type DiscoveryRecord = ReturnType<typeof channelRecord> | ReturnType<typeof dmRecord> | ReturnType<typeof fileRecord>;

/** 한 종류의 배치를 읽는다. order가 desc면 cursor보다 작은 id, asc면 큰 id부터. */
async function fetchBatch(kind: SearchKind, ids: number[], f: DiscoveryFilter, opts: PageOpts): Promise<DiscoveryRecord[]> {
  const idCond = opts.cursor ? { id: opts.order === 'desc' ? { lt: opts.cursor } : { gt: opts.cursor } } : {};
  const base = { orderBy: { id: opts.order }, take: opts.take };
  if (kind === 'channel') {
    const rows = await prisma.message.findMany({ ...base, where: { AND: [channelWhere(ids, f), idCond] }, select: CHANNEL_SELECT });
    const deletedIds = rows.filter((m) => m.deletedAt).map((m) => m.id);
    const detached = deletedIds.length
      ? groupBy(await prisma.file.findMany({ where: { detachedFromMessageId: { in: deletedIds } }, select: DETACHED_META, orderBy: { id: 'asc' } }), (x) => x.detachedFromMessageId)
      : new Map();
    return rows.map((m) => channelRecord(m, (detached.get(m.id) ?? []).map(stripDetached)));
  }
  if (kind === 'dm') {
    const dmIds = await pageIds('DirectMessage', dmWhereSql(ids, f), opts);
    const rows = dmIds.length ? await prisma.directMessage.findMany({ where: { id: { in: dmIds } }, orderBy: base.orderBy, select: DM_SELECT }) : [];
    const deletedIds = rows.filter((m) => m.deletedAt).map((m) => m.id);
    const detached = deletedIds.length
      ? groupBy(await prisma.file.findMany({ where: { detachedFromDmId: { in: deletedIds } }, select: DETACHED_META, orderBy: { id: 'asc' } }), (x) => x.detachedFromDmId)
      : new Map();
    return rows.map((m) => dmRecord(m, (detached.get(m.id) ?? []).map(stripDetached)));
  }
  const fileIds = await pageIds('File', fileWhereSql(ids, f), opts);
  const rows = fileIds.length ? await prisma.file.findMany({ where: { id: { in: fileIds } }, orderBy: base.orderBy, select: FILE_SELECT }) : [];
  // 분리된 첨부는 원래 메시지의 채널을 따로 읽는다(보존 정리로 메시지가 하드 삭제됐으면 null)
  const sourceIds = [...new Set(rows.flatMap((r) => (r.detachedFromMessageId !== null ? [r.detachedFromMessageId] : [])))];
  const sources = sourceIds.length
    ? new Map((await prisma.message.findMany({ where: { id: { in: sourceIds } }, select: { id: true, channel: { select: { id: true, name: true, isPrivate: true } } } })).map((m) => [m.id, m.channel]))
    : new Map<number, ChannelRef>();
  return rows.map((r) => fileRecord(r, r.detachedFromMessageId !== null ? (sources.get(r.detachedFromMessageId) ?? null) : null));
}

export async function countAll(ids: number[], f: DiscoveryFilter): Promise<Record<SearchKind, number>> {
  if (ids.length === 0) return { channel: 0, dm: 0, file: 0 };
  const [channel, dm, file] = await Promise.all([
    prisma.message.count({ where: channelWhere(ids, f) }),
    countWhere('DirectMessage', dmWhereSql(ids, f)),
    countWhere('File', fileWhereSql(ids, f)),
  ]);
  return { channel, dm, file };
}

/** 최신순 커서 페이지 */
export async function search(kind: SearchKind, ids: number[], f: DiscoveryFilter, limit: number, cursor: number | undefined) {
  if (ids.length === 0) return { items: [], nextCursor: null };
  const rows = await fetchBatch(kind, ids, f, { cursor, take: limit + 1, order: 'desc' });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/** 내보내기용: 종류별로 오래된 것부터 배치로 읽어 넘긴다. 메모리에는 한 배치만 올린다. */
export async function* iterateRecords(ids: number[], f: DiscoveryFilter): AsyncGenerator<DiscoveryRecord> {
  if (ids.length === 0) return;
  for (const kind of SEARCH_KINDS) {
    let cursor: number | undefined;
    for (;;) {
      const rows = await fetchBatch(kind, ids, f, { cursor, take: EXPORT_BATCH, order: 'asc' });
      for (const row of rows) yield row;
      if (rows.length < EXPORT_BATCH) break;
      cursor = rows[rows.length - 1].id;
    }
  }
}

/** 내보내기 토큰이 묶이는 값. 발급 때와 받을 때 같아야 한다. 감사 로그 내보내기 토큰과 섞이지 않게 접두어를 붙인다. */
export function discoveryBinding(f: DiscoveryFilter): string {
  return `ediscovery:${JSON.stringify({
    holdId: f.holdId,
    q: f.q ?? null,
    from: f.from?.toISOString() ?? null,
    to: f.to ? `${f.to.date.toISOString()}${f.to.dateOnly ? ':day' : ''}` : null,
  })}`;
}

/** 감사 로그 details. 검색어 원문은 남기지 않는다(민감할 수 있다). */
export function filterSummary(f: DiscoveryFilter): string {
  return `query=${f.q ? 'yes' : 'no'}; from=${f.from?.toISOString() ?? '-'}; to=${f.to?.date.toISOString() ?? '-'}`;
}
