import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { JwtPayload } from '../types.js';
import { JWT_SECRET } from '../config.js';
import { isSessionAlive } from '../services/sessionService.js';
import { validateAccessToken, AccessTokenResult } from '../middleware/auth.js';
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
import { logError } from '../utils/logger.js';
import { registerHuddleHandlers, handleHuddleDisconnect } from './huddles.js';
import { ServiceError, sendChannelMessage, editChannelMessage, deleteChannelMessage } from '../services/messageService.js';
import { KeyedQueue } from '../utils/keyedQueue.js';
import { sendGroupMessage, emitToGroup, InvalidFileIdsError } from '../services/dmGroupService.js';
import { useSecureTransport } from '../runtimeConfig.js';
import { sendDirectMessage } from '../services/dmService.js';

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
export async function getSharedUsers(userId: number): Promise<number[]> {
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
      secure: process.env.NODE_ENV === 'production' && useSecureTransport(process.env),
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

    // HTTP 미들웨어와 같은 검증을 쓴다. 토큰 문제는 'Invalid token', 서버 오류는 기록 후 'Server error'로 거부한다.
    let result: AccessTokenResult;
    try {
      result = await validateAccessToken(token);
    } catch (error) {
      logError('Socket auth error', error);
      return next(new Error('Server error'));
    }
    if (!result.ok) {
      return next(new Error('Invalid token'));
    }

    socket.user = result.user;
    next();
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

    // 세션(E7): 폐기, 최대 수명, 유휴 만료를 한 번에 조회해 확인한다. 소켓 연결 자체는 활동으로 치지 않는다.
    const sids = [...new Set(
      [...io.sockets.sockets.values()]
        .map(s => (s as AuthenticatedSocket).user?.sid)
        .filter((sid): sid is string => typeof sid === 'string')
    )];
    const sessions = sids.length > 0
      ? await prisma.session.findMany({
          where: { id: { in: sids } },
          select: { id: true, userId: true, lastSeenAt: true, expiresAt: true, revokedAt: true },
        })
      : [];
    const sessionMap = new Map(sessions.map(s => [s.id, s]));

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
          const sid = authSocket.user?.sid;
          if (sid) {
            const session = sessionMap.get(sid);
            if (!session || session.userId !== decoded.userId || !isSessionAlive(session)) {
              authSocket.emit('error', { message: 'Session revoked' });
              authSocket.disconnect(true);
              continue;
            }
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

        // 보관 채널·스레드 검사, 저장, 활동·푸시는 REST·MCP와 같은 서비스가 처리한다.
        // message:new는 방 참여와 관계없이 보낸 사람에게 먼저 보내고, 나머지는 방 전체에 보낸다.
        await sendChannelMessage(socket.user.userId, data.channelId, data, {
          broadcast: (message) => {
            socket.emit('message:new', message);
            socket.to(`channel:${data.channelId}`).emit('message:new', message);
          },
        });

        // Ack success to the sender
        if (typeof ack === 'function') ack({});
      } catch (error) {
        if (error instanceof ServiceError) {
          sendError(error.message);
          return;
        }
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

        await editChannelMessage(socket.user.userId, message, data.content);
      } catch (error) {
        if (error instanceof ServiceError) {
          socket.emit('error', { message: error.message });
          return;
        }
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

        await deleteChannelMessage(socket.user.userId, message);
      } catch (error) {
        if (error instanceof ServiceError) {
          socket.emit('error', { message: error.message });
          return;
        }
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

        // 받는 사람 확인, 게스트 격리, 전송, 소켓, 푸시, 활동 생성은 REST·MCP와 같은 dmService가 한다
        await sendDirectMessage(
          { userId: socket.user.userId, role: socket.user.role },
          data.toUserId,
          { content: data.content },
        );
      } catch (error) {
        if (error instanceof ServiceError) {
          socket.emit('error', { message: error.message });
          return;
        }
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
/** 폐기된 세션(sid)의 소켓 연결만 끊는다. 같은 사용자의 다른 기기 연결은 그대로 둔다. */
export function kickSession(userId: number, sid: string): void {
  const io = getIO();
  if (!io) return;
  const userSockets = onlineUsers.get(userId);
  if (!userSockets) return;
  for (const socketId of [...userSockets]) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket && (socket as AuthenticatedSocket).user?.sid === sid) {
      socket.emit('error', { message: 'Session revoked' });
      socket.disconnect(true);
    }
  }
}

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

