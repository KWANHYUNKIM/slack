import { Router, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import sharp from 'sharp';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { guestVisibleUserIds } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { displayNameSchema, stripHtml } from '../utils/authSchemas.js';
import { isUserOnline, presenceQueue } from '../websocket/index.js';
import {
  STATUS_SELECT, MAX_STATUS_TEXT, MIN_FUTURE_MS, MAX_FUTURE_MS,
  cleanStatusText, isSingleEmoji, statusView, toPublicUser, setCustomStatus, clearCustomStatus, setDnd, endDnd,
  computeDnd,
} from '../services/statusService.js';

// Avatar upload setup
const uploadDir = path.join(process.cwd(), 'uploads', 'avatars');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, crypto.randomUUID() + ext);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
});

const router = Router();

// stripHtml: defense-in-depth (React escapes output, but sanitize at API layer)
const updateProfileSchema = z.object({
  name: displayNameSchema.optional(),
  avatar: z.string().max(500).refine(
    // 규칙 17: 외부 URL(http, https, //host)은 받지 않는다. 업로드 API가 돌려주는 자기 출처 경로만 허용한다.
    (url) => /^\/users\/me\/avatar\/[A-Za-z0-9._-]+$/.test(url),
    { message: 'Avatar must be a local avatar path' }
  ).optional().nullable(),
  status: z.enum(['online', 'away', 'busy', 'offline']).optional(),
  bio: z.string().max(500)
    .refine(val => !val.includes('\u0000'), { message: 'Bio cannot contain null bytes' })
    .transform(stripHtml)
    .optional().nullable(),
});

// GET /users/me - Get current user profile
router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        role: true,
        status: true,
        bio: true,
        createdAt: true,
        updatedAt: true,
        ...STATUS_SELECT,
        _count: {
          select: {
            messages: true,
            channels: true,
          },
        },
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Enrich with real-time WebSocket presence
    const online = isUserOnline(userId);
    res.json({
      ...toPublicUser(user, { self: true }),
      status: online ? 'online' : (user.status || 'offline'),
      isOnline: online,
    });
  } catch (error) {
    logError('Get profile error', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// 사이드바 섹션 접기 상태. 키는 고정 목록만 받는다(임의 JSON 저장 방지).
const sidebarSchema = z.object({
  collapsed: z.object({
    starred: z.boolean().optional(),
    channels: z.boolean().optional(),
    dms: z.boolean().optional(),
  }).strict(),
});

function normalizeCollapsed(raw: unknown) {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    starred: obj.starred === true,
    channels: obj.channels === true,
    dms: obj.dms === true,
  };
}

// GET /users/me/sidebar - 섹션 접기 상태 조회
router.get('/me/sidebar', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const pref = await prisma.sidebarPref.findUnique({ where: { userId: req.user!.userId } });
    res.json({ collapsed: normalizeCollapsed(pref?.collapsed) });
  } catch (error) {
    logError('Get sidebar pref error', error);
    res.status(500).json({ error: 'Failed to get sidebar preferences' });
  }
});

// PATCH /users/me/sidebar - 섹션 접기 상태 저장 (보낸 키만 병합)
router.patch('/me/sidebar', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = sidebarSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
      return;
    }
    const userId = req.user!.userId;
    // 보낸 키만 한 번의 UPDATE로 병합한다(읽고 쓰기 사이에 다른 요청의 키가 덮이지 않게). 값은 파라미터로 바인딩한다.
    const patchJson = JSON.stringify(parsed.data.collapsed);
    const rows = await prisma.$queryRaw<Array<{ collapsed: unknown }>>`
      INSERT INTO "SidebarPref" ("userId", "collapsed", "updatedAt")
      VALUES (${userId}, ${patchJson}::jsonb, NOW())
      ON CONFLICT ("userId") DO UPDATE
        SET "collapsed" = "SidebarPref"."collapsed" || EXCLUDED."collapsed", "updatedAt" = NOW()
      RETURNING "collapsed"
    `;
    res.json({ collapsed: normalizeCollapsed(rows[0]?.collapsed) });
  } catch (error) {
    logError('Update sidebar pref error', error);
    res.status(500).json({ error: 'Failed to update sidebar preferences' });
  }
});

// ---- 커스텀 상태와 방해금지(05). '/:id'보다 먼저 등록한다. ----

function futureDate(label: string) {
  return z.string().datetime({ offset: true }).transform((v) => new Date(v)).superRefine((d, ctx) => {
    const delta = d.getTime() - Date.now();
    if (delta < MIN_FUTURE_MS) ctx.addIssue({ code: 'custom', message: `${label} must be at least 1 minute in the future` });
    else if (delta > MAX_FUTURE_MS) ctx.addIssue({ code: 'custom', message: `${label} must be within 7 days` });
  });
}

