import { Router, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { channelTimelineWhere } from '../db/timeline.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireChannelMembership, requirePublicChannelReadAccess, listableChannelsWhere } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { isUserOnline, getIO } from '../websocket/index.js';
import { USER_SELECT_BASIC, USER_SELECT_FULL, MESSAGE_INCLUDE_FULL } from '../db/selects.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { validateChannelName } from '../utils/channelName.js';
import { updateChannel, CHANNEL_NAME_TAKEN } from '../services/channelService.js';
import { markChannelMentionsRead, getMentionCountsByChannel } from '../services/mentionService.js';

const router = Router();

const createChannelSchema = z.object({
  name: z.unknown(),
  isPrivate: z.boolean().optional().default(false),
});

// POST /channels - Create channel
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role === 'GUEST') {
      res.status(403).json({ error: 'Guests cannot create channels' });
      return;
    }
    const parsed = createChannelSchema.parse(req.body);
    const nameResult = validateChannelName(parsed.name);
    if (!nameResult.ok) {
      res.status(400).json({ error: nameResult.error, code: nameResult.code, reason: nameResult.reason });
      return;
    }
    const name = nameResult.name;
    const isPrivate = parsed.isPrivate;
    const userId = req.user!.userId;

    // Case-insensitive uniqueness check (DB unique constraint is case-sensitive)
    const existing = await prisma.channel.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing) {
      res.status(400).json({ error: 'Channel name already exists', code: CHANNEL_NAME_TAKEN });
      return;
    }

    const channel = await prisma.channel.create({
      data: {
        name,
        isPrivate,
        createdBy: userId,
        members: {
          create: {
            userId,
            role: 'OWNER',
          },
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, avatar: true },
            },
          },
        },
      },
    });

    void writeAuditLog({
      action: 'channel.created',
      actorId: userId,
      targetType: 'channel',
      targetId: channel.id,
      targetName: channel.name,
      details: isPrivate ? 'private' : 'public',
    });

    res.status(201).json(channel);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      res.status(400).json({ error: 'Channel name already exists', code: CHANNEL_NAME_TAKEN });
      return;
    }
    logError('Create channel error', error);
    res.status(500).json({ error: 'Failed to create channel' });
  }
});

