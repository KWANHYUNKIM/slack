import express, { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { ERR } from '../utils/errorCodes.js';
import { rateLimitKey } from '../middleware/rateLimitKey.js';
import {
  OAuthError,
  authenticateClient,
  buildRedirect,
  checkAuthorizeRequest,
  exchangeAuthorizationCode,
  getAllowOAuthApps,
  issueAuthorizationCode,
  parseClientCredentials,
  pickAuthorizeParams,
  publicOrigin,
  refreshAccessToken,
  registerClient,
  revokeToken,
  type AuthorizeCheck,
} from '../services/oauthService.js';
import {
  verifySecondFactor, restoreRecoveryCode, isMfaVerifyLocked, recordMfaVerifyFailure, clearMfaVerifyFailures,
} from '../services/mfaService.js';

// OAuth 2.1 인가 서버 엔드포인트(mcp-4). 프로토콜 엔드포인트(register, authorize, token, revoke)는 RFC 6749 오류 형식
// { error, error_description }으로 답하고, 동의 화면이 부르는 API(authorize/details, authorize/decision)는 { error, code }로 답한다.
// 동의는 로그인 JWT를 Authorization 헤더로 보내는 XHR로만 받는다(쿠키가 없어 다른 사이트가 대신 제출할 수 없다).
const router = Router();

// 토큰·폐기 요청은 application/x-www-form-urlencoded가 표준이다. JSON은 app.ts의 express.json이 이미 읽었다.
router.use(express.urlencoded({ extended: false, limit: '20kb' }));
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const isTest = process.env.NODE_ENV === 'test';
const passThrough = (_req: Request, _res: Response, next: () => void) => next();

// 등록은 인증 없이 열려 있으므로 IP 단위로 묶는다
const registerLimiter = isTest ? passThrough : rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'slow_down', error_description: 'Too many registrations, please try again later' },
  keyGenerator: (req: Request) => (req.ip ? ipKeyGenerator(req.ip) : 'unknown'),
});

const body = (req: Request) => (req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {});
const ipKey = (req: Request) => (req.ip ? ipKeyGenerator(req.ip) : 'unknown');
const SLOW_DOWN = { error: 'slow_down', error_description: 'Too many requests, please try again later' };

/**
 * 토큰·폐기 엔드포인트 제한. 두 겹으로 센다.
 * 1) IP + client_id: 여러 사용자가 같은 서버(IP)에서 부르는 경우(claude.ai 커넥터) 앱마다 따로 센다.
 * 2) IP 단독 상한: client_id를 무작위로 바꿔 1)을 우회하면서 인증 전 조회(클라이언트·코드·토큰 해시)를 퍼붓는 것을 막는다.
 * client_id는 인증과 같은 파서(parseClientCredentials)로 꺼낸다.
 */
export function createOAuthTokenLimiters(perClientMax = 300, perIpMax = 1200) {
  const windowMs = 15 * 60 * 1000;
  const perIp = rateLimit({ windowMs, max: perIpMax, standardHeaders: true, legacyHeaders: false, message: SLOW_DOWN, keyGenerator: ipKey });
  const perClient = rateLimit({
    windowMs, max: perClientMax, standardHeaders: true, legacyHeaders: false, message: SLOW_DOWN,
    keyGenerator: (req: Request) => {
      const creds = parseClientCredentials(req.headers.authorization, body(req));
      return `${ipKey(req)}|${(creds?.clientId ?? '').slice(0, 64)}`;
    },
  });
  return [perIp, perClient];
}

/** 브라우저가 부르는 authorize, details, decision 제한. 로그인 JWT가 있으면 사용자 단위, 없으면 IP 단위(rateLimitKey). */
export function createOAuthBrowserLimiter(max = 60) {
  return rateLimit({
    windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests, please try again later', code: ERR.RATE_LIMITED },
    keyGenerator: rateLimitKey,
  });
}

const tokenLimiter = isTest ? [passThrough] : createOAuthTokenLimiters();
const browserLimiter = isTest ? passThrough : createOAuthBrowserLimiter();