const customStatusSchema = z.object({
  emoji: z.string().max(50).refine(isSingleEmoji, { message: 'Emoji must be a single emoji' }).nullish(),
  text: z.string().max(MAX_STATUS_TEXT).transform(cleanStatusText).nullish(),
  // 필드를 보내지 않으면 기존 만료를 유지하고, null을 보내면 만료를 없앤다
  expiresAt: futureDate('expiresAt').nullable().optional(),
  pauseNotifications: z.boolean().optional(),
}).strict().refine((v) => !!v.emoji || !!v.text, { message: 'Emoji or text is required' });

const dndSchema = z.object({
  minutes: z.number().int().min(1).max(10080).optional(),
  until: futureDate('until').optional(),
}).strict().refine((v) => (v.minutes === undefined) !== (v.until === undefined), { message: 'Provide either minutes or until' });

function statusResponse(userId: number, user: Parameters<typeof statusView>[0]) {
  return { id: userId, ...statusView(user, true) };
}

// GET /users/me/dnd - 방해금지 상태 조회 (만료는 조회 시점에 계산)
router.get('/me/dnd', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: STATUS_SELECT });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(computeDnd(user));
  } catch (error) {
    logError('Get dnd error', error);
    res.status(500).json({ error: 'Failed to get dnd' });
  }
});

// PUT|POST /users/me/dnd - 방해금지 켜기 (minutes 또는 until)
async function turnOnDnd(req: AuthRequest, res: Response) {
  try {
    const parsed = dndSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
      return;
    }
    const until = parsed.data.until ?? new Date(Date.now() + parsed.data.minutes! * 60_000);
    const user = await setDnd(req.user!.userId, until);
    res.json(computeDnd(user));
  } catch (error) {
    logError('Set dnd error', error);
    res.status(500).json({ error: 'Failed to set dnd' });
  }
}
router.post('/me/dnd', authMiddleware, turnOnDnd);
router.put('/me/dnd', authMiddleware, turnOnDnd);

// DELETE /users/me/dnd - 방해금지 끄기
router.delete('/me/dnd', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await endDnd(req.user!.userId);
    res.json(computeDnd(user));
  } catch (error) {
    logError('End dnd error', error);
    res.status(500).json({ error: 'Failed to end dnd' });
  }
});

// PUT /users/me/custom-status - 커스텀 상태 설정/수정 (이모지, 문구, 만료, 상태가 지워질 때까지 알림 일시 중지)
router.put('/me/custom-status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = customStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
      return;
    }
    const { emoji, text, expiresAt, pauseNotifications } = parsed.data;
    const user = await setCustomStatus(req.user!.userId, {
      emoji: emoji || null,
      text: text || null,
      expiresAt,
      pauseNotifications: pauseNotifications === true,
    });
    res.json(statusResponse(req.user!.userId, user));
  } catch (error) {
    logError('Set custom status error', error);
    res.status(500).json({ error: 'Failed to set custom status' });
  }
});

// DELETE /users/me/custom-status - 커스텀 상태 지우기 (상태에 묶인 DND도 해제)
router.delete('/me/custom-status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const user = await clearCustomStatus(req.user!.userId);
    res.json(statusResponse(req.user!.userId, user));
  } catch (error) {
    logError('Clear custom status error', error);
    res.status(500).json({ error: 'Failed to clear custom status' });
  }
});

