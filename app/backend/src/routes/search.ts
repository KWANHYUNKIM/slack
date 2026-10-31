import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';

const router = Router();

const searchQuerySchema = z.object({
  q: z.string().min(2).max(200).or(z.array(z.string()).transform(a => a[0])).pipe(z.string().min(2).max(200)),
  type: z.enum(['messages', 'dms', 'all']).optional().default('all'),
  channelId: z.coerce.number().int().positive().optional(),
});

// GET /search - Search messages and DMs
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid search parameters' });
      return;
    }
    const { q: query, type, channelId } = parsed.data;
    const userId = req.user!.userId;

    const searchMessages = type !== 'dms';
    const searchDMs = type !== 'messages';

    // Get channels user is a member of
    const userChannels = await prisma.channelMember.findMany({
      where: { userId },
      select: { channelId: true },
    });
    const channelIds = userChannels.map((c) => c.channelId);

    // Search channel messages (content, author name, or channel name)
    let messages: any[] = [];
    if (searchMessages && channelIds.length > 0) {
      const channelFilter = channelId ? { equals: channelId } : { in: channelIds };

      // If channelId specified, verify user is a member
      if (channelId && !channelIds.includes(channelId)) {
        // User not a member of this channel, skip message search
      } else {
        messages = await prisma.message.findMany({
          where: {
            channelId: channelFilter,
            deletedAt: null,
            OR: [
              { content: { contains: query, mode: 'insensitive' } },
              { user: { name: { contains: query, mode: 'insensitive' } } },
              { channel: { name: { contains: query, mode: 'insensitive' } } },
            ],
          },
          include: {
            user: {
              select: { id: true, name: true, avatar: true },
            },
            channel: {
              select: { id: true, name: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
      }
    }

    // Search DMs (only if no channelId filter)
    let dms: any[] = [];
    if (searchDMs && !channelId) {
      // Guests: restrict DM search to shared-channel members only
      let dmUserFilter: number[] | undefined;
      if (req.user!.role === 'GUEST') {
        const sharedMembers = await prisma.$queryRaw<Array<{ userId: number }>>`
          SELECT DISTINCT cm2."userId"
          FROM "ChannelMember" cm1
          JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId" AND cm2."userId" != cm1."userId"
          WHERE cm1."userId" = ${userId}
        `;
        dmUserFilter = sharedMembers.map(m => m.userId);
        if (dmUserFilter.length === 0) {
          // Guest has no shared-channel members — skip DM search entirely
          dmUserFilter = undefined;
        }
      }

      if (req.user!.role !== 'GUEST' || dmUserFilter) {
        const dmParticipantFilter = (role: 'fromUserId' | 'toUserId') => ({
          [role]: userId,
          groupId: null,
          ...(dmUserFilter && { [role === 'fromUserId' ? 'toUserId' : 'fromUserId']: { in: dmUserFilter } }),
        });

        // 그룹 DM은 지금 멤버인 그룹의 메시지만 검색한다(나간 그룹 제외)
        const myGroupIds = (await prisma.dMGroupMember.findMany({ where: { userId }, select: { groupId: true } }))
          .map((g) => g.groupId);

        dms = await prisma.directMessage.findMany({
          where: {
            OR: [
              ...(myGroupIds.length > 0 ? [
                { groupId: { in: myGroupIds }, content: { contains: query, mode: 'insensitive' as const } },
                { groupId: { in: myGroupIds }, fromUser: { name: { contains: query, mode: 'insensitive' as const } } },
              ] : []),
              { ...dmParticipantFilter('fromUserId'), content: { contains: query, mode: 'insensitive' } },
              { ...dmParticipantFilter('toUserId'), content: { contains: query, mode: 'insensitive' } },
              { ...dmParticipantFilter('fromUserId'), fromUser: { name: { contains: query, mode: 'insensitive' } } },
              { ...dmParticipantFilter('fromUserId'), toUser: { name: { contains: query, mode: 'insensitive' } } },
              { ...dmParticipantFilter('toUserId'), fromUser: { name: { contains: query, mode: 'insensitive' } } },
              { ...dmParticipantFilter('toUserId'), toUser: { name: { contains: query, mode: 'insensitive' } } },
            ],
            deletedAt: null,
          },
          include: {
            fromUser: {
              select: { id: true, name: true, avatar: true },
            },
            toUser: {
              select: { id: true, name: true, avatar: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
      }
    }

    // Combine and format results with relevance scoring
    const queryLower = query.toLowerCase();

    const formattedMessages = messages.map((m) => {
      let score = 0;
      if (m.content?.toLowerCase().includes(queryLower)) score += 1;
      if (m.user?.name?.toLowerCase().includes(queryLower)) score += 2;
      if (m.channel?.name?.toLowerCase().includes(queryLower)) score += 1;
      return {
        id: m.id,
        type: 'message' as const,
        content: m.content,
        createdAt: m.createdAt,
        user: m.user,
        channel: m.channel,
        threadId: m.threadId,
        _score: score,
      };
    });

    const formattedDMs = dms.map((dm) => {
      let score = 0;
      if (dm.content?.toLowerCase().includes(queryLower)) score += 1;
      // 그룹 메시지는 toUser가 없다. 상대 대신 보낸 사람을 넣고 groupId로 구분한다.
      const otherUser = dm.groupId ? dm.fromUser : dm.fromUserId === userId ? dm.toUser : dm.fromUser;
      if (dm.fromUser?.name?.toLowerCase().includes(queryLower)) score += 2;
      if (otherUser?.name?.toLowerCase().includes(queryLower)) score += 2;
      return {
        id: dm.id,
        type: 'dm' as const,
        content: dm.content,
        createdAt: dm.createdAt,
        user: dm.fromUser,
        otherUser,
        participant: otherUser,
        groupId: dm.groupId ?? null,
        _score: score,
      };
    });

    // Merge, sort by score (desc) then date (desc), strip internal score
    const results = [...formattedMessages, ...formattedDMs]
      .sort((a, b) => b._score - a._score || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50)
      .map(({ _score, ...rest }) => rest);

    res.json({
      results,
      query,
      counts: {
        messages: formattedMessages.length,
        dms: formattedDMs.length,
        total: results.length,
      },
    });
  } catch (error) {
    logError('Search error', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

export default router;
