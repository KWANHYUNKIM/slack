import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import authRoutes from './routes/auth.js';
import channelRoutes from './routes/channels.js';
import messageRoutes from './routes/messages.js';
import threadRoutes from './routes/threads.js';
import threadListRoutes from './routes/thread-list.js';
import searchRoutes from './routes/search.js';
import reactionRoutes from './routes/reactions.js';
import fileRoutes from './routes/files.js';
import userRoutes from './routes/users.js';
import dmRoutes from './routes/dms.js';
import dmGroupRoutes from './routes/dmGroups.js';
import bookmarkRoutes from './routes/bookmarks.js';
import webhookRoutes from './routes/webhooks.js';
import unreadRoutes from './routes/unreads.js';
import scheduledMessageRoutes from './routes/scheduled-messages.js';
import adminRoutes from './routes/admin.js';
import pushRoutes from './routes/push.js';
import activityRoutes from './routes/activity.js';
import huddleRoutes from './routes/huddles.js';
import reminderRoutes from './routes/reminders.js';
import tokenRoutes from './routes/tokens.js';
import mcpRoutes from './routes/mcp.js';
import { errorHandler } from './middleware/errorHandler.js';
import { errorCodeDefaults } from './middleware/errorCode.js';
import { ERR } from './utils/errorCodes.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitKey } from './middleware/rateLimitKey.js';
import { accessTokenAuth } from './middleware/accessTokenAuth.js';
import { createMcpAuthFailureLimiter, createMcpTokenLimiter } from './mcp/rateLimit.js';
import { JWT_SECRET } from './config.js';
import { parseTrustProxy, useSecureTransport } from './runtimeConfig.js';

const app = express();

// TRUST_PROXY: 앞단 프록시 홉 수(기본 0 = 신뢰 안 함). 프록시 뒤에서는 1 등으로 설정해야 rate limit이 클라이언트 IP로 키잉된다.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
const secureTransport = useSecureTransport(process.env);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      // PUBLIC_URL이 http이면 https로 강제 승격하지 않는다(LAN 시험용).
      'upgrade-insecure-requests': secureTransport ? [] : null,
      // 규칙 17: 외부 출처를 허용하지 않는다. 파일(GCS 포함)은 서버가 스트리밍하므로 'self'로 충분하다.
      'img-src': ["'self'", 'blob:', 'data:'],
      // CSP3: 'self'는 같은 호스트·포트의 ws/wss도 허용한다. 소켓은 io()로 같은 출처에 붙는다.
      'connect-src': ["'self'"],
      'media-src': ["'self'", 'blob:'],
    },
  },
  crossOriginEmbedderPolicy: 'credentialless' as any,
  hsts: secureTransport ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));
const corsOrigin = process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : 'http://localhost:5173');
app.use(cors({ origin: corsOrigin as string | boolean }));
app.use(compression());
app.use(express.json({ limit: '100kb' }));
// 오류 응답에 code가 없으면 상태 코드별 기본 code를 붙인다(i18n-3)
app.use(errorCodeDefaults);

// Rate limiting (skip in test environment)
const isTest = process.env.NODE_ENV === 'test';

const authLimiter = isTest
  ? (_req: any, _res: any, next: any) => next()
  : rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many attempts, please try again later', code: ERR.RATE_LIMITED },
    });

const apiLimiter = isTest
  ? (_req: any, _res: any, next: any) => next()
  : rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please try again later', code: ERR.RATE_LIMITED },
      keyGenerator: rateLimitKey,
    });

// /mcp: 인증 실패는 IP 단위, 성공한 요청은 토큰 단위로 따로 센다
const mcpAuthFailureLimiter = isTest ? (_req: any, _res: any, next: any) => next() : createMcpAuthFailureLimiter();
const mcpTokenLimiter = isTest ? (_req: any, _res: any, next: any) => next() : createMcpTokenLimiter();

// Cache-Control: no-store for all API responses
app.use((req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/channels') || req.path.startsWith('/messages') ||
      req.path.startsWith('/files') || req.path.startsWith('/users') || req.path.startsWith('/dms') ||
      req.path.startsWith('/search') || req.path.startsWith('/bookmarks') || req.path.startsWith('/admin') ||
      req.path.startsWith('/push') || req.path.startsWith('/threads') || req.path.startsWith('/tokens') ||
      req.path.startsWith('/mcp')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// Note: /uploads is NOT served via express.static to prevent unauthenticated access.
// Files are served through the authenticated GET /files/:id/download endpoint.

// In production, intercept browser navigations (Accept: text/html) for SPA routes
// that collide with API routes (e.g. /files, /admin) and serve index.html
if (process.env.NODE_ENV === 'production') {
  const spaRoutes = ['/files', '/admin', '/dms', '/activity', '/threads'];
  const frontendDist = path.join(process.cwd(), 'public');
  app.use(spaRoutes, (req, res, next) => {
    // Skip API calls: they carry Authorization or explicitly request JSON
    const isApiCall = req.headers.authorization || req.headers.accept === 'application/json';
    if (!isApiCall && req.method === 'GET' && req.accepts('html') && !req.path.includes('.')) {
      // Only for top-level navigation (no sub-paths like /files/:id/download)
      if (req.originalUrl === req.baseUrl || req.originalUrl === req.baseUrl + '/') {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(frontendDist, 'index.html'));
        return;
      }
    }
    next();
  });
}

// Routes
app.use('/auth', authLimiter, authRoutes);
app.use('/channels', apiLimiter, channelRoutes);
app.use('/channels', apiLimiter, messageRoutes);
app.use('/messages', apiLimiter, threadRoutes);
app.use('/threads', apiLimiter, threadListRoutes);
app.use('/messages', apiLimiter, reactionRoutes);
app.use('/search', apiLimiter, searchRoutes);
app.use('/files', apiLimiter, fileRoutes);
app.use('/users', apiLimiter, userRoutes);
// /dms/:userId보다 먼저 등록해야 'groups'가 사용자 id로 해석되지 않는다
app.use('/dms/groups', apiLimiter, dmGroupRoutes);
app.use('/dms', apiLimiter, dmRoutes);
app.use('/messages', apiLimiter, bookmarkRoutes);
app.use('/bookmarks', apiLimiter, bookmarkRoutes);
app.use('/webhooks', apiLimiter, webhookRoutes);
app.use('/unreads', apiLimiter, unreadRoutes);
app.use('/messages', apiLimiter, scheduledMessageRoutes);
app.use('/admin', apiLimiter, adminRoutes);
app.use('/push', apiLimiter, pushRoutes);
app.use('/activity', apiLimiter, activityRoutes);
app.use('/huddles', apiLimiter, huddleRoutes);
app.use('/reminders', apiLimiter, reminderRoutes);
app.use('/tokens', apiLimiter, tokenRoutes);
// MCP는 개인 액세스 토큰으로만 인증한다(로그인 JWT는 accessTokenAuth가 거부)
app.use('/mcp', mcpAuthFailureLimiter, accessTokenAuth, mcpTokenLimiter, mcpRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Serve frontend in production
if (process.env.NODE_ENV === 'production') {
  const frontendDist = path.join(process.cwd(), 'public');
  app.use(express.static(frontendDist, { dotfiles: 'deny' }));
  app.get('/{*splat}', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// Error handler
app.use(errorHandler);

export default app;
