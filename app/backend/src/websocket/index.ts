import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { JwtPayload } from '../types.js';
import { JWT_SECRET } from '../config.js';
import {
  checkChannelMembership,
  checkDmGroupMembership,
  wsDmGroupSendSchema,
  wsDmGroupIdSchema,
  wsMessageSendSchema,
  wsMessageEditSchema,
  wsMessageDeleteSchema,
  wsDmSendSchema,
  wsChannelIdSchema,
  wsUserIdSchema,
} from '../middleware/authorize.js';
// Huddle schemas imported by huddles.ts directly
import { USER_SELECT_BASIC, MESSAGE_INCLUDE_WITH_FILES, MESSAGE_INCLUDE_FULL, DM_INCLUDE_USERS } from '../db/selects.js';
import { logError } from '../utils/logger.js';
import { registerHuddleHandlers, handleHuddleDisconnect } from './huddles.js';
import { sendPushToUser } from '../services/pushService.js';
import { PARENT_EXCERPT_INCLUDE, withParentExcerpt, onThreadReplyCreated, onThreadReplyDeleted } from '../services/threadService.js';
import { KeyedQueue } from '../utils/keyedQueue.js';
import {
  processNewChannelMessage,
  syncActivitiesOnEdit,
  deleteActivitiesForMessage,
  createActivitiesForDm,
} from '../services/mentionService.js';
import { sendGroupMessage, emitToGroup, InvalidFileIdsError } from '../services/dmGroupService.js';

interface AuthenticatedSocket extends Socket {
  user?: JwtPayload;
}

// Track online users: Map<userId, Set<socketId>>
const onlineUsers = new Map<number, Set<string>>();

// Track what each user is currently viewing (for smart push notifications)
interface FocusedView {
  type: 'channel' | 'dm';
  id: number; // channelId or otherUserId
}
const userFocusedView = new Map<number, FocusedView | null>();

// 사용자별 status 쓰기(연결 시 online, 끊길 때 offline, PUT /users/me/status)를 들어온 순서대로 실행한다.
// 연결 핸들러는 기다리지 않으므로 순서가 뒤집히지 않게 하고, 테스트는 settleBackgroundWork로 기다린다.
export const presenceQueue = new KeyedQueue<number>();

export function isUserViewingChannel(userId: number, channelId: number): boolean {
  const view = userFocusedView.get(userId);
  return view?.type === 'channel' && view.id === channelId;
}

export function isUserViewingDM(userId: number, otherUserId: number): boolean {
  const view = userFocusedView.get(userId);
  return view?.type === 'dm' && view.id === otherUserId;
}

// Per-user rate limiting (keyed on userId, not socketId, to prevent bypass via reconnect)
const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  'message:send': { max: 30, windowMs: 60_000 },
  'dm:send': { max: 30, windowMs: 60_000 },
  'message:edit': { max: 20, windowMs: 60_000 },
  'message:delete': { max: 20, windowMs: 60_000 },
  'typing:start': { max: 60, windowMs: 60_000 },
  'typing:stop': { max: 60, windowMs: 60_000 },
  'dm:typing:start': { max: 60, windowMs: 60_000 },
  'dm:typing:stop': { max: 60, windowMs: 60_000 },
  'dmgroup:send': { max: 30, windowMs: 60_000 },
  'dmgroup:typing:start': { max: 60, windowMs: 60_000 },
  'dmgroup:typing:stop': { max: 60, windowMs: 60_000 },
  'join:channel': { max: 20, windowMs: 60_000 },
  'dm:join': { max: 20, windowMs: 60_000 },
  'huddle:invite': { max: 10, windowMs: 60_000 },
  'huddle:invite:accept': { max: 10, windowMs: 60_000 },
  'huddle:invite:decline': { max: 10, windowMs: 60_000 },
  'huddle:invite:cancel': { max: 10, windowMs: 60_000 },
  'huddle:leave': { max: 10, windowMs: 60_000 },
  'huddle:mute': { max: 30, windowMs: 60_000 },
  'huddle:signal': { max: 200, windowMs: 60_000 },
};