// GET /channels - List all channels
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    const channels = await prisma.channel.findMany({
      where: listableChannelsWhere(userId, req.user!.role),
      include: {
        _count: {
          select: { members: true, messages: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Batch: get memberships and unread counts in parallel (2 queries instead of N+1)
    const channelIds = channels.map(c => c.id);

    const [memberships, unreadRows, mentionMap, stars] = await Promise.all([
      prisma.channelMember.findMany({
        where: { userId, channelId: { in: channelIds } },
        select: { channelId: true },
      }),
      channelIds.length > 0
        ? prisma.$queryRaw<Array<{ channelId: number; unreadCount: bigint }>>`
            SELECT m."channelId", COUNT(*)::bigint AS "unreadCount"
            FROM "Message" m
            JOIN "ChannelMember" cm ON cm."channelId" = m."channelId" AND cm."userId" = ${userId}
            LEFT JOIN "ChannelRead" cr ON cr."channelId" = m."channelId" AND cr."userId" = ${userId}
            WHERE m."channelId" = ANY(${channelIds})
              AND (m."threadId" IS NULL OR m."alsoSendToChannel")
              AND m."deletedAt" IS NULL
              AND (cr."lastReadMessageId" IS NULL OR m.id > cr."lastReadMessageId")
            GROUP BY m."channelId"
          `
        : Promise.resolve([]),
      getMentionCountsByChannel(userId, channelIds),
      prisma.channelStar.findMany({
        where: { userId, channelId: { in: channelIds } },
        select: { channelId: true },
      }),
    ]);

    const memberSet = new Set(memberships.map(m => m.channelId));
    const starredSet = new Set(stars.map(st => st.channelId));
    const unreadMap = new Map(unreadRows.map(r => [r.channelId, Number(r.unreadCount)]));

    const channelsWithUnread = channels.map((channel) => ({
      ...channel,
      unreadCount: memberSet.has(channel.id) ? (unreadMap.get(channel.id) || 0) : 0,
      mentionCount: memberSet.has(channel.id) ? (mentionMap.get(channel.id) || 0) : 0,
      isMember: memberSet.has(channel.id),
      isStarred: starredSet.has(channel.id),
    }));

    res.json(channelsWithUnread);
  } catch (error) {
    logError('List channels error', error);
    res.status(500).json({ error: 'Failed to list channels' });
  }
});

// GET /channels/:id - Get single channel
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = parseIntParam(req.params.id);
    if (!channelId) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }
    const userId = req.user!.userId;

    const withUnread = req.query.withUnread === '1';

    const [channel, star, unreadRows] = await Promise.all([
      prisma.channel.findUnique({
      where: { id: channelId },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, avatar: true },
            },
          },
        },
        _count: {
          select: { messages: true },
        },
      },
    }),
      prisma.channelStar.findUnique({
        where: { userId_channelId: { userId, channelId } },
        select: { userId: true },
      }),
      withUnread
        ? prisma.$queryRaw<Array<{ lastReadMessageId: number | null; unreadCount: bigint }>>`
            SELECT cr."lastReadMessageId" AS "lastReadMessageId",
              (SELECT COUNT(*)::bigint FROM "Message" m
                WHERE m."channelId" = ${channelId}
                  AND (m."threadId" IS NULL OR m."alsoSendToChannel")
                  AND m."deletedAt" IS NULL
                  AND (cr."lastReadMessageId" IS NULL OR m.id > cr."lastReadMessageId")) AS "unreadCount"
            FROM (SELECT 1) one
            LEFT JOIN "ChannelRead" cr ON cr."userId" = ${userId} AND cr."channelId" = ${channelId}
          `
        : Promise.resolve(null),
    ]);
    const unreadRow = unreadRows?.[0];

    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const isMember = channel.members.some(m => m.userId === userId);

    // Check access: private channels require membership; guests can only access their own channels
    if (!isMember && (channel.isPrivate || req.user!.role === 'GUEST')) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const isStarred = !!star;

    // Non-members viewing public channels get a minimal member list:
    // only user id + name.  The ...m spread that was here previously
    // leaked ChannelMember fields (role, joinedAt) to non-members.
    if (!isMember) {
      const sanitized = {
        ...channel,
        isStarred,
        members: channel.members.map(m => ({
          user: { id: m.user.id, name: m.user.name },
        })),
      };
      res.json(sanitized);
      return;
    }

    // 안 읽음 구분선용 기준점(?withUnread=1일 때만). 읽음 처리는 하지 않는다. 행이 없으면 목록 배지처럼 전부 안 읽음(null)이다.
    res.json(unreadRow
      ? { ...channel, isStarred, lastReadMessageId: unreadRow.lastReadMessageId, unreadCount: Number(unreadRow.unreadCount) }
      : { ...channel, isStarred });
  } catch (error) {
    logError('Get channel error', error);
    res.status(500).json({ error: 'Failed to get channel' });
  }
});

// 토픽·설명: 앞뒤 공백을 지우고, 빈 문자열이나 null은 비우기(null 저장)로 취급한다.
const metaText = (max: number) =>
  z.string().max(max)
    .refine(val => !val.includes('\u0000'), { message: 'Text cannot contain null bytes' })
    .transform(val => val.trim() || null)
    .nullable()
    .optional();

const updateChannelSchema = z.object({
  name: z.unknown().optional(),
  topic: metaText(250),
  description: metaText(500),
}).strict().refine(
  data => data.name !== undefined || data.topic !== undefined || data.description !== undefined,
  { message: 'At least one field must be provided' },
);