function sendOAuthError(res: Response, err: OAuthError): void {
  if (err.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
  res.status(err.status).json({ error: err.error, error_description: err.description });
}

function handleOAuthFailure(res: Response, error: unknown, what: string): void {
  if (error instanceof OAuthError) {
    sendOAuthError(res, error);
    return;
  }
  logError(what, error);
  res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
}


// POST /oauth/register - 동적 클라이언트 등록(RFC 7591)
router.post('/register', registerLimiter, async (req: Request, res: Response) => {
  try {
    if (!(await getAllowOAuthApps())) {
      res.status(403).json({ error: 'access_denied', error_description: 'OAuth apps are disabled by the workspace administrator' });
      return;
    }
    res.status(201).json(await registerClient(body(req)));
  } catch (error) {
    handleOAuthFailure(res, error, 'OAuth register error');
  }
});

function errorRedirect(check: Extract<AuthorizeCheck, { redirect: true }>, issuer: string): string {
  return buildRedirect(check.redirectUri, {
    error: check.error, error_description: check.description, state: check.state, iss: issuer,
  });
}

// GET /oauth/authorize - 브라우저가 처음 오는 곳. 요청을 확인하고 프런트 동의 화면(/oauth-consent)으로 넘긴다.
// 클라이언트나 redirect_uri가 틀리면 그 주소로 돌려보내지 않는다(오픈 리다이렉트 방지).
router.get('/authorize', browserLimiter, async (req: Request, res: Response) => {
  try {
    const origin = publicOrigin(req);
    const params = pickAuthorizeParams(req.query as Record<string, unknown>);
    const check = await checkAuthorizeRequest(params, origin);
    if (!check.ok) {
      if (check.redirect) {
        res.redirect(302, errorRedirect(check, origin));
        return;
      }
      res.status(400).json({ error: check.error, error_description: check.description });
      return;
    }
    const next = new URLSearchParams();
    next.set('client_id', check.client.clientId);
    next.set('redirect_uri', check.redirectUri);
    next.set('response_type', 'code');
    next.set('scope', check.scopes.join(' '));
    next.set('code_challenge', check.codeChallenge);
    next.set('code_challenge_method', 'S256');
    next.set('resource', check.resource);
    if (check.state !== undefined) next.set('state', check.state);
    res.redirect(302, `/oauth-consent?${next.toString()}`);
  } catch (error) {
    logError('OAuth authorize error', error);
    res.status(500).json({ error: 'server_error', error_description: 'Internal server error' });
  }
});

function consentView(check: Extract<AuthorizeCheck, { ok: true }>, mfaRequired: boolean) {
  const url = new URL(check.redirectUri);
  return {
    client: {
      name: check.client.clientName,
      clientId: check.client.clientId,
      redirectUri: check.redirectUri,
      redirectHost: url.host,
      loopback: url.protocol === 'http:',
    },
    scopes: check.scopes,
    mfaRequired,
  };
}

async function hasMfa(userId: number): Promise<boolean> {
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { mfaEnabledAt: true } });
  return !!me?.mfaEnabledAt;
}

function invalidRequest(res: Response, check: Extract<AuthorizeCheck, { ok: false }>, origin: string): void {
  res.status(400).json({
    error: 'Invalid authorization request',
    code: check.error === 'access_denied' ? ERR.OAUTH_APPS_DISABLED : ERR.OAUTH_INVALID_REQUEST,
    oauthError: check.error,
    ...(check.redirect ? { redirectTo: errorRedirect(check, origin) } : {}),
  });
}

// GET /oauth/authorize/details - 동의 화면에 보여 줄 클라이언트 이름, redirect 호스트, 범위
router.get('/authorize/details', browserLimiter, authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const origin = publicOrigin(req);
    const check = await checkAuthorizeRequest(pickAuthorizeParams(req.query as Record<string, unknown>), origin);
    if (!check.ok) {
      invalidRequest(res, check, origin);
      return;
    }
    res.json(consentView(check, await hasMfa(req.user!.userId)));
  } catch (error) {
    logError('OAuth consent details error', error);
    res.status(500).json({ error: 'Failed to load the authorization request', code: ERR.INTERNAL_ERROR });
  }
});

const decisionSchema = z.object({
  params: z.record(z.string(), z.string().max(2000)),
  approve: z.boolean(),
  // 2FA 사용자는 허용할 때 코드를 다시 확인한다(PAT 발급과 같은 이유: 훔친 세션만으로 오래 사는 토큰을 만들지 못하게)
  code: z.string().trim().min(1).max(32).optional(),
}).strict();