const rateLimitState = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: number, event: string): boolean {
  const config = RATE_LIMITS[event];
  if (!config) return true;

  const key = `${userId}:${event}`;
  const now = Date.now();
  const entry = rateLimitState.get(key);

  if (!entry || now >= entry.resetAt) {
    rateLimitState.set(key, { count: 1, resetAt: now + config.windowMs });
    return true;
  }

  if (entry.count >= config.max) return false;
  entry.count++;
  return true;
}

// Periodic cleanup of expired rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitState) {
    if (now >= entry.resetAt) rateLimitState.delete(key);
  }
}, 5 * 60 * 1000).unref();

// Get users who share channels or DMs with the given user (single query)
async function getSharedUsers(userId: number): Promise<number[]> {
  const rows = await prisma.$queryRaw<Array<{ userId: number }>>`
    SELECT DISTINCT "userId" FROM (
      SELECT cm2."userId"
      FROM "ChannelMember" cm1
      JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId" AND cm2."userId" != cm1."userId"
      WHERE cm1."userId" = ${userId}
      UNION
      SELECT CASE WHEN "fromUserId" = ${userId} THEN "toUserId" ELSE "fromUserId" END AS "userId"
      FROM "DirectMessage"
      WHERE ("fromUserId" = ${userId} OR "toUserId" = ${userId})
        AND "groupId" IS NULL
        AND "deletedAt" IS NULL
      UNION
      SELECT gm2."userId"
      FROM "DMGroupMember" gm1
      JOIN "DMGroupMember" gm2 ON gm2."groupId" = gm1."groupId" AND gm2."userId" != gm1."userId"
      WHERE gm1."userId" = ${userId}
    ) shared
  `;
  return rows.map((r) => r.userId);
}