// PATCH /channels/:id - 이름, 토픽, 설명 수정 (채널 OWNER/MODERATOR 또는 워크스페이스 ADMIN 이상)
router.patch('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = parseIntParam(req.params.id);
    if (!channelId) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }
    const userId = req.user!.userId;
    const isWorkspaceAdmin = req.user!.role === 'ADMIN' || req.user!.role === 'OWNER';

    const [channel, membership] = await Promise.all([
      prisma.channel.findUnique({ where: { id: channelId } }),
      prisma.channelMember.findUnique({ where: { userId_channelId: { userId, channelId } } }),
    ]);
    // 비공개 채널의 비멤버에게는 존재 자체를 숨긴다(워크스페이스 관리자는 예외)
    if (!channel || (!membership && channel.isPrivate && !isWorkspaceAdmin)) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const canEdit = isWorkspaceAdmin || membership?.role === 'OWNER' || membership?.role === 'MODERATOR';
    if (!canEdit) {
      res.status(403).json({ error: 'Only channel owners, moderators, or workspace admins can edit this channel' });
      return;
    }
    if (channel.archivedAt) {
      res.status(403).json({ error: 'This channel has been archived' });
      return;
    }

    const parsed = updateChannelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
      return;
    }

    // 이름 검증·중복·알림은 관리자 경로와 같은 서비스 함수가 맡는다.
    const result = await updateChannel({
      channel,
      actorId: userId,
      input: parsed.data,
    });
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    const updated = result.channel;

    res.json(updated);
  } catch (error) {
    logError('Update channel error', error);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// PUT /channels/:id/star - 즐겨찾기 추가 (멱등)
router.put('/:id/star', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const userId = req.user!.userId;
    await prisma.channelStar.upsert({
      where: { userId_channelId: { userId, channelId } },
      create: { userId, channelId },
      update: {},
    });
    getIO()?.to(`user:${userId}`).emit('star:updated', { type: 'channel', id: channelId, isStarred: true });
    res.json({ channelId, isStarred: true });
  } catch (error) {
    logError('Star channel error', error);
    res.status(500).json({ error: 'Failed to star channel' });
  }
});

// DELETE /channels/:id/star - 즐겨찾기 해제 (멱등)
router.delete('/:id/star', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const userId = req.user!.userId;
    await prisma.channelStar.deleteMany({ where: { userId, channelId } });
    getIO()?.to(`user:${userId}`).emit('star:updated', { type: 'channel', id: channelId, isStarred: false });
    res.json({ channelId, isStarred: false });
  } catch (error) {
    logError('Unstar channel error', error);
    res.status(500).json({ error: 'Failed to unstar channel' });
  }
});

// POST /channels/:id/join - Join a channel
router.post('/:id/join', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role === 'GUEST') {
      res.status(403).json({ error: 'Guests cannot join channels' });
      return;
    }
    const channelId = parseIntParam(req.params.id);
    if (!channelId) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }
    const userId = req.user!.userId;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    });

    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // Prevent joining private channels without invite
    if (channel.isPrivate) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // Prevent joining archived channels
    if (channel.archivedAt) {
      res.status(403).json({ error: 'This channel has been archived' });
      return;
    }

    const existingMembership = await prisma.channelMember.findUnique({
      where: {
        userId_channelId: { userId, channelId },
      },
    });

    if (existingMembership) {
      res.status(400).json({ error: 'Already a member of this channel' });
      return;
    }

    await prisma.channelMember.create({
      data: { userId, channelId },
    });

    // Auto-create ChannelRead so all existing messages count as unread
    await prisma.channelRead.upsert({
      where: { userId_channelId: { userId, channelId } },
      create: { userId, channelId, lastReadMessageId: null },
      update: {},
    });

    res.json({ message: 'Joined channel successfully' });
  } catch (error) {
    logError('Join channel error', error);
    res.status(500).json({ error: 'Failed to join channel' });
  }
});

