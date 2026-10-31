import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireFileAccess, verifyFileAccess, verifyFilesAccess } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { JWT_SECRET } from '../config.js';
import { bucket, uploadDir } from '../services/fileStorage.js';
import { UPLOAD_ALLOWED_MIMES } from '../utils/fileTypes.js';

// Maximum file size in MB (configurable via environment variable, defaults to 50MB)
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Strip internal storage details from file records before sending to clients.
// The gcsPath reveals the GCS bucket structure and could enable direct bucket
// access if the bucket has misconfigured ACLs.
function stripInternalFields(file: any): any {
  const { gcsPath, ...safe } = file;
  return safe;
}

// GCS 클라이언트와 uploads 폴더는 services/fileStorage.ts에서 공용으로 만든다

const router = Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // No user-controlled extension — prevents SVG/HTML execution if uploads dir is ever served directly
    cb(null, crypto.randomUUID());
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (req, file, cb) => {
    // Allow common file types
    const allowedMimes = UPLOAD_ALLOWED_MIMES;
    // Accept application/octet-stream for video extensions (browsers/clients
    // sometimes don't set the correct MIME); magic-byte validation later
    // will verify the actual content.
    const videoExts = new Set(['.mp4', '.webm', '.mov', '.mkv']);
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) ||
        (file.mimetype === 'application/octet-stream' && videoExts.has(ext))) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  },
});

// Upload-specific rate limit (skip in test)
const isTest = process.env.NODE_ENV === 'test';
const uploadLimiter = isTest
  ? (_req: any, _res: any, next: any) => next()
  : rateLimit({
      windowMs: 60_000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many uploads, please try again later' },
    });

// Safe types that can be shown inline
const INLINE_SAFE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/webm', 'audio/aac',
  'video/mp4', 'video/webm',
]);

// Helper to upload to GCS
async function uploadToGCS(localPath: string, filename: string, mimetype: string): Promise<{ gcsPath: string }> {
  if (!bucket) throw new Error('GCS not configured');

  // Sanitize filename for GCS path (strip path separators and control chars)
  const safeName = filename.replace(/[/\\:\x00-\x1F\x7F]/g, '_').slice(0, 255);
  const gcsPath = `uploads/${Date.now()}-${safeName}`;
  await bucket.upload(localPath, {
    destination: gcsPath,
    metadata: { contentType: mimetype },
  });

  // Delete local temp file after GCS upload
  fs.unlinkSync(localPath);

  return { gcsPath };
}

