import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import {
  parseSearchQuery, termVariants, dateRangeOf, findHighlights, resolveTimeZone, MAX_QUERY_LENGTH,
  type ParsedQuery,
} from '../utils/searchQuery.js';
import { ServiceError } from './messageService.js';

// 검색 공용 서비스(08 검색 v2). REST(routes/search.ts)와 MCP(mcp/searchTools.ts)가 같은 함수를 쓴다.
// 연산자 해석, 탭, 권한 규칙(내 채널, DM 접근 범위, 게스트 격리)은 여기 한 곳에만 있다.

// 한 질의가 돌려줄 수 있는 결과의 상한. 관련도와 최신 정렬이 같은 상한을 쓴다.
// 상한에 닿으면 응답의 truncated가 true가 되고 화면이 필터를 더 추가하라고 안내한다.
const MAX_RESULTS = 450;

const firstString = (v: unknown) => (Array.isArray(v) ? v[0] : v);

/** 검색 범위: 날짜 필터의 시간대와 페이지 도중 새 글이 끼어들지 않게 하는 스냅샷 시각 */
interface Scope { tz: string; snapshot: Date }

function createdAtFilter(
  filters: Pick<ParsedQuery['filters'], 'before' | 'after' | 'on'>,
  scope: Scope,
): Prisma.DateTimeFilter {
  const range = dateRangeOf(filters, scope.tz);
  return { ...(range.gte && { gte: range.gte }), ...(range.lt && { lt: range.lt }), lte: scope.snapshot };
}

export const searchQuerySchema = z.object({
  q: z.preprocess(firstString, z.string().min(1).max(MAX_QUERY_LENGTH)),
  type: z.preprocess(firstString, z.enum(['messages', 'dms', 'all', 'files', 'people', 'channels']).optional().default('all')),
  channelId: z.coerce.number().int().positive().optional(),
  sort: z.preprocess(firstString, z.enum(['relevance', 'recent']).optional().default('relevance')),
  limit: z.coerce.number().int().min(1).max(50).optional().default(50),
  cursor: z.preprocess(firstString, z.string().max(64).optional()),
  // 날짜 연산자를 해석할 IANA 시간대(예 Asia/Seoul). 잘못된 값은 UTC로 대체한다.
  tz: z.preprocess(firstString, z.string().max(64).optional()),
});

/**
 * 커서는 "결과 목록 안의 위치(offset)"와 "첫 요청 시각(snapshot)"을 base64url로 감싼 값이다.
 * 이후 페이지는 snapshot 이후에 생긴 글을 빼서 새 글 때문에 위치가 밀려 중복되는 일을 막는다.
 * 잘못된 커서는 처음부터 시작한다.
 */
function decodeCursor(cursor?: string): { offset: number; snapshot: number | null } {
  if (!cursor) return { offset: 0, snapshot: null };
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown; s?: unknown };
    if (Number.isInteger(v.o) && (v.o as number) >= 0 && (v.o as number) <= MAX_RESULTS
      && Number.isInteger(v.s) && (v.s as number) > 0 && (v.s as number) <= Date.now() + 60_000) {
      return { offset: v.o as number, snapshot: v.s as number };
    }
  } catch { /* 잘못된 커서 */ }
  return { offset: 0, snapshot: null };
}
const encodeCursor = (offset: number, snapshot: number) =>
  Buffer.from(JSON.stringify({ o: offset, s: snapshot }), 'utf8').toString('base64url');

/** 키워드 하나가 문자열에 들어 있는지(대소문자 무시, NFC/NFD 모두). */
function textHasTerm(text: string | null | undefined, term: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return termVariants(term).some((v) => lower.includes(v.toLowerCase()));
}

const containsAny = (term: string) =>
  termVariants(term).map((v) => ({ contains: v, mode: 'insensitive' as const }));
const equalsAny = (value: string) =>
  termVariants(value).map((v) => ({ equals: v, mode: 'insensitive' as const }));