// POST /channels/:id/leave - Leave a channel
router.post('/:id/leave', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const userId = req.user!.userId;

    // Block leaving archived channels — prevents cascade deletion of archived history
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { archivedAt: true },
    });
    if (channel?.archivedAt) {
      res.status(403).json({ error: 'This channel has been archived' });
      return;
    }

    // Wrap in transaction to avoid race condition on member count
    const result = await prisma.$transaction(async (tx) => {
      const memberCount = await tx.channelMember.count({ where: { channelId } });

      if (memberCount <= 1) {
        // Last member leaving — delete the channel (cascades to members)
        await tx.channel.delete({ where: { id: channelId } });
        return { deleted: true, memberCount: 0 };
      }

      await tx.channelMember.delete({
        where: { userId_channelId: { userId, channelId } },
      });
      const updatedCount = await tx.channelMember.count({ where: { channelId } });
      return { deleted: false, memberCount: updatedCount };
    });

    if (!result.deleted) {
      const io = getIO();
      if (io) {
        io.to(`channel:${channelId}`).emit('channel:member-left', {
          channelId,
          userId,
          memberCount: result.memberCount,
        });
        // Evict user's sockets from the channel room so they stop receiving messages
        io.in(`user:${userId}`).socketsLeave(`channel:${channelId}`);
      }
    }

    res.json({ message: 'Left channel successfully' });
  } catch (error) {
    logError('Leave channel error', error);
    res.status(500).json({ error: 'Failed to leave channel' });
  }
});

