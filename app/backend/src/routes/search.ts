import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';
import {
  parseSearchQuery, termVariants, dateRangeOf, findHighlights, MAX_QUERY_LENGTH,
  type ParsedQuery,
} from '../utils/searchQuery.js';

const router = Router();

const MAX_OFFSET = 450;       // 커서가 가리킬 수 있는 최대 위치
const RELEVANCE_WINDOW = 200; // 관련도 정렬은 최신 후보 200건 안에서 점수를 매긴다

const firstString = (v: unknown) => (Array.isArray(v) ? v[0] : v);

const searchQuerySchema = z.object({
  q: z.preprocess(firstString, z.string().min(1).max(MAX_QUERY_LENGTH)),
  type: z.preprocess(firstString, z.enum(['messages', 'dms', 'all', 'files', 'people', 'channels']).optional().default('all')),
  channelId: z.coerce.number().int().positive().optional(),
  sort: z.preprocess(firstString, z.enum(['relevance', 'recent']).optional().default('relevance')),
  limit: z.coerce.number().int().min(1).max(50).optional().default(50),
  cursor: z.preprocess(firstString, z.string().max(20).optional()),
});

/** 커서는 결과 목록 안의 위치(offset)를 base64url로 감싼 값이다. 잘못된 값은 처음부터 시작한다. */
function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  return Number.isInteger(n) && n >= 0 && n <= MAX_OFFSET ? n : 0;
}
const encodeCursor = (offset: number) => Buffer.from(String(offset), 'utf8').toString('base64url');

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
function channelMessageWhere(p: ParsedQuery, userId: number, channelIds: number[]): Prisma.MessageWhereInput {
  const { filters } = p;
  const range = dateRangeOf(filters);
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
    ...(range.gte || range.lt ? { createdAt: { ...(range.gte && { gte: range.gte }), ...(range.lt && { lt: range.lt }) } } : {}),
    AND: and,
  };
}

/** DM 메시지 검색 조건. access는 내가 볼 수 있는 DM·그룹 DM 범위다. */
function dmMessageWhere(p: ParsedQuery, access: Prisma.DirectMessageWhereInput[]): Prisma.DirectMessageWhereInput {
  const { filters } = p;
  const range = dateRangeOf(filters);
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
    ...(range.gte || range.lt ? { createdAt: { ...(range.gte && { gte: range.gte }), ...(range.lt && { lt: range.lt }) } } : {}),
    AND: and,
  };
}

// GET /search - 메시지, DM, 파일, 사람, 채널 검색
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const parsedParams = searchQuerySchema.safeParse(req.query);
    if (!parsedParams.success) {
      res.status(400).json({ error: parsedParams.error.issues[0]?.message || 'Invalid search parameters' });
      return;
    }
    const { q: rawQuery, type, channelId, sort, limit } = parsedParams.data;
    const offset = decodeCursor(parsedParams.data.cursor);
    const userId = req.user!.userId;
    const isGuest = req.user!.role === 'GUEST';

    const parsed = parseSearchQuery(rawQuery);
    const { filters } = parsed;
    const hasFilter = filters.from.length + filters.in.length + filters.has.length + filters.is.length > 0
      || !!(filters.before || filters.after || filters.on);
    const keywordLength = parsed.terms.join('').length;
    // 연산자가 있으면 키워드 없이도 검색한다. 키워드만 있을 때는 예전처럼 2자 이상이어야 한다.
    if (!hasFilter && keywordLength < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    // 정렬과 페이지 계산을 위해 각 원본에서 가져올 후보 수
    // Prisma의 contains는 LIKE 와일드카드(% _ \)를 이스케이프하지 않는다. 키워드에 이런 문자가 있으면
    // DB 조건은 넓은 후보를 주고, 서버가 문자 그대로 포함하는지 다시 확인한다(후보 창을 넓게 잡는다).
    const needsVerify = parsed.terms.some((t) => /[%_\\]/.test(t));
    const verified = (texts: Array<string | null | undefined>) =>
      !needsVerify || parsed.terms.every((term) => texts.some((t) => textHasTerm(t, term)));
    const take = sort === 'recent' && !needsVerify ? Math.min(offset + limit + 1, MAX_OFFSET + 51) : RELEVANCE_WINDOW;

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
    const wantsDMs = (type === 'all' || type === 'dms') && !channelId && filters.in.length === 0 && !filters.is.includes('saved');

    type Item = { _score: number; createdAt: Date; [k: string]: unknown };
    const items: Item[] = [];
    const counts = { messages: 0, dms: 0, files: 0, people: 0, channels: 0, total: 0 };

    const scoreOf = (parts: Array<[string | null | undefined, number]>) =>
      parsed.terms.reduce((s, term) => s + parts.reduce((a, [text, w]) => a + (textHasTerm(text, term) ? w : 0), 0), 0);

    if (wantsMessages && scopedChannelIds.length > 0) {
      const rows = await prisma.message.findMany({
        where: channelMessageWhere(parsed, userId, scopedChannelIds),
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
        counts.messages++;
      }
    }

    if (wantsDMs) {
      const access = await buildDmAccess();
      if (access.length > 0) {
        const rows = await prisma.directMessage.findMany({
          where: dmMessageWhere(parsed, access),
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
          counts.dms++;
        }
      }
    }

    if (type === 'files') {
      const access = await buildDmAccess();
      const range = dateRangeOf(filters);
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
          ...(range.gte || range.lt ? { createdAt: { ...(range.gte && { gte: range.gte }), ...(range.lt && { lt: range.lt }) } } : {}),
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
        counts.files++;
      }
    }

    if (type === 'people' && parsed.terms.length > 0) {
      const and: Prisma.UserWhereInput[] = parsed.terms.map((term) => ({ OR: containsAny(term).map((x) => ({ name: x })) }));
      if (isGuest) {
        // 게스트는 자기와 같은 채널에 있는 사람만 본다
        const shared = scopedChannelIds.length > 0
          ? await prisma.channelMember.findMany({ where: { channelId: { in: channelIds } }, select: { userId: true }, distinct: ['userId'] })
          : [];
        and.push({ id: { in: [...shared.map((s) => s.userId), userId] } });
      }
      const rows = await prisma.user.findMany({
        where: { deactivatedAt: null, AND: and },
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
        counts.people++;
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
        where: { AND: and },
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
        counts.channels++;
      }
    }

    // 정렬: 관련도(점수 내림차순, 같으면 최신) 또는 최신
    const byDate = (a: Item, b: Item) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    // 사람·채널은 이름순으로 이미 정렬해 가져오므로 다시 정렬하지 않는다.
    if (type !== 'people' && type !== 'channels') {
      items.sort(sort === 'recent' ? byDate : (a, b) => b._score - a._score || byDate(a, b));
    }

    const page = items.slice(offset, offset + limit);
    const hasMore = items.length > offset + limit && offset + limit <= MAX_OFFSET;
    const results = page.map(({ _score, ...rest }) => rest);
    counts.total = results.length;

    res.json({
      results,
      query: rawQuery,
      parsedFilters: { terms: parsed.terms, ...filters },
      counts,
      hasMore,
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
    });
  } catch (error) {
    logError('Search error', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

export default router;