// RFC 5987 Content-Disposition filename encoding
function contentDisposition(disposition: string, filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/['()]/g, escape);
  return `${disposition}; filename="${filename.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encoded}`;
}

// POST /files - Upload a file
router.post('/', authMiddleware, uploadLimiter, (req: AuthRequest, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `File is too large. Maximum file size is ${MAX_FILE_SIZE_MB} MB.` });
        return;
      }
      if (err.message === 'File type not allowed') {
        res.status(400).json({ error: 'File type not allowed' });
        return;
      }
      res.status(400).json({ error: err.message || 'Upload failed' });
      return;
    }
    next();
  });
}, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    // Validate actual file content via magic bytes, not just client Content-Type
    const { fileTypeFromFile } = await import('file-type');
    const detectedType = await fileTypeFromFile(file.path);
    const allowedMimesByMagic = new Set([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf', 'application/zip',
      // file-type 22 detects iWork packages separately from plain zip
      'application/vnd.apple.keynote', 'application/vnd.apple.pages', 'application/vnd.apple.numbers',
      'audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/webm',
      'video/mp4', 'video/webm', 'video/quicktime',
    ]);
    // Text/JSON files have no magic bytes — allow if client claimed text/plain or application/json
    const textTypes = new Set(['text/plain', 'application/json']);
    if (detectedType) {
      if (!allowedMimesByMagic.has(detectedType.mime)) {
        fs.unlinkSync(file.path);
        res.status(400).json({ error: 'File content does not match an allowed type' });
        return;
      }
      // Override client-provided mimetype with detected one,
      // but keep audio/webm when client claims audio in a WebM container
      // (file-type detects all WebM as video/webm even for audio-only)
      if (detectedType.mime === 'video/webm' && file.mimetype.startsWith('audio/webm')) {
        // keep client's audio/webm (may include codec params like audio/webm;codecs=opus)
        file.mimetype = 'audio/webm';
      } else {
        file.mimetype = detectedType.mime;
      }
    } else if (!textTypes.has(file.mimetype)) {
      // No magic bytes detected and not a text type — reject
      fs.unlinkSync(file.path);
      res.status(400).json({ error: 'File content does not match an allowed type' });
      return;
    }

    const rawMessageId = req.body?.messageId ? parseInt(req.body.messageId) : undefined;
    if (rawMessageId !== undefined && isNaN(rawMessageId)) {
      fs.unlinkSync(file.path);
      res.status(400).json({ error: 'Invalid messageId' });
      return;
    }
    const messageId = rawMessageId;

    // If messageId is provided, verify user owns the message and has channel access
    if (messageId) {
      const message = await prisma.message.findUnique({
        where: { id: messageId },
      });

      if (!message || message.deletedAt) {
        // Delete uploaded file
        fs.unlinkSync(file.path);
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      // Only the message author can attach files
      if (message.userId !== userId) {
        fs.unlinkSync(file.path);
        res.status(403).json({ error: 'You can only attach files to your own messages' });
        return;
      }

      const [membership, channel] = await Promise.all([
        prisma.channelMember.findUnique({
          where: {
            userId_channelId: { userId, channelId: message.channelId },
          },
        }),
        prisma.channel.findUnique({
          where: { id: message.channelId },
          select: { archivedAt: true },
        }),
      ]);

      if (!membership) {
        fs.unlinkSync(file.path);
        res.status(403).json({ error: 'You must be a member of the channel' });
        return;
      }

      if (channel?.archivedAt) {
        fs.unlinkSync(file.path);
        res.status(403).json({ error: 'This channel has been archived' });
        return;
      }
    }

    let url: string;
    let gcsPath: string | null = null;

    // Upload to GCS if configured, otherwise use local storage
    if (bucket) {
      try {
        const gcsResult = await uploadToGCS(file.path, file.originalname, file.mimetype);
        url = ''; // Will be set to download endpoint URL after record creation
        gcsPath = gcsResult.gcsPath;
      } catch (gcsError) {
        logError('GCS upload failed', gcsError);
        // Clean up local temp file
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.status(502).json({ error: 'File storage unavailable' });
        return;
      }
    } else {
      // URL will be updated after creation to use authenticated download endpoint
      url = '';
    }

    // Sanitize and truncate original filename
    const sanitizedOriginalName = file.originalname
      .replace(/[\x00-\x1F\x7F]/g, '') // strip control characters
      .slice(0, 255);

    const fileRecord = await prisma.file.create({
      data: {
        filename: file.filename,
        originalName: sanitizedOriginalName,
        mimetype: file.mimetype,
        size: file.size,
        url,
        gcsPath,
        userId,
        messageId,
      },
      include: {
        user: {
          select: { id: true, name: true, avatar: true },
        },
      },
    });

    // Set URL to authenticated download endpoint for all files
    const downloadUrl = `/files/${fileRecord.id}/download`;
    await prisma.file.update({
      where: { id: fileRecord.id },
      data: { url: downloadUrl },
    });
    fileRecord.url = downloadUrl;

    res.status(201).json(stripInternalFields(fileRecord));
  } catch (error) {
    // Clean up orphaned file on disk if Prisma or any post-upload step fails
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    logError('Upload file error', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// GET /files/:id - Get file info
router.get('/:id', authMiddleware, requireFileAccess, async (req: AuthRequest, res: Response) => {
  try {
    res.json(stripInternalFields(req.file));
  } catch (error) {
    logError('Get file error', error);
    res.status(500).json({ error: 'Failed to get file' });
  }
});

// 다운로드 토큰: <img>·<a>처럼 Authorization 헤더를 못 붙이는 요청용이다.
// 파일 하나(fileId)에 묶이고 수명이 짧다. 파일 id가 없는 구형 토큰은 받지 않는다.
const DOWNLOAD_TOKEN_TTL = '5m';
const MAX_TOKENS_PER_REQUEST = 50;
const downloadTokenSchema = z.union([
  z.object({ fileId: z.number().int().positive() }).strict(),
  z.object({ fileIds: z.array(z.number().int().positive()).min(1).max(MAX_TOKENS_PER_REQUEST) }).strict(),
]);

function signDownloadToken(userId: number, tokenVersion: number, fileId: number): string {
  return jwt.sign(
    { userId, tokenVersion, purpose: 'file-download', fileId },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: DOWNLOAD_TOKEN_TTL },
  );
}

// POST /files/download-token - Issue short-lived, file-scoped download tokens
// body: { fileId } -> { token }, { fileIds } -> { tokens: { [fileId]: token } } (접근 못 하는 파일은 빠진다)
router.post('/download-token', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = downloadTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const userId = req.user!.userId;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } });
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if ('fileId' in parsed.data) {
      const { fileId } = parsed.data;
      const file = await verifyFileAccess(userId, fileId);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.json({ token: signDownloadToken(userId, user.tokenVersion, fileId) });
      return;
    }

    const tokens: Record<number, string> = {};
    const allowed = await verifyFilesAccess(userId, parsed.data.fileIds);
    for (const fileId of allowed) {
      tokens[fileId] = signDownloadToken(userId, user.tokenVersion, fileId);
    }
    // limit: 프런트가 묶음 크기를 서버 값에 맞추게 한다
    res.json({ tokens, limit: MAX_TOKENS_PER_REQUEST });
  } catch (error) {
    logError('Generate download token error', error);
    res.status(500).json({ error: 'Failed to generate download token' });
  }
});