/** 채널 메시지 검색 조건. 권한(내 채널)은 호출 쪽이 channelIds로 이미 좁혀 넘긴다. */
function channelMessageWhere(p: ParsedQuery, userId: number, channelIds: number[], scope: Scope): Prisma.MessageWhereInput {
  const { filters } = p;
  const created = createdAtFilter(filters, scope);
  const and: Prisma.MessageWhereInput[] = [];

  for (const term of p.terms) {
    const c = containsAny(term);
    and.push({ OR: [
      ...c.map((x) => ({ content: x })),
      ...c.map((x) => ({ user: { name: x } })),
      ...c.map((x) => ({ channel: { name: x } })),
    ] });
  }
  if (filters.from.length) {
    and.push({ OR: filters.from.flatMap((n) => equalsAny(n).map((x) => ({ user: { name: x } }))) });
  }
  if (filters.in.length) {
    and.push({ OR: filters.in.flatMap((n) => equalsAny(n).map((x) => ({ channel: { name: x } }))) });
  }
  if (filters.has.includes('file')) and.push({ files: { some: {} } });
  if (filters.has.includes('link')) {
    and.push({ OR: [
      { content: { contains: 'http://', mode: 'insensitive' } },
      { content: { contains: 'https://', mode: 'insensitive' } },
    ] });
  }
  if (filters.has.includes('pin')) and.push({ isPinned: true });
  if (filters.has.includes('reaction')) and.push({ reactions: { some: {} } });
  if (filters.is.includes('thread')) and.push({ OR: [{ threadId: { not: null } }, { replies: { some: { deletedAt: null } } }] });
  if (filters.is.includes('saved')) and.push({ bookmarks: { some: { userId } } });

  return {
    channelId: { in: channelIds },
    deletedAt: null,
    ...(created ? { createdAt: created } : {}),
    AND: and,
  };
}

/** DM 메시지 검색 조건. access는 내가 볼 수 있는 DM·그룹 DM 범위다. */
function dmMessageWhere(p: ParsedQuery, access: Prisma.DirectMessageWhereInput[], scope: Scope): Prisma.DirectMessageWhereInput {
  const { filters } = p;
  const created = createdAtFilter(filters, scope);
  const and: Prisma.DirectMessageWhereInput[] = [{ OR: access }];

  for (const term of p.terms) {
    const c = containsAny(term);
    and.push({ OR: [
      ...c.map((x) => ({ content: x })),
      ...c.map((x) => ({ fromUser: { name: x } })),
      ...c.map((x) => ({ toUser: { name: x } })),
    ] });
  }
  if (filters.from.length) {
    and.push({ OR: filters.from.flatMap((n) => equalsAny(n).map((x) => ({ fromUser: { name: x } }))) });
  }
  if (filters.has.includes('file')) and.push({ files: { some: {} } });
  if (filters.has.includes('link')) {
    and.push({ OR: [
      { content: { contains: 'http://', mode: 'insensitive' } },
      { content: { contains: 'https://', mode: 'insensitive' } },
    ] });
  }
  if (filters.has.includes('pin')) and.push({ isPinned: true });
  if (filters.has.includes('reaction')) and.push({ reactions: { some: {} } });
  if (filters.is.includes('thread')) and.push({ OR: [{ threadId: { not: null } }, { replies: { some: { deletedAt: null } } }] });

  return {
    deletedAt: null,
    ...(created ? { createdAt: created } : {}),
    AND: and,
  };
}


export type SearchParams = z.infer<typeof searchQuerySchema>;

/** 검색 요청자. 게스트는 DM·사람 검색 범위가 좁아진다. */
export interface SearchActor { userId: number; isGuest: boolean }

/** includeDms가 false면 DM 메시지와 DM에 첨부된 파일을 결과에서 뺀다(MCP에서 im:history가 없는 토큰). */
export interface SearchOptions { includeDms: boolean }

/** 쿼리 파라미터(또는 도구 인자)를 검증한다. 실패하면 400 ServiceError. */
export function parseSearchParams(raw: unknown): SearchParams {
  const parsed = searchQuerySchema.safeParse(raw);
  if (!parsed.success) throw new ServiceError(400, parsed.error.issues[0]?.message || 'Invalid search parameters');
  return parsed.data;
}