// PATCH /users/me - Update current user profile
router.patch('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const updates = updateProfileSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: userId },
      data: updates,
      select: {
        id: true,
        email: true,
        name: true,
        avatar: true,
        status: true,
        bio: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(user);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Update profile error', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /users/me/avatar - Upload avatar image
router.post('/me/avatar', authMiddleware, avatarUpload.single('avatar'), async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: 'No image uploaded' });
      return;
    }

    // Validate magic bytes
    const { fileTypeFromFile } = await import('file-type');
    const detectedType = await fileTypeFromFile(file.path);
    const allowedImageMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    if (!detectedType || !allowedImageMimes.has(detectedType.mime)) {
      fs.unlinkSync(file.path);
      res.status(400).json({ error: 'File is not a valid image' });
      return;
    }

    // Process image: resize to 512x512 (client already handles cropping)
    const outputFilename = crypto.randomUUID() + '.png';
    const outputPath = path.join(uploadDir, outputFilename);

    try {
      await sharp(file.path, { limitInputPixels: 4096 * 4096 })
        .resize(512, 512, { fit: 'cover' })
        .png()
        .toFile(outputPath);
    } catch (sharpError) {
      // Over the pixel limit or undecodable image: client error, not a server failure
      logError('Avatar image rejected', sharpError);
      fs.unlinkSync(file.path);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      res.status(400).json({ error: 'Image is too large or cannot be processed' });
      return;
    }

    // Delete the original upload
    fs.unlinkSync(file.path);

    // Delete old avatar file if it's a local upload
    const oldUser = await prisma.user.findUnique({ where: { id: userId }, select: { avatar: true } });
    if (oldUser?.avatar?.startsWith('/users/me/avatar/')) {
      const oldFilename = oldUser.avatar.split('/').pop()?.replace(/[^a-zA-Z0-9._-]/g, '');
      if (oldFilename) {
        const oldPath = path.resolve(uploadDir, oldFilename);
        if (oldPath.startsWith(uploadDir) && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
    }

    const avatarUrl = `/users/me/avatar/${outputFilename}`;
    const user = await prisma.user.update({
      where: { id: userId },
      data: { avatar: avatarUrl },
      select: {
        id: true, email: true, name: true, avatar: true,
        status: true, bio: true, createdAt: true, updatedAt: true,
      },
    });

    res.json(user);
  } catch (error) {
    // Clean up temp file on error
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    logError('Avatar upload error', error);
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// GET /users/me/avatar/:filename - Serve avatar image
router.get('/me/avatar/:filename', async (req: AuthRequest, res: Response) => {
  const filename = (req.params.filename as string).replace(/[^a-zA-Z0-9._-]/g, '');
  const filePath = path.resolve(uploadDir, filename);
  if (!filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Avatar not found' });
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    logError('Avatar stream error', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to read avatar' });
  });
  stream.pipe(res);
});

// GET /users/:id - Get user by ID
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseIntParam(req.params.id);
    if (!userId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        avatar: true,
        status: true,
        bio: true,
        createdAt: true,
        ...STATUS_SELECT,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Guests can only view profiles of shared-channel members
    if (req.user!.role === 'GUEST' && userId !== req.user!.userId) {
      const sharedChannel = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT cm1."channelId" AS id
        FROM "ChannelMember" cm1
        JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId"
        WHERE cm1."userId" = ${req.user!.userId} AND cm2."userId" = ${userId}
        LIMIT 1
      `;
      if (sharedChannel.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
    }

    // Enrich with real-time presence status
    const online = isUserOnline(userId);
    // 타인에게는 켜짐 여부와 끝나는 시각만 보인다(상태에 묶인 DND 여부 같은 내부 값은 숨긴다).
    const enrichedUser = {
      ...toPublicUser(user),
      status: online ? 'online' : (user.status || 'offline'),
      isOnline: online,
    };

    res.json(enrichedUser);
  } catch (error) {
    logError('Get user error', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// GET /users - List users (for searching/mentioning)
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const rawSearch = typeof req.query.search === 'string' ? req.query.search.slice(0, 100) : undefined;
    const search = rawSearch || undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

    // Guests can only see users who share a channel with them
    const visibleUserIds = await guestVisibleUserIds(req.user!.userId, req.user!.role);

    const where = {
      deactivatedAt: null,
      ...(visibleUserIds && { id: { in: visibleUserIds } }),
      ...(search && { name: { contains: search, mode: 'insensitive' as const } }),
    };

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        avatar: true,
        status: true,
        ...STATUS_SELECT,
      },
      orderBy: { name: 'asc' },
      take: limit,
    });

    // Augment with real-time WebSocket presence
    const augmented = users.map((u) => {
      return {
        ...toPublicUser(u),
        status: isUserOnline(u.id) ? 'online' : u.status,
        isOnline: isUserOnline(u.id),
      };
    });

    res.json(augmented);
  } catch (error) {
    logError('List users error', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// PUT /users/me/status - Update user status
router.put('/me/status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { status } = z.object({
      status: z.enum(['online', 'away', 'busy', 'offline']),
    }).parse(req.body);

    // 소켓 연결·끊김이 남기는 online/offline 쓰기와 같은 큐에서 순서대로 쓴다(사용자가 고른 상태가 덮이지 않게).
    const user = await presenceQueue.run(userId, () => prisma.user.update({
      where: { id: userId },
      data: { status },
      select: {
        id: true,
        status: true,
      },
    }));

    res.json(user);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Update status error', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// GET /users/:id/presence - Get user presence status
router.get('/:id/presence', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseIntParam(req.params.id);
    if (!userId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        status: true,
        lastSeen: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Guests can only check presence of shared-channel members
    if (req.user!.role === 'GUEST' && userId !== req.user!.userId) {
      const sharedChannel = await prisma.$queryRaw<Array<{ id: number }>>`
        SELECT cm1."channelId" AS id
        FROM "ChannelMember" cm1
        JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId"
        WHERE cm1."userId" = ${req.user!.userId} AND cm2."userId" = ${userId}
        LIMIT 1
      `;
      if (sharedChannel.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
    }

    // Check real-time online status from WebSocket connections
    const isOnline = isUserOnline(userId);

    res.json({
      userId: user.id,
      status: isOnline ? 'online' : user.status,
      lastSeen: user.lastSeen,
      isOnline,
    });
  } catch (error) {
    logError('Get presence error', error);
    res.status(500).json({ error: 'Failed to get presence' });
  }
});

export default router;