export function initializeWebSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : 'http://localhost:5173'),
      methods: ['GET', 'POST'],
    },
    cookie: {
      name: 'io',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
    },
    maxHttpBufferSize: 16384,
    pingTimeout: 20000,
    pingInterval: 25000,
  });

  // Store module-level reference so REST routes can broadcast events
  ioInstance = io;

  // Authentication middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
      return next(new Error('Authentication required'));
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload & { purpose?: string; tokenVersion?: number };
      // Reject scoped tokens (e.g. file-download) from being used as WS auth
      if (decoded.purpose) {
        return next(new Error('Invalid token'));
      }

      // Reject tokens missing tokenVersion — matches HTTP auth middleware.
      // Without this, revocation via password change / deactivation is bypassed.
      if (decoded.tokenVersion === undefined) {
        return next(new Error('Invalid token'));
      }

      // Verify tokenVersion against DB to reject revoked/outdated tokens
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { tokenVersion: true, role: true, deactivatedAt: true },
      });
      if (!user || user.deactivatedAt) {
        return next(new Error('Invalid token'));
      }
      if (user.tokenVersion !== decoded.tokenVersion) {
        return next(new Error('Invalid token'));
      }

      socket.user = { ...decoded, role: user.role };
      next();
    } catch (error) {
      next(new Error('Invalid token'));
    }
  });

  // Periodic token revalidation: disconnect sockets whose JWT has expired or been revoked
  const TOKEN_REVALIDATION_INTERVAL = 5 * 60 * 1000; // 5 minutes
  setInterval(async () => {
    // Batch-fetch tokenVersions for all connected users
    const connectedUserIds = [...new Set(
      [...io.sockets.sockets.values()]
        .map(s => (s as AuthenticatedSocket).user?.userId)
        .filter((id): id is number => id !== undefined)
    )];
    const users = connectedUserIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: connectedUserIds } },
          select: { id: true, tokenVersion: true, role: true, deactivatedAt: true },
        })
      : [];
    const userMap = new Map(users.map(u => [u.id, u]));

    for (const [, socket] of io.sockets.sockets) {
      const authSocket = socket as AuthenticatedSocket;
      const token = authSocket.handshake?.auth?.token;
      if (!token) continue;
      try {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload & { tokenVersion?: number };
        if (decoded.userId) {
          const dbUser = userMap.get(decoded.userId);
          // Disconnect if user was deleted or deactivated
          if (!dbUser || dbUser.deactivatedAt) {
            authSocket.emit('error', { message: 'Session revoked' });
            authSocket.disconnect(true);
            continue;
          }
          // Check tokenVersion mismatch (password change, admin action)
          // Also disconnect tokens missing tokenVersion entirely — matches
          // the initial auth check and the HTTP auth middleware.
          if (decoded.tokenVersion === undefined || dbUser.tokenVersion !== decoded.tokenVersion) {
            authSocket.emit('error', { message: 'Session revoked' });
            authSocket.disconnect(true);
            continue;
          }
          // Refresh role on socket to reflect admin role changes
          if (authSocket.user && authSocket.user.role !== dbUser.role) {
            authSocket.user = { ...authSocket.user, role: dbUser.role };
          }
        }
      } catch {
        authSocket.emit('error', { message: 'Session expired' });
        authSocket.disconnect(true);
      }
    }
  }, TOKEN_REVALIDATION_INTERVAL).unref();

  io.on('connection', async (socket: AuthenticatedSocket) => {
    console.log(`User ${socket.user?.userId} connected`);

    // Per-socket cache for channel membership (only cache positive results)
    const membershipCache = new Map<number, { result: boolean; expires: number }>();
    const MEMBERSHIP_CACHE_TTL = 30_000; // 30 seconds

    async function cachedCheckMembership(userId: number, channelId: number): Promise<boolean> {
      const cached = membershipCache.get(channelId);
      if (cached && Date.now() < cached.expires) return cached.result;
      const result = await checkChannelMembership(userId, channelId);
      // Only cache positive (truthy) results to avoid unbounded growth from negative lookups
      if (result) {
        membershipCache.set(channelId, { result, expires: Date.now() + MEMBERSHIP_CACHE_TTL });
      }
      return result;
    }

    // Track user presence
    // 여기서 await하면 그동안 들어온 이벤트(연결 직후 보낸 message:send, 곧바로 끊긴 disconnect)는
    // 아래 리스너가 아직 없어 버려진다. 리스너를 먼저 달고, 온라인 기록은 기다리지 않는다.
    if (socket.user) {
      const userId = socket.user.userId;

      // Add socket to user's connections
      if (!onlineUsers.has(userId)) {
        onlineUsers.set(userId, new Set());
      }
      onlineUsers.get(userId)!.add(socket.id);

      // If this is the first connection, mark user online and broadcast
      if (onlineUsers.get(userId)!.size === 1) {
        presenceQueue.fire(userId, async () => {
          // 사용자가 고른 상태(away, busy)는 덮지 않는다. 끊길 때 남긴 offline(또는 빈 값)만 online으로 바꾼다.
          await prisma.user.updateMany({
            where: { id: userId, OR: [{ status: 'offline' }, { status: null }] },
            data: { status: 'online' },
          });

          // Broadcast presence to shared users
          const sharedUsers = await getSharedUsers(userId);
          for (const sharedUserId of sharedUsers) {
            io.to(`user:${sharedUserId}`).emit('presence:update', {
              userId,
              status: 'online',
            });
          }
        }, 'Failed to update user presence');
      }
    }

    // Join channel room
    socket.on('join:channel', async (rawChannelId: unknown, ack?: (ok: boolean) => void) => {
      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'join:channel')) {
        if (typeof ack === 'function') ack(false);
        return;
      }

      const parsed = wsChannelIdSchema.safeParse(rawChannelId);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid channel ID' });
        if (typeof ack === 'function') ack(false);
        return;
      }
      const channelId = parsed.data;

      const isMember = await checkChannelMembership(socket.user.userId, channelId);
      if (!isMember) {
        socket.emit('error', { message: 'You must join the channel first' });
        if (typeof ack === 'function') ack(false);
        return;
      }

      socket.join(`channel:${channelId}`);
      console.log(`User ${socket.user.userId} joined channel ${channelId}`);
      if (typeof ack === 'function') ack(true);
    });

    // Leave channel room
    socket.on('leave:channel', (rawChannelId: unknown) => {
      const parsed = wsChannelIdSchema.safeParse(rawChannelId);
      if (!parsed.success) return;
      socket.leave(`channel:${parsed.data}`);
      console.log(`User ${socket.user?.userId} left channel ${parsed.data}`);
    });

    // Send message
    socket.on('message:send', async (rawData: unknown, ack?: (response: { error?: string }) => void) => {
      const sendError = (message: string) => {
        if (typeof ack === 'function') ack({ error: message });
        else socket.emit('error', { message });
      };

      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'message:send')) {
        sendError('Rate limit exceeded');
        return;
      }

      try {
        const parsed = wsMessageSendSchema.safeParse(rawData);
        if (!parsed.success) {
          const firstIssue = parsed.error.issues[0];
          sendError(firstIssue?.message || 'Invalid message payload');
          return;
        }
        const data = parsed.data;

        // Verify user is a member of the channel
        const isMember = await checkChannelMembership(socket.user.userId, data.channelId);
        if (!isMember) {
          sendError('You must join the channel to send messages');
          return;
        }

        // Block messaging in archived channels
        const channel = await prisma.channel.findUnique({
          where: { id: data.channelId },
          select: { archivedAt: true },
        });
        if (channel?.archivedAt) {
          sendError('This channel has been archived');
          return;
        }

        // Validate threadId belongs to the same channel and is not deleted
        if (data.threadId) {
          const parentMessage = await prisma.message.findUnique({
            where: { id: data.threadId },
          });
          if (!parentMessage || parentMessage.deletedAt || parentMessage.channelId !== data.channelId) {
            sendError('Thread parent must belong to the same channel');
            return;
          }
        }

        // Create message and atomically attach files in a transaction
        const finalMessage = await prisma.$transaction(async (tx) => {
          const msg = await tx.message.create({
            data: {
              content: data.content,
              userId: socket.user!.userId,
              channelId: data.channelId,
              threadId: data.threadId,
              alsoSendToChannel: !!data.threadId && !!data.alsoSendToChannel,
            },
          });

          // Attach files atomically — validates ownership and unattached status
          if (data.fileIds && data.fileIds.length > 0) {
            const updated = await tx.file.updateMany({
              where: { id: { in: data.fileIds }, userId: socket.user!.userId, messageId: null, dmId: null },
              data: { messageId: msg.id },
            });
            if (updated.count !== data.fileIds.length) {
              throw new Error('Invalid file IDs or files already attached');
            }
          }

          return tx.message.findUnique({
            where: { id: msg.id },
            include: { ...MESSAGE_INCLUDE_FULL, ...PARENT_EXCERPT_INCLUDE },
          });
        }).then((m) => (m ? withParentExcerpt(m) : m));

        // Always emit to the sender so they see their own message immediately,
        // even if their socket hasn't joined the channel room yet.
        socket.emit('message:new', finalMessage);
        // Broadcast to all OTHER users in the channel room
        socket.to(`channel:${data.channelId}`).emit('message:new', finalMessage);

        // Ack success to the sender
        if (typeof ack === 'function') ack({});

        // ack 뒤에: 활동 생성, 활동 이벤트, 푸시 (HTTP 경로와 같은 서비스, await하지 않는다)
        if (finalMessage) {
          void processNewChannelMessage(finalMessage, { generalPush: true });
          void onThreadReplyCreated(finalMessage);
        }
      } catch (error) {
        logError('WebSocket message error', error);
        sendError('Failed to send message');
      }
    });

    // Edit message
    socket.on('message:edit', async (rawData: unknown) => {
      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'message:edit')) {
        socket.emit('error', { message: 'Rate limit exceeded' });
        return;
      }

      try {
        const parsed = wsMessageEditSchema.safeParse(rawData);
        if (!parsed.success) {
          socket.emit('error', { message: 'Invalid edit payload' });
          return;
        }
        const data = parsed.data;

        const message = await prisma.message.findUnique({
          where: { id: data.messageId },
        });

        if (!message || message.deletedAt) {
          socket.emit('error', { message: 'Message not found' });
          return;
        }

        const isMember = await checkChannelMembership(socket.user.userId, message.channelId);
        if (!isMember) {
          socket.emit('error', { message: 'You must be a member of this channel' });
          return;
        }

        if (message.userId !== socket.user.userId) {
          socket.emit('error', { message: 'You can only edit your own messages' });
          return;
        }

        // Block edits in archived channels
        const editChannel = await prisma.channel.findUnique({
          where: { id: message.channelId },
          select: { archivedAt: true },
        });
        if (editChannel?.archivedAt) {
          socket.emit('error', { message: 'This channel has been archived' });
          return;
        }

        const updatedMessage = await prisma.message.update({
          where: { id: data.messageId },
          data: { content: data.content, editedAt: new Date() },
          include: { user: { select: USER_SELECT_BASIC } },
        });

        io.to(`channel:${message.channelId}`).emit('message:updated', updatedMessage);
        void syncActivitiesOnEdit(updatedMessage);
      } catch (error) {
        logError('WebSocket edit message error', error);
        socket.emit('error', { message: 'Failed to edit message' });
      }
    });

    // Delete message
    socket.on('message:delete', async (rawData: unknown) => {
      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'message:delete')) {
        socket.emit('error', { message: 'Rate limit exceeded' });
        return;
      }

      try {
        const parsed = wsMessageDeleteSchema.safeParse(rawData);
        if (!parsed.success) {
          socket.emit('error', { message: 'Invalid delete payload' });
          return;
        }
        const data = parsed.data;

        const message = await prisma.message.findUnique({
          where: { id: data.messageId },
        });

        if (!message || message.deletedAt) {
          socket.emit('error', { message: 'Message not found' });
          return;
        }

        const isMember = await checkChannelMembership(socket.user.userId, message.channelId);
        if (!isMember) {
          socket.emit('error', { message: 'You must be a member of this channel' });
          return;
        }

        if (message.userId !== socket.user.userId) {
          socket.emit('error', { message: 'You can only delete your own messages' });
          return;
        }

        // Block deletes in archived channels
        const delChannel = await prisma.channel.findUnique({
          where: { id: message.channelId },
          select: { archivedAt: true },
        });
        if (delChannel?.archivedAt) {
          socket.emit('error', { message: 'This channel has been archived' });
          return;
        }

        // Soft-delete message and detach its files so they don't become orphaned
        await prisma.$transaction([
          prisma.message.update({
            where: { id: data.messageId },
            data: { deletedAt: new Date() },
          }),
          prisma.file.updateMany({
            where: { messageId: data.messageId },
            data: { messageId: null },
          }),
        ]);

        void deleteActivitiesForMessage(data.messageId);
        void onThreadReplyDeleted(message);

        io.to(`channel:${message.channelId}`).emit('message:deleted', {
          messageId: data.messageId,
          threadId: message.threadId ?? null,
          channelId: message.channelId,
        });
      } catch (error) {
        logError('WebSocket delete message error', error);
        socket.emit('error', { message: 'Failed to delete message' });
      }
    });

    // Typing indicator (uses cached membership to avoid DB query per keystroke)
    socket.on('typing:start', async (rawChannelId: unknown) => {
      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'typing:start')) return;

      const parsed = wsChannelIdSchema.safeParse(rawChannelId);
      if (!parsed.success) return;
      const channelId = parsed.data;

      const isMember = await cachedCheckMembership(socket.user.userId, channelId);
      if (!isMember) return;

      socket.to(`channel:${channelId}`).emit('typing:start', {
        userId: socket.user.userId,
      });
    });

    socket.on('typing:stop', async (rawChannelId: unknown) => {
      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'typing:stop')) return;

      const parsed = wsChannelIdSchema.safeParse(rawChannelId);
      if (!parsed.success) return;
      const channelId = parsed.data;

      const isMember = await cachedCheckMembership(socket.user.userId, channelId);
      if (!isMember) return;

      socket.to(`channel:${channelId}`).emit('typing:stop', {
        userId: socket.user.userId,
      });
    });

    // Join user's personal room for DMs
    if (socket.user) {
      socket.join(`user:${socket.user.userId}`);
    }

    // Join DM conversation room
    socket.on('dm:join', async (rawOtherUserId: unknown) => {
      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'dm:join')) {
        socket.emit('error', { message: 'Rate limit exceeded' });
        return;
      }

      const parsed = wsUserIdSchema.safeParse(rawOtherUserId);
      if (!parsed.success) {
        socket.emit('error', { message: 'Invalid user ID' });
        return;
      }
      const otherUserId = parsed.data;

      // Verify both users have exchanged DMs before allowing room join
      const hasDmHistory = await prisma.directMessage.findFirst({
        where: {
          OR: [
            { fromUserId: socket.user.userId, toUserId: otherUserId },
            { fromUserId: otherUserId, toUserId: socket.user.userId },
          ],
        },
      });

      if (!hasDmHistory) {
        // Allow joining if the other user exists (first DM scenario)
        const otherUser = await prisma.user.findUnique({ where: { id: otherUserId } });
        if (!otherUser) {
          socket.emit('error', { message: 'User not found' });
          return;
        }
      }

      // Create a consistent room name regardless of who initiates
      const roomId = [socket.user.userId, otherUserId].sort().join('-');
      socket.join(`dm:${roomId}`);
      console.log(`User ${socket.user.userId} joined DM room ${roomId}`);
    });

    // Leave DM conversation room
    socket.on('dm:leave', (rawOtherUserId: unknown) => {
      if (!socket.user) return;

      const parsed = wsUserIdSchema.safeParse(rawOtherUserId);
      if (!parsed.success) return;
      const otherUserId = parsed.data;

      const roomId = [socket.user.userId, otherUserId].sort().join('-');
      socket.leave(`dm:${roomId}`);
      console.log(`User ${socket.user?.userId} left DM room ${roomId}`);
    });

    // Send DM via WebSocket
    socket.on('dm:send', async (rawData: unknown) => {
      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'dm:send')) {
        socket.emit('error', { message: 'Rate limit exceeded' });
        return;
      }

      try {
        const parsed = wsDmSendSchema.safeParse(rawData);
        if (!parsed.success) {
          socket.emit('error', { message: 'Invalid DM payload' });
          return;
        }
        const data = parsed.data;

        const isSelfDM = socket.user.userId === data.toUserId;

        // Check if recipient exists and is active (self-DM is allowed)
        if (!isSelfDM) {
          const recipient = await prisma.user.findUnique({
            where: { id: data.toUserId },
            select: { id: true, deactivatedAt: true },
          });

          if (!recipient || recipient.deactivatedAt) {
            socket.emit('error', { message: 'Unable to send message' });
            return;
          }

          // Guests can only DM users who share a channel with them
          if (socket.user!.role === 'GUEST') {
            const sharedChannel = await prisma.$queryRaw<Array<{ id: number }>>`
              SELECT cm1."channelId" AS id
              FROM "ChannelMember" cm1
              JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId"
              WHERE cm1."userId" = ${socket.user!.userId} AND cm2."userId" = ${data.toUserId}
              LIMIT 1
            `;
            if (sharedChannel.length === 0) {
              socket.emit('error', { message: 'Unable to send message' });
              return;
            }
          }
        }

        const dm = await prisma.directMessage.create({
          data: {
            content: data.content,
            fromUserId: socket.user.userId,
            toUserId: data.toUserId,
            // Self-DMs are auto-read (no notifications)
            ...(isSelfDM && { readAt: new Date() }),
          },
          include: DM_INCLUDE_USERS,
        });

        // Emit to both users' personal rooms (avoid duplicate for self-DM)
        io.to(`user:${socket.user.userId}`).emit('dm:new', dm);
        if (!isSelfDM) {
          io.to(`user:${data.toUserId}`).emit('dm:new', dm);

          // Fire push notification for DM (fire-and-forget)
          if (!isUserOnline(data.toUserId)) {
            const senderName = dm.fromUser?.name || 'Someone';
            sendPushToUser(data.toUserId, {
              title: senderName,
              body: dm.content.slice(0, 100) || 'Sent an attachment',
              url: `/d/${socket.user.userId}`,
            }).catch((err) => logError('Push notification dispatch failed', err));
          }
        }

        // dm:new 뒤에 활동 생성(await하지 않는다)
        void createActivitiesForDm(dm);
      } catch (error) {
        logError('WebSocket DM error', error);
        socket.emit('error', { message: 'Failed to send DM' });
      }
    });

    // DM typing indicator — verify DM conversation exists before emitting
    socket.on('dm:typing:start', async (rawToUserId: unknown) => {
      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'dm:typing:start')) return;

      const parsed = wsUserIdSchema.safeParse(rawToUserId);
      if (!parsed.success) return;
      const toUserId = parsed.data;

      // Verify DM conversation exists between users
      const hasDm = await prisma.directMessage.findFirst({
        where: {
          OR: [
            { fromUserId: socket.user.userId, toUserId },
            { fromUserId: toUserId, toUserId: socket.user.userId },
          ],
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!hasDm) return;

      io.to(`user:${toUserId}`).emit('dm:typing:start', {
        userId: socket.user.userId,
      });
    });

    socket.on('dm:typing:stop', async (rawToUserId: unknown) => {
      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'dm:typing:stop')) return;

      const parsed = wsUserIdSchema.safeParse(rawToUserId);
      if (!parsed.success) return;
      const toUserId = parsed.data;

      // Verify DM conversation exists between users
      const hasDm = await prisma.directMessage.findFirst({
        where: {
          OR: [
            { fromUserId: socket.user.userId, toUserId },
            { fromUserId: toUserId, toUserId: socket.user.userId },
          ],
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!hasDm) return;

      io.to(`user:${toUserId}`).emit('dm:typing:stop', {
        userId: socket.user.userId,
      });
    });

    // 그룹 DM 전송. HTTP POST /dms/groups/:id/messages와 같은 서비스를 쓴다. ack가 있으면 결과를 ack로 돌려준다.
    socket.on('dmgroup:send', async (rawData: unknown, ack?: (response: { error?: string; code?: string; id?: number }) => void) => {
      const sendError = (message: string, code?: string) => {
        if (typeof ack === 'function') ack({ error: message, ...(code && { code }) });
        else socket.emit('error', { message });
      };

      if (!socket.user) return;
      if (!checkRateLimit(socket.user.userId, 'dmgroup:send')) {
        sendError('Rate limit exceeded');
        return;
      }

      try {
        const parsed = wsDmGroupSendSchema.safeParse(rawData);
        if (!parsed.success) {
          sendError('Invalid DM payload');
          return;
        }
        const { groupId, content, fileIds } = parsed.data;
        if (!(await checkDmGroupMembership(socket.user.userId, groupId))) {
          sendError('Unable to send message');
          return;
        }

        const dm = await sendGroupMessage({ groupId, fromUserId: socket.user.userId, content, fileIds });
        if (typeof ack === 'function') ack({ id: dm.id });
        void createActivitiesForDm(dm);
      } catch (error) {
        if (error instanceof InvalidFileIdsError) {
          sendError(error.message, error.code);
          return;
        }
        logError('WebSocket group DM error', error);
        sendError('Failed to send DM');
      }
    });

    // 그룹 DM 입력 중 표시: 멤버인지 확인한 뒤 나를 뺀 멤버에게 보낸다
    for (const event of ['dmgroup:typing:start', 'dmgroup:typing:stop'] as const) {
      socket.on(event, async (rawGroupId: unknown) => {
        if (!socket.user) return;
        if (!checkRateLimit(socket.user.userId, event)) return;

        const parsed = wsDmGroupIdSchema.safeParse(rawGroupId);
        if (!parsed.success) return;
        const groupId = parsed.data;
        const userId = socket.user.userId;
        try {
          if (!(await checkDmGroupMembership(userId, groupId))) return;
          await emitToGroup(groupId, event, { groupId, userId }, userId);
        } catch (error) {
          logError('WebSocket group typing error', error);
        }
      });
    }

    // Focus tracking for smart push notifications
    socket.on('focus:channel', (channelId: unknown) => {
      if (!socket.user) return;
      const parsed = wsChannelIdSchema.safeParse(channelId);
      if (!parsed.success) return;
      userFocusedView.set(socket.user.userId, { type: 'channel', id: parsed.data });
    });

    socket.on('focus:dm', (otherUserId: unknown) => {
      if (!socket.user) return;
      const parsed = wsUserIdSchema.safeParse(otherUserId);
      if (!parsed.success) return;
      userFocusedView.set(socket.user.userId, { type: 'dm', id: parsed.data });
    });

    socket.on('focus:none', () => {
      if (!socket.user) return;
      userFocusedView.set(socket.user.userId, null);
    });

    // Register huddle handlers
    registerHuddleHandlers(io, socket as AuthenticatedSocket, onlineUsers, checkRateLimit);

    socket.on('disconnect', async () => {
      console.log(`User ${socket.user?.userId} disconnected`);
      handleHuddleDisconnect(socket as AuthenticatedSocket, io, onlineUsers);

      if (socket.user) {
        const userId = socket.user.userId;

        // Remove socket from user's connections (always, before any async work)
        const userSockets = onlineUsers.get(userId);
        if (userSockets) {
          userSockets.delete(socket.id);

          // If no more connections, mark user offline and clear focus
          if (userSockets.size === 0) {
            onlineUsers.delete(userId);
            userFocusedView.delete(userId);

            // 온라인 기록이 아직 진행 중이면 그 뒤에 쓴다(오프라인이 온라인에 덮이지 않게)
            presenceQueue.fire(userId, async () => {
              await prisma.user.update({
                where: { id: userId },
                data: {
                  status: 'offline',
                  lastSeen: new Date(),
                },
              });

              // Broadcast presence to shared users
              const sharedUsers = await getSharedUsers(userId);
              for (const sharedUserId of sharedUsers) {
                io.to(`user:${sharedUserId}`).emit('presence:update', {
                  userId,
                  status: 'offline',
                  lastSeen: new Date(),
                });
              }
            }, 'Failed to update user presence on disconnect');
          }
        }
      }
    });
  });

  return io;
}

// Module-level io reference so REST routes can emit events
let ioInstance: Server | null = null;

export function getIO(): Server | null {
  return ioInstance;
}

// Export for use in REST endpoints
export function isUserOnline(userId: number): boolean {
  return onlineUsers.has(userId) && onlineUsers.get(userId)!.size > 0;
}

// Forcibly disconnect all sockets for a user (used by admin deactivation)
export function kickUser(userId: number): void {
  const io = getIO();
  if (!io) return;
  const userSockets = onlineUsers.get(userId);
  if (!userSockets) return;
  for (const socketId of userSockets) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('error', { message: 'Account deactivated' });
      socket.disconnect(true);
    }
  }
}