// POST /oauth/authorize/decision - 허용하면 1회용 코드를, 거부하면 access_denied를 붙인 redirect 주소를 돌려준다.
// 프런트는 받은 redirectTo로 이동만 한다(주소는 서버가 등록된 redirect_uri로만 만든다).
router.post('/authorize/decision', browserLimiter, authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { params, approve, code } = decisionSchema.parse(req.body);
    const origin = publicOrigin(req);
    const userId = req.user!.userId;
    const check = await checkAuthorizeRequest(pickAuthorizeParams(params), origin);
    if (!check.ok) {
      invalidRequest(res, check, origin);
      return;
    }
    if (!approve) {
      res.json({ redirectTo: buildRedirect(check.redirectUri, { error: 'access_denied', state: check.state, iss: origin }) });
      return;
    }

    let verified: Awaited<ReturnType<typeof verifySecondFactor>> | null = null;
    if (await hasMfa(userId)) {
      if (!code) {
        res.status(403).json({ error: 'Two-factor code required', code: ERR.MFA_CODE_REQUIRED });
        return;
      }
      if (isMfaVerifyLocked(userId)) {
        res.status(429).json({ error: 'Too many failed attempts. Try again later.', code: ERR.AUTH_TOO_MANY_ATTEMPTS });
        return;
      }
      verified = await verifySecondFactor(userId, code);
      if (!verified.ok) {
        if (verified.reason === 'unavailable') {
          res.status(503).json({ error: 'Two-factor authentication is not available on this server', code: ERR.MFA_UNAVAILABLE });
          return;
        }
        recordMfaVerifyFailure(userId);
        res.status(403).json({ error: 'Invalid authentication code', code: ERR.MFA_INVALID_CODE });
        return;
      }
      clearMfaVerifyFailures(userId);
    }

    let authCode: string;
    try {
      authCode = await issueAuthorizationCode({
        clientId: check.client.id, userId, redirectUri: check.redirectUri, scopes: check.scopes,
        resource: check.resource, codeChallenge: check.codeChallenge,
      });
    } catch (error) {
      if (verified?.ok && verified.method === 'recovery') await restoreRecoveryCode(userId, verified.consumed);
      throw error;
    }
    if (verified?.ok && verified.method === 'recovery') {
      void writeAuditLog({ action: 'mfa.recovery_used', actorId: userId, targetType: 'user', targetId: userId, details: `remaining=${verified.remaining}; purpose=oauth_authorize` });
    }
    // 코드 원문은 남기지 않는다
    void writeAuditLog({
      action: 'oauth.authorized', actorId: userId, targetType: 'oauth_client', targetId: check.client.id,
      targetName: check.client.clientName,
      details: JSON.stringify({ scopes: check.scopes, redirectHost: new URL(check.redirectUri).host }),
    });
    res.json({ redirectTo: buildRedirect(check.redirectUri, { code: authCode, state: check.state, iss: origin }) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid body', details: error.issues });
      return;
    }
    logError('OAuth consent decision error', error);
    res.status(500).json({ error: 'Failed to complete the authorization', code: ERR.INTERNAL_ERROR });
  }
});

// POST /oauth/token - authorization_code(+PKCE)와 refresh_token(회전)
router.post('/token', ...tokenLimiter, async (req: Request, res: Response) => {
  try {
    const b = body(req);
    const client = await authenticateClient(req.headers.authorization, b);
    const origin = publicOrigin(req);
    if (b.grant_type === 'authorization_code') {
      res.json(await exchangeAuthorizationCode(client, b, origin));
    } else if (b.grant_type === 'refresh_token') {
      res.json(await refreshAccessToken(client, b, origin));
    } else {
      throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
  } catch (error) {
    handleOAuthFailure(res, error, 'OAuth token error');
  }
});

// POST /oauth/revoke - RFC 7009. 없는 토큰이어도 200으로 답한다.
router.post('/revoke', ...tokenLimiter, async (req: Request, res: Response) => {
  try {
    const b = body(req);
    const client = await authenticateClient(req.headers.authorization, b);
    await revokeToken(client, b);
    res.status(200).json({});
  } catch (error) {
    handleOAuthFailure(res, error, 'OAuth revoke error');
  }
});

export default router;