// GET /files/:id/download - Download file content (authenticated via header, or file-scoped download token)
router.get('/:id/download', async (req: AuthRequest, res: Response, next) => {
  // 쿼리 토큰은 파일 하나에 묶인 purpose=file-download 토큰만 받는다.
  // 로그에 남아도 피해가 그 파일·몇 분으로 제한되고, 응답은 Referrer-Policy: no-referrer(helmet)로 Referer 유출을 막는다.
  if (!req.headers.authorization && req.query.token) {
    try {
      const raw = req.query.token;
      if (typeof raw !== 'string') {
        res.status(401).json({ error: 'Invalid or expired download token' });
        return;
      }
      const payload = jwt.verify(raw, JWT_SECRET, { algorithms: ['HS256'] }) as any;
      if (payload.purpose !== 'file-download') {
        res.status(403).json({ error: 'Invalid download token' });
        return;
      }
      // 범위 없는(fileId 없는) 구형 토큰과 다른 파일의 토큰은 거부한다
      if (!Number.isInteger(payload.fileId) || payload.fileId !== parseIntParam(req.params.id)) {
        res.status(403).json({ error: 'Token not valid for this file' });
        return;
      }
      // 발급 뒤 비활성화·로그아웃(tokenVersion 증가)된 사용자는 막는다
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { tokenVersion: true, deactivatedAt: true },
      });
      if (!user || user.deactivatedAt || user.tokenVersion !== payload.tokenVersion) {
        res.status(401).json({ error: 'Invalid or expired download token' });
        return;
      }
      req.user = { userId: payload.userId };
    } catch {
      res.status(401).json({ error: 'Invalid or expired download token' });
      return;
    }
  }
  next();
}, (req: AuthRequest, res: Response, next: NextFunction) => {
  // Skip authMiddleware if user was already set by download token
  if (req.user) return next();
  authMiddleware(req, res, next);
}, requireFileAccess, async (req: AuthRequest, res: Response) => {
  try {
    const file = req.file;

    // ETag: 파일 내용은 바뀌지 않으므로 id·크기·생성 시각으로 만든다.
    // 토큰·접근 검증(requireFileAccess)은 이 앞에서 이미 끝났으므로 304도 권한이 있는 요청에만 나간다.
    // no-cache는 "저장은 하되 매번 재검증"이라 채널을 나간 뒤에는 304가 아니라 404가 된다.
    const etag = `"${file.id}-${file.size}-${new Date(file.createdAt).getTime()}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((v) => v.trim() === etag)) {
      res.status(304).end();
      return;
    }

    // GCS files: stream through backend (ADC on Cloud Run lacks signing key for getSignedUrl)
    if (file.gcsPath && bucket) {
      const forceAttachment = !INLINE_SAFE_TYPES.has(file.mimetype);
      const disposition = (req.query.dl === '1' || forceAttachment) ? 'attachment' : 'inline';

      res.setHeader('Content-Type', file.mimetype);
      res.setHeader('Content-Disposition', contentDisposition(disposition, file.originalName));
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const gcsFile = bucket.file(file.gcsPath);
      const stream = gcsFile.createReadStream();
      stream.on('error', (err) => {
        logError('GCS stream error', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to read file from storage' });
      });
      stream.pipe(res);
      return;
    }

    // Local files: stream from disk
    const filePath = path.resolve(uploadDir, file.filename);
    if (!filePath.startsWith(uploadDir) || !fs.existsSync(filePath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }

    // Force attachment for dangerous mimetypes (non-image/audio/video)
    const forceAttachment = !INLINE_SAFE_TYPES.has(file.mimetype);
    const disposition = (req.query.dl === '1' || forceAttachment) ? 'attachment' : 'inline';

    res.setHeader('Content-Type', file.mimetype);
    res.setHeader('Content-Disposition', contentDisposition(disposition, file.originalName));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');

    const total = file.size;
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

      // Validate range bounds
      if (start < 0 || end >= total || start > end || isNaN(start) || isNaN(end)) {
        res.setHeader('Content-Range', `bytes */${total}`);
        res.status(416).json({ error: 'Range not satisfiable' }); // code는 errorCodeDefaults가 붙인다
        return;
      }

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', (err) => {
        logError('File stream error', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to read file' });
      });
      stream.pipe(res);
    } else {
      res.setHeader('Content-Length', total);
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        logError('File stream error', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to read file' });
      });
      stream.pipe(res);
    }
  } catch (error) {
    logError('Download file error', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// DELETE /files/:id - Delete a file
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const fileId = parseIntParam(req.params.id);
    const userId = req.user!.userId;

    if (!fileId) {
      res.status(400).json({ error: 'Invalid file ID' });
      return;
    }

    const file = await prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    if (file.userId !== userId) {
      // Return 404 (not 403) to prevent file-existence enumeration
      res.status(404).json({ error: 'File not found' });
      return;
    }

    // Prevent deletion of files attached to messages or DMs
    if (file.messageId || file.dmId) {
      res.status(400).json({ error: 'Cannot delete a file that is attached to a message' });
      return;
    }

    // Delete from storage
    if (file.gcsPath && bucket) {
      // Delete from GCS
      try {
        await bucket.file(file.gcsPath).delete();
      } catch (err) {
        logError('Failed to delete from GCS', err);
      }
    } else {
      // Delete local file
      const filePath = path.resolve(uploadDir, file.filename);
      if (filePath.startsWith(uploadDir) && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    // Delete database record
    await prisma.file.delete({
      where: { id: fileId },
    });

    res.json({ message: 'File deleted' });
  } catch (error) {
    logError('Delete file error', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// GET /files - List user's files
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const files = await prisma.file.findMany({
      where: {
        userId,
        OR: [
          { messageId: null },
          { message: { deletedAt: null } },
        ],
      },
      include: {
        user: {
          select: { id: true, name: true, avatar: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json(files.map(stripInternalFields));
  } catch (error) {
    logError('List files error', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

export default router;