// GET /channels/:id/members - List channel members
router.get('/:id/members', authMiddleware, requirePublicChannelReadAccess, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;

    const members = await prisma.channelMember.findMany({
      where: { channelId },
      include: {
        user: {
          select: USER_SELECT_FULL,
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    // Enrich with real-time online status and channel role
    const enrichedMembers = members.map((m) => ({
      ...m,
      channelRole: m.role,
      user: {
        ...m.user,
        isOnline: isUserOnline(m.user.id),
        status: isUserOnline(m.user.id) ? 'online' : (m.user.status || 'offline'),
      },
    }));

    res.json(enrichedMembers);
  } catch (error) {
    logError('List members error', error);
    res.status(500).json({ error: 'Failed to list members' });
  }
});

// POST /channels/:id/members - Add a user to a channel
const addMemberSchema = z.object({
  userId: z.number().int().positive(),
});

router.post('/:id/members', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const { userId } = addMemberSchema.parse(req.body);

    // For private channels, only the channel creator can add users
    const channel = await prisma.channel.findUnique({ where: { id: channelId } });
    if (channel?.archivedAt) {
      res.status(403).json({ error: 'This channel has been archived' });
      return;
    }
    if (channel?.isPrivate) {
      if (channel.createdBy !== req.user!.userId) {
        res.status(403).json({ error: 'Only the channel creator can add members to private channels' });
        return;
      }
    }

    // Check user exists and is active
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, deactivatedAt: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (user.deactivatedAt) {
      res.status(400).json({ error: 'Cannot add a deactivated user to a channel' });
      return;
    }

    // Only admins/owners can add guest users to channels (prevents
    // regular members from expanding guest access beyond admin intent)
    if (user.role === 'GUEST' && req.user!.role !== 'ADMIN' && req.user!.role !== 'OWNER') {
      res.status(403).json({ error: 'Only workspace admins can add guest users to channels' });
      return;
    }

    // Check not already a member
    const existing = await prisma.channelMember.findUnique({
      where: { userId_channelId: { userId, channelId } },
    });
    if (existing) {
      res.status(400).json({ error: 'User is already a member' });
      return;
    }

    await prisma.channelMember.create({
      data: { userId, channelId },
    });

    await prisma.channelRead.upsert({
      where: { userId_channelId: { userId, channelId } },
      create: { userId, channelId, lastReadMessageId: null },
      update: {},
    });

    // Get updated member count
    const memberCount = await prisma.channelMember.count({ where: { channelId } });

    // Notify all channel members (including the newly added user) via WebSocket
    const io = getIO();
    if (io) {
      // Notify existing channel members about the updated count
      io.to(`channel:${channelId}`).emit('channel:member-added', {
        channelId,
        userId,
        memberCount,
      });
      // Notify the added user so their sidebar refreshes
      io.to(`user:${userId}`).emit('channel:joined', {
        channelId,
        memberCount,
      });
    }

    // 관리자 경로(/admin/channels/:id/members)와 같은 action 이름으로 기록한다
    void writeAuditLog({
      action: 'channel.member_added',
      actorId: req.user!.userId,
      targetType: 'channel',
      targetId: channelId,
      targetName: channel?.name,
      details: `Added user ${userId} to channel`,
    });

    res.json({ message: 'Member added successfully' });
  } catch (error) {
    logError('Add member error', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// PATCH /channels/:id/members/:userId - Change a member's channel role
const updateMemberRoleSchema = z.object({
  role: z.enum(['OWNER', 'MODERATOR', 'MEMBER']),
});

const CHANNEL_ROLE_RANK: Record<string, number> = { OWNER: 2, MODERATOR: 1, MEMBER: 0 };

router.patch('/:id/members/:userId', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const targetUserId = parseIntParam(req.params.userId);
    if (!targetUserId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    const { role } = updateMemberRoleSchema.parse(req.body);
    const actorId = req.user!.userId;

    // Block role changes in archived channels
    const roleChannel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { archivedAt: true },
    });
    if (roleChannel?.archivedAt) {
      res.status(403).json({ error: 'This channel has been archived' });
      return;
    }

    // Get actor's channel membership
    const actorMember = await prisma.channelMember.findUnique({
      where: { userId_channelId: { userId: actorId, channelId } },
    });

    if (!actorMember || actorMember.role !== 'OWNER') {
      res.status(403).json({ error: 'Only the channel owner can change member roles' });
      return;
    }

    if (actorId === targetUserId) {
      res.status(400).json({ error: 'Cannot change your own role' });
      return;
    }

    const targetMember = await prisma.channelMember.findUnique({
      where: { userId_channelId: { userId: targetUserId, channelId } },
    });

    if (!targetMember) {
      res.status(404).json({ error: 'User is not a member of this channel' });
      return;
    }

    // If transferring channel ownership, demote self to MODERATOR
    if (role === 'OWNER') {
      await prisma.$transaction([
        prisma.channelMember.update({
          where: { userId_channelId: { userId: actorId, channelId } },
          data: { role: 'MODERATOR' },
        }),
        prisma.channelMember.update({
          where: { userId_channelId: { userId: targetUserId, channelId } },
          data: { role: 'OWNER' },
        }),
      ]);
    } else {
      await prisma.channelMember.update({
        where: { userId_channelId: { userId: targetUserId, channelId } },
        data: { role },
      });
    }

    res.json({ message: 'Member role updated' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Update member role error', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
});

// DELETE /channels/:id/members/:userId - Remove a member from a channel
router.delete('/:id/members/:userId', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const targetUserId = parseIntParam(req.params.userId);
    if (!targetUserId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    const actorId = req.user!.userId;

    // Cannot remove yourself - use the leave endpoint instead
    if (actorId === targetUserId) {
      res.status(400).json({ error: 'Cannot remove yourself from the channel. Use the leave endpoint instead.' });
      return;
    }

    // Get channel details and check if archived
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { archivedAt: true, createdBy: true, name: true },
    });

    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    if (channel.archivedAt) {
      res.status(403).json({ error: 'This channel has been archived' });
      return;
    }

    // Cannot remove the channel creator
    if (channel.createdBy === targetUserId) {
      res.status(403).json({ error: 'Cannot remove the channel creator' });
      return;
    }

    // Get actor's channel membership
    const actorMember = await prisma.channelMember.findUnique({
      where: { userId_channelId: { userId: actorId, channelId } },
    });

    if (!actorMember) {
      res.status(403).json({ error: 'You are not a member of this channel' });
      return;
    }

    // Get target's channel membership
    const targetMember = await prisma.channelMember.findUnique({
      where: { userId_channelId: { userId: targetUserId, channelId } },
    });

    if (!targetMember) {
      res.status(404).json({ error: 'User is not a member of this channel' });
      return;
    }

    // Authorization logic:
    // 1. Channel OWNER can remove anyone (except creator and themselves)
    // 2. Channel MODERATOR can only remove MEMBERs (not OWNER/MODERATOR)
    // 3. Channel MEMBER cannot remove anyone
    // Note: Workspace admins should use /admin/channels/:id/members/:userId instead
    const isChannelOwner = actorMember.role === 'OWNER';
    const isChannelModerator = actorMember.role === 'MODERATOR';

    if (!isChannelOwner && !isChannelModerator) {
      res.status(403).json({ error: 'Only channel owners and moderators can remove members' });
      return;
    }

    // If actor is MODERATOR, they can only remove MEMBERs
    if (isChannelModerator && !isChannelOwner) {
      if (targetMember.role !== 'MEMBER') {
        res.status(403).json({ error: 'Moderators can only remove regular members' });
        return;
      }
    }

    // Use transaction to ensure atomicity
    const result = await prisma.$transaction(async (tx) => {
      await tx.channelMember.delete({
        where: { userId_channelId: { userId: targetUserId, channelId } },
      });
      const memberCount = await tx.channelMember.count({ where: { channelId } });
      return { memberCount };
    });

    // Emit WebSocket events
    const io = getIO();
    if (io) {
      // Notify channel members about the removal (same event as voluntary leave)
      io.to(`channel:${channelId}`).emit('channel:member-left', {
        channelId,
        userId: targetUserId,
        memberCount: result.memberCount,
      });
      // Evict user's sockets from the channel room
      io.in(`user:${targetUserId}`).socketsLeave(`channel:${channelId}`);
    }

    // Get target user name for audit log
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { name: true },
    });

    // Write audit log (fire-and-forget, non-blocking)
    writeAuditLog({
      action: 'channel.member_removed',
      actorId,
      targetType: 'channel',
      targetId: channelId,
      targetName: channel.name,
      details: `Removed user: ${targetUser?.name || targetUserId}`,
    });

    res.json({ message: 'Member removed successfully' });
  } catch (error) {
    logError('Remove member error', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// POST /channels/:id/read - Mark channel as read
const markReadSchema = z.object({
  messageId: z.number().int().positive(),
});

// 읽음 커서를 SQL 문장 하나로 앞당긴다(upsert + 조건부 갱신). 읽고-쓰기나 "갱신 시도 후 조회 후 생성"으로 나누면
// 그 사이에 다른 요청이 행을 만들어 큰 id의 갱신이 사라지거나 커서가 뒤로 돈다.
// 존재 확인도 같은 문장에 넣는다: 확인 뒤 메시지가 하드 삭제돼도 FK 오류(500) 없이 움직이지 않은 것(false)으로 끝난다.
async function advanceReadCursor(userId: number, channelId: number, messageId: number): Promise<boolean> {
  const now = new Date();
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    INSERT INTO "ChannelRead" ("userId", "channelId", "lastReadMessageId", "updatedAt")
    SELECT ${userId}, ${channelId}, ${messageId}, ${now}
    WHERE EXISTS (SELECT 1 FROM "Message" WHERE id = ${messageId})
    ON CONFLICT ("userId", "channelId") DO UPDATE
      SET "lastReadMessageId" = EXCLUDED."lastReadMessageId", "updatedAt" = EXCLUDED."updatedAt"
      WHERE "ChannelRead"."lastReadMessageId" IS NULL OR "ChannelRead"."lastReadMessageId" < EXCLUDED."lastReadMessageId"
    RETURNING id`;
  return rows.length > 0;
}

router.post('/:id/read', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const userId = req.user!.userId;
    const { messageId } = markReadSchema.parse(req.body);

    // 같은 채널 소속인지만 확인한다. 삭제된 메시지 id도 받아 주어야 마지막으로 본 메시지가 지워진 뒤에도
    // 읽음 처리가 된다. 다른 채널의 id는 존재 여부를 숨기려고 똑같이 404로 거부한다.
    const message = await prisma.message.findFirst({
      where: { id: messageId, channelId },
      select: { id: true },
    });

    if (!message) {
      res.status(404).json({ error: 'Message not found in this channel' });
      return;
    }

    // 커서는 앞으로만 간다. 커서가 실제로 움직였을 때만, 요청한 위치까지의 멘션을 읽음 처리한다.
    const moved = await advanceReadCursor(userId, channelId, messageId);
    if (moved) {
      await markChannelMentionsRead(userId, channelId, messageId).catch((err) => logError('Mark channel mentions read failed', err));
    }

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Mark channel read error', error);
    res.status(500).json({ error: 'Failed to mark channel as read' });
  }
});

// POST /channels/:id/read/baseline - Establish a read baseline when opening a channel
// No-op if a ChannelRead record already exists; creates one at the latest message if not.
// This ensures GET /unreads can correctly identify messages that arrived after the user
// last visited the channel, even if they never scrolled to the bottom.
router.post('/:id/read/baseline', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const userId = req.user!.userId;

    // 기준선이 이미 있으면 아무것도 하지 않는다. 최신 메시지를 기준선으로 삼아 한 문장으로 만든다(동시 요청은 DO NOTHING).
    const latestMessage = await prisma.message.findFirst({
      where: channelTimelineWhere(channelId, { liveOnly: true }),
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    const latestId = latestMessage?.id ?? null;
    const created = await prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO "ChannelRead" ("userId", "channelId", "lastReadMessageId", "updatedAt")
      SELECT ${userId}, ${channelId}, (SELECT id FROM "Message" WHERE id = ${latestId}), ${new Date()}
      ON CONFLICT ("userId", "channelId") DO NOTHING
      RETURNING id`;
    if (created.length === 0) {
      res.json({ success: true });
      return;
    }

    // 커서를 최신으로 옮겼으니 그 아래 오래된 멘션도 읽음 처리한다. 맨 아래로 스크롤하지 않아도 /read 없이 정리된다.
    if (latestMessage) {
      await markChannelMentionsRead(userId, channelId, latestMessage.id).catch((err) => logError('Mark channel mentions read failed', err));
    }

    res.json({ success: true });
  } catch (error) {
    logError('Mark channel read baseline error', error);
    res.status(500).json({ error: 'Failed to set read baseline' });
  }
});

// POST /channels/:id/unread - Mark channel as unread from a specific message
const markUnreadSchema = z.object({
  messageId: z.number().int().positive(),
});

router.post('/:id/unread', authMiddleware, requireChannelMembership, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;
    const userId = req.user!.userId;
    const { messageId } = markUnreadSchema.parse(req.body);

    // Verify messageId belongs to this channel
    const targetMessage = await prisma.message.findFirst({
      where: { id: messageId, channelId, deletedAt: null },
    });
    if (!targetMessage) {
      res.status(404).json({ error: 'Message not found in this channel' });
      return;
    }

    // Find the message just before this one in the channel
    const previousMessage = await prisma.message.findFirst({
      where: { ...channelTimelineWhere(channelId, { liveOnly: true }), id: { lt: messageId } },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    // Set lastReadMessageId to the previous message (or null if this is the first message)
    await prisma.channelRead.upsert({
      where: { userId_channelId: { userId, channelId } },
      create: { userId, channelId, lastReadMessageId: previousMessage?.id ?? null },
      update: { lastReadMessageId: previousMessage?.id ?? null },
    });

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Mark channel unread error', error);
    res.status(500).json({ error: 'Failed to mark channel as unread' });
  }
});

// GET /channels/:id/files - Get files uploaded in channel
router.get('/:id/files', authMiddleware, requirePublicChannelReadAccess, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;

    const files = await prisma.file.findMany({
      where: {
        message: { channelId, deletedAt: null },
      },
      select: {
        id: true,
        filename: true,
        originalName: true,
        mimetype: true,
        size: true,
        url: true,
        userId: true,
        createdAt: true,
        user: { select: { id: true, name: true, avatar: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(files);
  } catch (error) {
    logError('Get channel files error', error);
    res.status(500).json({ error: 'Failed to get channel files' });
  }
});

// GET /channels/:id/pins - Get pinned messages
router.get('/:id/pins', authMiddleware, requirePublicChannelReadAccess, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = req.channelId!;

    const pins = await prisma.message.findMany({
      where: { channelId, isPinned: true, deletedAt: null },
      include: MESSAGE_INCLUDE_FULL,
      orderBy: { pinnedAt: 'desc' },
    });

    res.json(pins);
  } catch (error) {
    logError('Get pinned messages error', error);
    res.status(500).json({ error: 'Failed to get pinned messages' });
  }
});

export default router;