// 메시지, DM, 파일, 사람, 채널 검색. 잘못된 질의는 ServiceError(400)로 던진다.
export async function runSearch(actor: SearchActor, params: SearchParams, options: SearchOptions = { includeDms: true }) {
  const { q: rawQuery, type, channelId, sort, limit } = params;
  const cursor = decodeCursor(params.cursor);
  const { offset } = cursor;
  const scope: Scope = { tz: resolveTimeZone(params.tz), snapshot: new Date(cursor.snapshot ?? Date.now()) };
  const end = Math.min(offset + limit, MAX_RESULTS);
  const { userId, isGuest } = actor;

  const parsed = parseSearchQuery(rawQuery);
  const { filters } = parsed;
  const hasFilter = filters.from.length + filters.in.length + filters.has.length + filters.is.length > 0
    || !!(filters.before || filters.after || filters.on);
  // 키워드는 하나하나 2자 이상이어야 하고(파서가 짧은 것은 ignored로 뺀다), 연산자가 있으면 키워드 없이도 검색한다.
  // 쓸 수 있는 키워드도 연산자도 없으면 400이다.
  if (!hasFilter && parsed.terms.length === 0) {
    throw new ServiceError(400, 'Search query must be at least 2 characters');
  }

  // 정렬과 페이지 계산을 위해 각 원본에서 가져올 후보 수
  // Prisma의 contains는 LIKE 와일드카드(% _ \)를 이스케이프하지 않는다. 키워드에 이런 문자가 있으면
  // DB 조건은 넓은 후보를 주고, 서버가 문자 그대로 포함하는지 다시 확인한다(후보 창을 넓게 잡는다).
  const needsVerify = parsed.terms.some((t) => /[%_\\]/.test(t));
  const verified = (texts: Array<string | null | undefined>) =>
    !needsVerify || parsed.terms.every((term) => texts.some((t) => textHasTerm(t, term)));
  // 각 원본에서 가져올 후보 수. 최신순은 필요한 만큼(+1은 더 있는지 보려는 것), 관련도순과 재확인이 필요한 질의는 상한 전체.
  const take = sort === 'recent' && !needsVerify ? Math.min(end + 1, MAX_RESULTS + 1) : MAX_RESULTS + 1;

  const userChannels = await prisma.channelMember.findMany({ where: { userId }, select: { channelId: true } });
  const channelIds = userChannels.map((c) => c.channelId);
  // channelId를 지정하면 멤버인 경우에만 그 채널로 좁힌다(비멤버면 빈 결과, 존재 여부를 알리지 않는다).
  const scopedChannelIds = channelId ? channelIds.filter((id) => id === channelId) : channelIds;

  // DM 접근 범위(게스트 격리와 그룹 멤버십 규칙은 그대로 유지한다)
  const buildDmAccess = async (): Promise<Prisma.DirectMessageWhereInput[]> => {
    let dmUserFilter: number[] | undefined;
    if (isGuest) {
      const sharedMembers = await prisma.$queryRaw<Array<{ userId: number }>>`
        SELECT DISTINCT cm2."userId"
        FROM "ChannelMember" cm1
        JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId" AND cm2."userId" != cm1."userId"
        WHERE cm1."userId" = ${userId}
      `;
      dmUserFilter = sharedMembers.map((m) => m.userId);
      if (dmUserFilter.length === 0) dmUserFilter = undefined;
    }
    // 1:1 DM은 게스트라면 공유 채널 멤버가 있을 때만 검색한다
    const searchOneToOne = !isGuest || !!dmUserFilter;
    // 그룹 DM은 지금 멤버인 그룹만(나간 그룹 제외). 게스트도 자기가 속한 그룹은 검색된다.
    const myGroupIds = (await prisma.dMGroupMember.findMany({ where: { userId }, select: { groupId: true } }))
      .map((g) => g.groupId);
    return [
      ...(myGroupIds.length > 0 ? [{ groupId: { in: myGroupIds } }] : []),
      ...(searchOneToOne ? [
        { fromUserId: userId, groupId: null, ...(dmUserFilter && { toUserId: { in: dmUserFilter } }) },
        { toUserId: userId, groupId: null, ...(dmUserFilter && { fromUserId: { in: dmUserFilter } }) },
      ] : []),
    ];
  };

  const wantsMessages = type === 'all' || type === 'messages';
  // 채널 한정(channelId, in:)이나 is:saved면 DM은 대상이 아니다.
  const wantsDMs = options.includeDms && (type === 'all' || type === 'dms') && !channelId && filters.in.length === 0 && !filters.is.includes('saved');

  type Item = { _score: number; createdAt: Date; [k: string]: unknown };
  const items: Item[] = [];

  const scoreOf = (parts: Array<[string | null | undefined, number]>) =>
    parsed.terms.reduce((s, term) => s + parts.reduce((a, [text, w]) => a + (textHasTerm(text, term) ? w : 0), 0), 0);

  if (wantsMessages && scopedChannelIds.length > 0) {
    const rows = await prisma.message.findMany({
      where: channelMessageWhere(parsed, userId, scopedChannelIds, scope),
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        channel: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    for (const m of rows) {
      if (!verified([m.content, m.user?.name, m.channel?.name])) continue;
      items.push({
        id: m.id,
        type: 'message',
        content: m.content,
        createdAt: m.createdAt,
        user: m.user,
        channel: m.channel,
        threadId: m.threadId,
        highlights: findHighlights(m.content, parsed.terms),
        _score: scoreOf([[m.content, 1], [m.user?.name, 2], [m.channel?.name, 1]]),
      });
    }
  }

  if (wantsDMs) {
    const access = await buildDmAccess();
    if (access.length > 0) {
      const rows = await prisma.directMessage.findMany({
        where: dmMessageWhere(parsed, access, scope),
        include: {
          fromUser: { select: { id: true, name: true, avatar: true } },
          toUser: { select: { id: true, name: true, avatar: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
      });
      for (const dm of rows) {
        // 그룹 메시지는 toUser가 없다. 상대 대신 보낸 사람을 넣고 groupId로 구분한다.
        const otherUser = dm.groupId ? dm.fromUser : dm.fromUserId === userId ? dm.toUser : dm.fromUser;
        if (!verified([dm.content, dm.fromUser?.name, dm.toUser?.name])) continue;
        items.push({
          id: dm.id,
          type: 'dm',
          content: dm.content,
          createdAt: dm.createdAt,
          user: dm.fromUser,
          otherUser,
          participant: otherUser,
          groupId: dm.groupId ?? null,
          threadId: dm.threadId,
          highlights: findHighlights(dm.content, parsed.terms),
          _score: scoreOf([[dm.content, 1], [dm.fromUser?.name, 2], [otherUser?.name, 2]]),
        });
      }
    }
  }

  if (type === 'files') {
    const access = options.includeDms ? await buildDmAccess() : [];
    const created = createdAtFilter(filters, scope);
    const and: Prisma.FileWhereInput[] = [{
      OR: [
        ...(scopedChannelIds.length > 0 ? [{ message: { channelId: { in: scopedChannelIds }, deletedAt: null } }] : []),
        ...(!channelId && filters.in.length === 0 && access.length > 0 ? [{ dm: { deletedAt: null, OR: access } }] : []),
      ],
    }];
    for (const term of parsed.terms) {
      const c = containsAny(term);
      and.push({ OR: [...c.map((x) => ({ filename: x })), ...c.map((x) => ({ originalName: x }))] });
    }
    if (filters.from.length) {
      and.push({ OR: filters.from.flatMap((n) => equalsAny(n).map((x) => ({ user: { name: x } }))) });
    }
    if (filters.in.length) {
      and.push({ OR: filters.in.flatMap((n) => equalsAny(n).map((x) => ({ message: { channel: { name: x } } }))) });
    }
    const rows = await prisma.file.findMany({
      where: {
        ...(created ? { createdAt: created } : {}),
        AND: and,
      },
      include: {
        user: { select: { id: true, name: true, avatar: true } },
        message: { select: { channel: { select: { id: true, name: true } } } },
        dm: { select: { groupId: true, fromUserId: true, toUserId: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    for (const f of rows) {
      const otherId = f.dm && !f.dm.groupId ? (f.dm.fromUserId === userId ? f.dm.toUserId : f.dm.fromUserId) : null;
      if (!verified([f.originalName, f.filename])) continue;
      items.push({
        id: f.id,
        type: 'file',
        filename: f.originalName,
        mimetype: f.mimetype,
        size: f.size,
        url: f.url,
        createdAt: f.createdAt,
        user: f.user,
        channel: f.message?.channel ?? undefined,
        groupId: f.dm?.groupId ?? null,
        participantId: otherId,
        messageId: f.messageId,
        dmId: f.dmId,
        highlights: findHighlights(f.originalName, parsed.terms),
        _score: scoreOf([[f.originalName, 1], [f.filename, 1]]),
      });
    }
  }

  if (type === 'people' && parsed.terms.length > 0) {
    const and: Prisma.UserWhereInput[] = parsed.terms.map((term) => ({ OR: containsAny(term).map((x) => ({ name: x })) }));
    if (isGuest) {
      // 게스트가 볼 수 있는 사람: 자기 자신 + 같은 채널 멤버 + 같은 그룹 DM 멤버.
      // channelId 파라미터와 무관하게 내 모든 채널과 그룹을 기준으로 한다.
      const sharedChannel = channelIds.length > 0
        ? await prisma.channelMember.findMany({ where: { channelId: { in: channelIds } }, select: { userId: true }, distinct: ['userId'] })
        : [];
      const myGroupIds = (await prisma.dMGroupMember.findMany({ where: { userId }, select: { groupId: true } })).map((g) => g.groupId);
      const sharedGroup = myGroupIds.length > 0
        ? await prisma.dMGroupMember.findMany({ where: { groupId: { in: myGroupIds } }, select: { userId: true }, distinct: ['userId'] })
        : [];
      and.push({ id: { in: [...sharedChannel.map((s) => s.userId), ...sharedGroup.map((s) => s.userId), userId] } });
    }
    const rows = await prisma.user.findMany({
      where: { deactivatedAt: null, createdAt: { lte: scope.snapshot }, AND: and },
      select: { id: true, name: true, avatar: true, createdAt: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take,
    });
    for (const u of rows) {
      if (!verified([u.name])) continue;
      items.push({
        id: u.id, type: 'person', name: u.name, avatar: u.avatar, user: { id: u.id, name: u.name, avatar: u.avatar },
        createdAt: u.createdAt, highlights: findHighlights(u.name, parsed.terms), _score: scoreOf([[u.name, 1]]),
      });
    }
  }

  if (type === 'channels' && parsed.terms.length > 0) {
    const and: Prisma.ChannelWhereInput[] = parsed.terms.map((term) => ({
      OR: [...containsAny(term).map((x) => ({ name: x })), ...containsAny(term).map((x) => ({ topic: x }))],
    }));
    // 공개 채널은 게스트가 아닌 모두에게, 비공개 채널과 게스트는 멤버인 채널만
    const visible: Prisma.ChannelWhereInput[] = [{ id: { in: channelIds } }];
    if (!isGuest) visible.push({ isPrivate: false });
    and.push({ OR: visible });
    const rows = await prisma.channel.findMany({
      where: { createdAt: { lte: scope.snapshot }, AND: and },
      select: { id: true, name: true, topic: true, isPrivate: true, archivedAt: true, createdAt: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take,
    });
    for (const c of rows) {
      if (!verified([c.name, c.topic])) continue;
      items.push({
        id: c.id, type: 'channel', name: c.name, topic: c.topic, isPrivate: c.isPrivate,
        isMember: channelIds.includes(c.id), archived: !!c.archivedAt, createdAt: c.createdAt,
        highlights: findHighlights(c.name, parsed.terms), _score: scoreOf([[c.name, 2], [c.topic, 1]]),
      });
    }
  }

  // 정렬: 관련도(점수 내림차순, 같으면 최신) 또는 최신
  const byDate = (a: Item, b: Item) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  // 사람·채널은 이름순으로 이미 정렬해 가져오므로 다시 정렬하지 않는다.
  if (type !== 'people' && type !== 'channels') {
    items.sort(sort === 'recent' ? byDate : (a, b) => b._score - a._score || byDate(a, b));
  }

  const page = items.slice(offset, end);
  const hasMore = items.length > end && end < MAX_RESULTS;
  // 상한(450)까지 다 보여 줬는데도 더 있으면 결과가 잘렸다는 뜻이다. 화면이 필터를 추가하라고 안내한다.
  const truncated = end >= MAX_RESULTS && items.length > MAX_RESULTS;
  const results = page.map(({ _score, ...rest }) => rest);
  // counts는 "이번 페이지에 담긴 결과" 개수다. 전체 일치 개수가 아니다(전체는 비싸고 상한 때문에 부정확하다).
  const counts = { messages: 0, dms: 0, files: 0, people: 0, channels: 0, total: results.length };
  for (const r of results) {
    const kind = r.type as string;
    if (kind === 'message') counts.messages++;
    else if (kind === 'dm') counts.dms++;
    else if (kind === 'file') counts.files++;
    else if (kind === 'person') counts.people++;
    else if (kind === 'channel') counts.channels++;
  }

  return {
    results,
    query: rawQuery,
    parsedFilters: { terms: parsed.terms, ...filters, ignored: parsed.ignored },
    counts,
    hasMore,
    truncated,
    nextCursor: hasMore ? encodeCursor(end, scope.snapshot.getTime()) : null,
  };
}
