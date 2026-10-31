import crypto from 'crypto';
import type { Request } from 'express';
import prisma from '../db.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { shouldWriteLastUsed } from '../utils/lastUsed.js';
import { ALLOWED_SCOPES, READ_SCOPES, hashSecret } from './accessTokenService.js';
import { isMfaPolicyEnforced } from './mfaService.js';
import { getPolicySettings, invalidateSettingsCache } from './settingsCache.js';

// OAuth 2.1 인가 서버(mcp-4). MCP 인가 사양(2025-06-18)을 따른다:
// RFC 8414 인가 서버 메타데이터, RFC 9728 보호 리소스 메타데이터, RFC 7591 동적 클라이언트 등록,
// RFC 7636 PKCE(S256만), RFC 8707 리소스 지시자, RFC 7009 폐기.
// 비밀값(클라이언트 비밀, 코드, 토큰)은 crypto.randomBytes로 만들고 DB에는 sha256 해시만 둔다.
// 코드와 토큰은 256비트 난수의 해시를 유니크 인덱스로 조회한다(원문을 모르면 맞출 수 없어 비교 시간 차이가 의미가 없다).
// 클라이언트 비밀과 PKCE 검증값은 timingSafeEqual로 비교한다.

export const ACCESS_TOKEN_PREFIX = 'scoat_';
export const REFRESH_TOKEN_PREFIX = 'scort_';
const CLIENT_ID_PREFIX = 'scoc_';
const CLIENT_SECRET_PREFIX = 'scocs_';
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const ACCESS_TOKEN_TTL_SEC = 60 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
// 동의 화면에 보여 줄 수 있는 길이로 자른다. 등록 요청이 아무 값이나 넣을 수 있으므로 화면은 항상 redirect 호스트를 함께 보여 준다.
const CLIENT_NAME_MAX = 100;
const REDIRECT_URI_MAX = 2000;
const MAX_REDIRECT_URIS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
// 토큰을 한 번도 받지 않은 등록은 이 기간이 지나면 정리한다
const UNUSED_CLIENT_TTL_MS = 30 * DAY_MS;

export const AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** OAuth 오류(RFC 6749 5.2 형식). 라우트가 { error, error_description }로 바꿔 보낸다. */
export class OAuthError extends Error {
  constructor(public error: string, public description: string, public status = 400) {
    super(description);
  }
}

const sha256 = (v: string) => hashSecret(v);
const randomSecret = () => crypto.randomBytes(32).toString('base64url');

// ---- 출처와 메타데이터 ----

/** PUBLIC_URL의 출처. 없거나 형식이 틀리면 null. 환경 변수는 호출 시점에 읽는다(테스트가 바꿔 가며 확인한다). */
export function configuredOrigin(): string | null {
  const env = (process.env.PUBLIC_URL ?? '').trim();
  if (!env) return null;
  try {
    const url = new URL(env);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * 이 서버의 공개 출처(issuer, 리소스, 메타데이터 주소의 기준).
 * - PUBLIC_URL이 있으면 그것만 쓴다. Host 헤더는 믿지 않는다(메타데이터·redirect·audience를 공격자가 바꾸지 못하게).
 * - 운영(production)에서 PUBLIC_URL이 없으면 null: OAuth 엔드포인트는 503, /mcp는 PAT만 받는다.
 * - 개발에서만 요청의 프로토콜과 Host로 대신한다(vite proxy가 Host를 바꾸지 않게 해 둔다). 이때 메타데이터는 캐시하지 않는다.
 */
export function publicOrigin(req: Pick<Request, 'protocol' | 'get'>): string | null {
  const configured = configuredOrigin();
  if (configured) return configured;
  if (isProduction()) return null;
  return `${req.protocol}://${req.get('host')}`;
}

let warnedUnconfigured = false;
/** 운영에서 PUBLIC_URL이 없으면 서버 시작 때 한 번 경고한다(app.ts가 부른다). */
export function warnIfOAuthUnconfigured(): void {
  if (warnedUnconfigured || !isProduction() || configuredOrigin()) return;
  warnedUnconfigured = true;
  console.warn('WARNING: PUBLIC_URL is not set (or invalid). OAuth endpoints are disabled (503) and /mcp accepts personal access tokens only.');
}

/**
 * OAuth 액세스 토큰의 audience(resource)가 이 서버의 /mcp인지.
 * PUBLIC_URL이 있으면 정식 resource와 정확히 같아야 한다. 개발(PUBLIC_URL 없음)에서는 Host가 요청마다 달라질 수 있어
 * (localhost, 127.0.0.1, vite proxy) 호스트는 보지 않고 경로가 /mcp인지만 본다. 다른 경로(다른 리소스)용 토큰은 거부한다.
 */
export function audienceMatches(tokenResource: string, configured: string | null): boolean {
  if (configured) return tokenResource === mcpResourceUrl(configured);
  try {
    return new URL(tokenResource).pathname === '/mcp';
  } catch {
    return false;
  }
}

export const mcpResourceUrl = (origin: string) => `${origin}/mcp`;
export const protectedResourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [...ALLOWED_SCOPES],
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [...ALLOWED_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Team messenger MCP',
  };
}

/** RFC 8707: resource는 우리 /mcp만 받는다. 끝의 '/' 하나는 같은 것으로 본다. 없으면 기본값으로 /mcp를 쓴다. */
export function normalizeResource(resource: string | undefined, origin: string): string | null {
  const expected = mcpResourceUrl(origin);
  if (resource === undefined || resource === '') return expected;
  return resource === expected || resource === `${expected}/` ? expected : null;
}

/** 공백으로 나눈 scope. 없으면 읽기 범위. 모르는 범위가 있으면 null. */
export function parseScopes(scope: string | undefined): string[] | null {
  if (scope === undefined || scope.trim() === '') return [...READ_SCOPES];
  const list = [...new Set(scope.trim().split(/\s+/))];
  if (list.some((s) => !ALLOWED_SCOPES.includes(s))) return null;
  return list;
}

// ---- 조직 정책 ----

/** 화면·인증 판단용(공용 5초 캐시). 토큰 발급은 이 값 대신 트랜잭션 안에서 lockPolicyForIssue로 다시 확인한다. */
export async function getAllowOAuthApps(): Promise<boolean> {
  return (await getPolicySettings()).allowOAuthApps;
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** 설정 행이 없으면 기본값으로 만든다(잠글 행이 있어야 끄기와 발급이 서로를 기다린다). */
async function ensureSettingRow(tx: Tx): Promise<void> {
  await tx.$executeRaw`INSERT INTO "WorkspaceSetting" ("id", "updatedAt") VALUES (1, NOW()) ON CONFLICT ("id") DO NOTHING`;
}

/**
 * 토큰을 넣는 트랜잭션 안에서 부른다. 설정 행을 FOR SHARE로 잡고 캐시 없이 허용 여부를 읽는다.
 * 끄기(setAllowOAuthApps)는 같은 행을 FOR UPDATE로 잡으므로, 끄기가 먼저면 여기서 false를 보고,
 * 발급이 먼저면 끄기가 이 트랜잭션의 커밋을 기다린 뒤 새 토큰까지 폐기한다. 어느 순서든 끈 뒤 살아 있는 토큰이 남지 않는다.
 */
async function lockPolicyForIssue(tx: Tx): Promise<boolean> {
  await ensureSettingRow(tx);
  const rows = await tx.$queryRaw<{ allowOAuthApps: boolean }[]>`SELECT "allowOAuthApps" FROM "WorkspaceSetting" WHERE "id" = 1 FOR SHARE`;
  return rows[0]?.allowOAuthApps ?? true;
}

/** 끄면 살아 있는 OAuth 토큰을 모두 폐기한다(다시 켜도 예전 연결이 살아나지 않게). 폐기한 행 수를 돌려준다. */
export async function setAllowOAuthApps(allow: boolean): Promise<number> {
  const revoked = await prisma.$transaction(async (tx) => {
    await ensureSettingRow(tx);
    await tx.$queryRaw`SELECT "id" FROM "WorkspaceSetting" WHERE "id" = 1 FOR UPDATE`;
    await tx.workspaceSetting.update({ where: { id: 1 }, data: { allowOAuthApps: allow } });
    if (allow) return 0;
    // 아직 교환하지 않은 인가 코드도 지운다(끈 뒤에 토큰으로 바꾸지 못하게)
    const { count } = await tx.oAuthToken.updateMany({ where: { revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.oAuthAuthorizationCode.deleteMany({ where: { usedAt: null } });
    return count;
  });
  invalidateSettingsCache();
  return revoked;
}

// ---- 동적 클라이언트 등록(RFC 7591) ----

/**
 * redirect_uri는 https이거나 loopback(localhost, 127.0.0.1, [::1])의 http만 받는다(OAuth 2.1, MCP 인가 사양).
 * 사용자 정보(user:pass@)와 fragment는 금지한다. 비교는 등록한 문자열과 정확히 같아야 한다(포트만 다른 loopback도 허용하지 않는다).
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > REDIRECT_URI_MAX) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || uri.includes('#')) return false;
  if (url.protocol === 'https:') return url.hostname.length > 0;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return false;
}

export interface RegistrationInput {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  scope?: unknown;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export async function registerClient(input: RegistrationInput) {
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array');
  }
  for (const u of uris) {
    if (typeof u !== 'string' || !isAllowedRedirectUri(u)) {
      throw new OAuthError('invalid_redirect_uri', 'redirect_uris must use https or an http loopback address');
    }
  }
  const method = input.token_endpoint_auth_method ?? 'client_secret_basic'; // RFC 7591 2: 생략하면 client_secret_basic
  if (typeof method !== 'string' || !(AUTH_METHODS as readonly string[]).includes(method)) {
    throw new OAuthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
  }
  if (input.grant_types !== undefined) {
    if (!Array.isArray(input.grant_types) || input.grant_types.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
      throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
    }
  }
  if (input.response_types !== undefined) {
    if (!Array.isArray(input.response_types) || input.response_types.some((r) => r !== 'code')) {
      throw new OAuthError('invalid_client_metadata', 'Only the code response type is supported');
    }
  }
  if (input.scope !== undefined && (typeof input.scope !== 'string' || parseScopes(input.scope) === null)) {
    throw new OAuthError('invalid_client_metadata', 'Unknown scope');
  }
  let name = typeof input.client_name === 'string' ? input.client_name.trim() : '';
  if (CONTROL_CHARS.test(name)) throw new OAuthError('invalid_client_metadata', 'client_name cannot contain control characters');
  // 이름이 없으면 빈 값으로 둔다. 화면이 번역된 "이름 없는 앱"으로 바꿔 보여 준다(서버가 언어를 정하지 않게).
  name = [...name].slice(0, CLIENT_NAME_MAX).join('');

  const clientId = `${CLIENT_ID_PREFIX}${crypto.randomBytes(16).toString('hex')}`;
  const secret = method === 'none' ? null : `${CLIENT_SECRET_PREFIX}${randomSecret()}`;
  const row = await prisma.oAuthClient.create({
    data: {
      clientId,
      clientSecretHash: secret ? sha256(secret) : null,
      tokenEndpointAuthMethod: method,
      clientName: name,
      redirectUris: uris as string[],
    },
  });
  void writeAuditLog({
    action: 'oauth.client_registered', targetType: 'oauth_client', targetId: row.id, targetName: row.clientName || undefined,
    details: JSON.stringify({ authMethod: method, redirectHosts: [...new Set(row.redirectUris.map((u) => new URL(u).host))] }),
  });
  return {
    client_id: row.clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    ...(row.clientName ? { client_name: row.clientName } : {}),
    redirect_uris: row.redirectUris,
    token_endpoint_auth_method: method,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

// ---- 인가 요청 ----

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
}

const PARAM_MAX = 2000;
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/; // S256 결과(32바이트)의 base64url

/** 쿼리나 본문에서 문자열 파라미터만 꺼낸다(배열·객체는 버린다). */
export function pickAuthorizeParams(src: Record<string, unknown>): AuthorizeParams {
  const out: Record<string, string> = {};
  for (const k of ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource']) {
    const v = src[k];
    if (typeof v === 'string' && v.length <= PARAM_MAX) out[k] = v;
  }
  return out as AuthorizeParams;
}

export type AuthorizeCheck =
  /** 클라이언트나 redirect_uri를 믿을 수 없어 리다이렉트하면 안 된다(오픈 리다이렉트 방지) */
  | { ok: false; redirect: false; error: string; description: string }
  /** 오류지만 등록된 redirect_uri로 돌려보낸다 */
  | { ok: false; redirect: true; redirectUri: string; state?: string; error: string; description: string }
  | {
    ok: true;
    client: { id: number; clientId: string; clientName: string };
    redirectUri: string;
    scopes: string[];
    state?: string;
    codeChallenge: string;
    resource: string;
  };

export async function checkAuthorizeRequest(p: AuthorizeParams, origin: string): Promise<AuthorizeCheck> {
  if (!p.client_id) return { ok: false, redirect: false, error: 'invalid_request', description: 'client_id is required' };
  const client = await prisma.oAuthClient.findUnique({ where: { clientId: p.client_id } });
  if (!client) return { ok: false, redirect: false, error: 'invalid_client', description: 'Unknown client' };
  // 등록한 값과 정확히 같아야 한다. 하나만 등록했으면 생략할 수 있다.
  const redirectUri = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { ok: false, redirect: false, error: 'invalid_request', description: 'redirect_uri does not match a registered value' };
  }
  const fail = (error: string, description: string): AuthorizeCheck => ({ ok: false, redirect: true, redirectUri, state: p.state, error, description });
  if (p.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  if (!p.code_challenge || !CODE_CHALLENGE.test(p.code_challenge)) return fail('invalid_request', 'code_challenge is required (PKCE)');
  if (p.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
  const scopes = parseScopes(p.scope);
  if (!scopes) return fail('invalid_scope', 'Unknown scope');
  const resource = normalizeResource(p.resource, origin);
  if (!resource) return fail('invalid_target', 'resource must be this server\'s /mcp endpoint');
  if (!(await getAllowOAuthApps())) return fail('access_denied', 'OAuth apps are disabled by the workspace administrator');
  return {
    ok: true,
    client: { id: client.id, clientId: client.clientId, clientName: client.clientName },
    redirectUri, scopes, state: p.state, codeChallenge: p.code_challenge, resource,
  };
}

/** redirect_uri에 결과 파라미터를 붙인다. 기존 쿼리는 유지한다. iss는 RFC 9207(믹스업 공격 방지). */
export function buildRedirect(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * 동의하면 1회용 코드를 만든다. 동의 시점의 사용자 tokenVersion을 함께 둔다(교환 전에 비밀번호를 바꾸면 거부).
 * 오래된 코드는 스케줄러의 purgeOAuth가 지운다.
 */
export async function issueAuthorizationCode(input: {
  clientId: number; userId: number; redirectUri: string; scopes: string[]; resource: string; codeChallenge: string;
}): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: input.userId }, select: { tokenVersion: true } });
  const code = randomSecret();
  await prisma.oAuthAuthorizationCode.create({
    data: { ...input, tokenVersion: user.tokenVersion, codeHash: sha256(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  return code;
}

// ---- 클라이언트 인증(토큰·폐기 엔드포인트) ----

function safeEqualHex(expectedHex: string | null, actual: string): boolean {
  const expected = Buffer.from(expectedHex ?? '0'.repeat(64), 'hex');
  const got = Buffer.from(sha256(actual), 'hex');
  return expected.length === got.length && crypto.timingSafeEqual(expected, got) && expectedHex !== null;
}

/**
 * 요청에서 클라이언트 자격 증명을 꺼낸다(RFC 6749 2.3.1). Basic 헤더는 각 부분이 URL 인코딩돼 있다.
 * Basic 헤더가 깨졌으면 null. 인증(authenticateClient)과 rate limit 키(라우트)가 같은 파서를 쓴다.
 */
export function parseClientCredentials(
  authorization: string | undefined, body: Record<string, unknown>,
): { clientId?: string; secret?: string } | null {
  if (authorization?.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    try {
      return { clientId: decodeURIComponent(decoded.slice(0, idx)), secret: decodeURIComponent(decoded.slice(idx + 1)) };
    } catch {
      return null;
    }
  }
  return {
    clientId: typeof body.client_id === 'string' ? body.client_id : undefined,
    secret: typeof body.client_secret === 'string' ? body.client_secret : undefined,
  };
}

/**
 * Authorization: Basic 또는 본문(client_id, client_secret)으로 클라이언트를 확인한다.
 * 공개 클라이언트(none)는 client_id만, 기밀 클라이언트는 비밀이 맞아야 한다. 실패는 모두 invalid_client(401).
 */
export async function authenticateClient(authorization: string | undefined, body: Record<string, unknown>) {
  const creds = parseClientCredentials(authorization, body);
  if (!creds) throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  const { clientId, secret } = creds;
  if (!clientId || clientId.length > 64) throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client) throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  if (client.tokenEndpointAuthMethod === 'none') {
    if (secret) throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    return client;
  }
  const secretOk = !!secret && secret.startsWith(CLIENT_SECRET_PREFIX)
    && SECRET_PATTERN.test(secret.slice(CLIENT_SECRET_PREFIX.length)) && safeEqualHex(client.clientSecretHash, secret);
  if (!secretOk) throw new OAuthError('invalid_client', 'Client authentication failed', 401);
  return client;
}

// ---- 토큰 발급 ----

interface IssueInput {
  familyId: string; familyCreatedAt: Date; clientId: number; userId: number; scopes: string[]; resource: string; tokenVersion: number;
}

async function issueTokenPair(tx: Pick<typeof prisma, 'oAuthToken' | 'oAuthClient'>, input: IssueInput) {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomSecret()}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomSecret()}`;
  const now = Date.now();
  // 첫 발급 때만 쓴다(정리 작업은 "한 번도 받지 않음"만 본다). 발급마다 같은 행을 갱신하지 않게.
  await tx.oAuthClient.updateMany({ where: { id: input.clientId, lastIssuedAt: null }, data: { lastIssuedAt: new Date(now) } });
  await tx.oAuthToken.create({
    data: {
      ...input,
      accessTokenHash: sha256(accessToken),
      refreshTokenHash: sha256(refreshToken),
      accessExpiresAt: new Date(now + ACCESS_TOKEN_TTL_SEC * 1000),
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
    },
  });
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshToken,
    scope: input.scopes.join(' '),
  };
}

async function revokeFamily(familyId: string): Promise<number> {
  const { count } = await prisma.oAuthToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
  return count;
}

/** 토큰을 줄 수 있는 사용자인지: 활성, 조직 정책 허용, 2FA 필수 정책이면 등록 완료. */
async function loadEligibleUser(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId }, select: { id: true, tokenVersion: true, deactivatedAt: true, mfaEnabledAt: true },
  });
  if (!user || user.deactivatedAt) return null;
  if (!(await getAllowOAuthApps())) return null;
  if (!user.mfaEnabledAt && (await isMfaPolicyEnforced())) return null;
  return user;
}

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

/** 이미 쓴 코드가 다시 왔다: 가로챈 코드일 수 있으니 그 코드로 만든 토큰 계열을 모두 폐기한다. */
async function handleCodeReuse(codeId: number): Promise<void> {
  // 승자의 claim과 토큰 삽입은 한 트랜잭션이다. 여기 오는 것은 승자가 커밋한 뒤(행 잠금이 풀린 뒤 조건이 거짓이 된 경우)이므로
  // 승자의 familyId와 토큰이 이미 보이고, 폐기에서 빠지지 않는다.
  const row = await prisma.oAuthAuthorizationCode.findUnique({ where: { id: codeId }, select: { familyId: true, userId: true, clientId: true } });
  if (!row) return; // 연결 해제나 정책 끄기로 지워진 코드
  const revoked = row.familyId ? await revokeFamily(row.familyId) : 0;
  void writeAuditLog({
    action: 'oauth.code_reuse_detected', actorId: row.userId, targetType: 'oauth_client', targetId: row.clientId,
    details: JSON.stringify({ revoked }),
  });
}

export async function exchangeAuthorizationCode(
  client: { id: number }, body: Record<string, unknown>, origin: string,
) {
  const code = typeof body.code === 'string' ? body.code : '';
  const verifier = typeof body.code_verifier === 'string' ? body.code_verifier : '';
  const redirectUri = typeof body.redirect_uri === 'string' ? body.redirect_uri : undefined;
  if (!code || !SECRET_PATTERN.test(code)) throw new OAuthError('invalid_grant', 'Invalid authorization code');
  if (!VERIFIER.test(verifier)) throw new OAuthError('invalid_request', 'code_verifier is required (PKCE)');

  const row = await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash: sha256(code) } });
  if (!row || row.clientId !== client.id) throw new OAuthError('invalid_grant', 'Invalid authorization code');

  // 검증을 먼저 한다. 코드는 소모하지 않으므로 검증자(code_verifier)를 모르는 쪽은 코드를 태우거나
  // 재사용 탐지(계열 폐기)를 일으킬 수 없다.
  if (!pkceMatches(verifier, row.codeChallenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
  // 보냈으면 인가 요청 때와 같아야 한다. 생략은 PKCE가 코드를 묶어 주므로 받는다(OAuth 2.1)
  if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match');
  if (body.resource !== undefined) {
    const resource = typeof body.resource === 'string' ? normalizeResource(body.resource, origin) : null;
    if (resource !== row.resource) throw new OAuthError('invalid_target', 'resource does not match the authorization request');
  }
  if (row.usedAt) {
    await handleCodeReuse(row.id);
    throw new OAuthError('invalid_grant', 'Invalid authorization code');
  }
  if (row.expiresAt.getTime() <= Date.now()) throw new OAuthError('invalid_grant', 'Authorization code expired');

  const user = await loadEligibleUser(row.userId);
  // 동의한 뒤 비밀번호 변경·2FA 변경·강제 로그아웃이 있었으면 그 동의로 토큰을 주지 않는다
  if (!user || user.tokenVersion !== row.tokenVersion) throw new OAuthError('invalid_grant', 'The authorization is no longer valid');

  // 1회용: 조건부 claim(usedAt null)과 토큰 삽입을 한 트랜잭션으로. 동시에 두 번 오면 하나만 통과한다.
  const familyId = crypto.randomBytes(16).toString('hex');
  const familyCreatedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    if (!(await lockPolicyForIssue(tx))) return 'disabled' as const;
    const claimed = await tx.oAuthAuthorizationCode.updateMany({
      where: { id: row.id, usedAt: null }, data: { usedAt: familyCreatedAt, familyId },
    });
    if (claimed.count === 0) return null;
    return issueTokenPair(tx, {
      familyId, familyCreatedAt, clientId: client.id, userId: user.id, scopes: row.scopes, resource: row.resource,
      tokenVersion: user.tokenVersion,
    });
  });
  if (result === 'disabled') throw new OAuthError('invalid_grant', 'The authorization is no longer valid');
  if (!result) {
    await handleCodeReuse(row.id);
    throw new OAuthError('invalid_grant', 'Invalid authorization code');
  }
  return result;
}

export async function refreshAccessToken(client: { id: number }, body: Record<string, unknown>, origin: string) {
  const token = typeof body.refresh_token === 'string' ? body.refresh_token : '';
  if (!token.startsWith(REFRESH_TOKEN_PREFIX) || !SECRET_PATTERN.test(token.slice(REFRESH_TOKEN_PREFIX.length))) {
    throw new OAuthError('invalid_grant', 'Invalid refresh token');
  }
  const row = await prisma.oAuthToken.findUnique({ where: { refreshTokenHash: sha256(token) } });
  if (!row || row.clientId !== client.id) throw new OAuthError('invalid_grant', 'Invalid refresh token');

  const reuse = async () => {
    const revoked = await revokeFamily(row.familyId);
    void writeAuditLog({
      action: 'oauth.refresh_reuse_detected', actorId: row.userId, targetType: 'oauth_client', targetId: row.clientId,
      details: JSON.stringify({ tokenId: row.id, revoked }),
    });
    return new OAuthError('invalid_grant', 'Invalid refresh token');
  };
  // 이미 폐기된 계열(연결 해제, 정책 끄기, 앞선 재사용 탐지)의 토큰은 회전된 것이어도 재사용 이벤트를 남기지 않는다
  if (row.revokedAt) throw new OAuthError('invalid_grant', 'Invalid refresh token');
  // 살아 있는 계열의 이미 회전된 리프레시 토큰이 다시 왔다(RFC 9700 4.14.2): 계열 전체를 폐기한다
  if (row.rotatedAt) throw await reuse();
  if (!row.refreshExpiresAt || row.refreshExpiresAt.getTime() <= Date.now()) throw new OAuthError('invalid_grant', 'Refresh token expired');

  let scopes = row.scopes;
  if (typeof body.scope === 'string' && body.scope.trim() !== '') {
    const requested = parseScopes(body.scope);
    // 줄이는 것만 된다(RFC 6749 6)
    if (!requested || requested.some((s) => !row.scopes.includes(s))) throw new OAuthError('invalid_scope', 'Scope exceeds the original grant');
    scopes = requested;
  }
  if (body.resource !== undefined) {
    const resource = typeof body.resource === 'string' ? normalizeResource(body.resource, origin) : null;
    if (resource !== row.resource) throw new OAuthError('invalid_target', 'resource does not match the original grant');
  }

  const user = await loadEligibleUser(row.userId);
  if (!user || user.tokenVersion !== row.tokenVersion) throw new OAuthError('invalid_grant', 'The authorization is no longer valid');

  // 회전: 옛 행에 rotatedAt을 찍는 것과 새 행을 만드는 것을 한 트랜잭션으로. 동시에 두 번 오면 하나만 통과하고 나머지는 재사용으로 본다.
  const result = await prisma.$transaction(async (tx) => {
    if (!(await lockPolicyForIssue(tx))) return 'disabled' as const;
    const claimed = await tx.oAuthToken.updateMany({ where: { id: row.id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: new Date() } });
    if (claimed.count === 0) return null;
    return issueTokenPair(tx, {
      familyId: row.familyId, familyCreatedAt: row.familyCreatedAt, clientId: client.id, userId: user.id, scopes,
      resource: row.resource, tokenVersion: user.tokenVersion,
    });
  });
  if (result === 'disabled') throw new OAuthError('invalid_grant', 'The authorization is no longer valid');
  if (!result) {
    // claim 실패: 그 사이에 폐기됐으면(연결 해제·정책 끄기) 재사용이 아니다. 동시에 회전된 경우만 재사용으로 본다.
    const now = await prisma.oAuthToken.findUnique({ where: { id: row.id }, select: { revokedAt: true } });
    if (!now || now.revokedAt) throw new OAuthError('invalid_grant', 'Invalid refresh token');
    throw await reuse();
  }
  return result;
}

/** RFC 7009. 이 클라이언트의 토큰이면 계열(연결) 전체를 폐기한다. 없는 토큰도 성공으로 답한다(존재 여부를 알려 주지 않는다). */
export async function revokeToken(client: { id: number }, body: Record<string, unknown>): Promise<void> {
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token || token.length > 200) return;
  const hash = sha256(token);
  const row = token.startsWith(REFRESH_TOKEN_PREFIX)
    ? await prisma.oAuthToken.findUnique({ where: { refreshTokenHash: hash } })
    : await prisma.oAuthToken.findUnique({ where: { accessTokenHash: hash } });
  if (!row || row.clientId !== client.id) return;
  const revoked = await revokeFamily(row.familyId);
  if (revoked > 0) {
    void writeAuditLog({
      action: 'oauth.token_revoked', actorId: row.userId, targetType: 'oauth_client', targetId: row.clientId,
      details: JSON.stringify({ via: 'client', revoked }),
    });
  }
}

// ---- /mcp에서 액세스 토큰 확인 ----

export interface VerifiedOAuthToken {
  tokenId: number;
  familyId: string;
  clientId: number;
  userId: number;
  role: string;
  scopes: string[];
  mfaEnabled: boolean;
}

export const looksLikeOAuthAccessToken = (token: string) => token.startsWith(ACCESS_TOKEN_PREFIX);

/** 실패 중 unknown은 형식이 틀리거나 DB에 없는 토큰(추측 시도)이다. 만료·폐기·회전된 알려진 토큰과 구분해 IP 실패 횟수에만 쓴다. */
export type OAuthTokenCheck = { ok: true; token: VerifiedOAuthToken } | { ok: false; unknown: boolean };

/**
 * 액세스 토큰 확인. 폐기, 회전(리프레시로 바뀜), 만료, 리소스 불일치, 비활성 사용자, tokenVersion 변경, 조직 정책 꺼짐은 모두 실패다.
 * 실패 이유는 밖으로 알리지 않는다. 2FA 필수 정책은 호출한 쪽이 mfaEnabled로 따로 판단한다(PAT와 같은 403 응답을 주려고).
 */
export async function checkOAuthAccessToken(token: string, configured: string | null): Promise<OAuthTokenCheck> {
  if (!looksLikeOAuthAccessToken(token) || !SECRET_PATTERN.test(token.slice(ACCESS_TOKEN_PREFIX.length))) return { ok: false, unknown: true };
  const row = await prisma.oAuthToken.findUnique({
    where: { accessTokenHash: sha256(token) },
    include: { user: { select: { role: true, deactivatedAt: true, mfaEnabledAt: true, tokenVersion: true } } },
  });
  if (!row) return { ok: false, unknown: true };
  const fail = { ok: false, unknown: false } as const;
  const now = Date.now();
  // 리프레시하면 옛 액세스 토큰은 바로 쓸 수 없다
  if (row.revokedAt || row.rotatedAt || row.accessExpiresAt.getTime() <= now) return fail;
  // audience 확인: 이 서버의 /mcp용으로 발급한 토큰만 받는다(다른 리소스용 토큰을 넘겨받아 쓰는 것을 막는다).
  // 요청 Host가 아니라 서버의 정식 resource(PUBLIC_URL)와 비교한다. 개발 환경 규칙은 audienceMatches 참고.
  if (!audienceMatches(row.resource, configured)) return fail;
  if (row.user.deactivatedAt || row.user.tokenVersion !== row.tokenVersion) return fail;
  if (!(await getAllowOAuthApps())) return fail;

  if (shouldWriteLastUsed(row.lastUsedAt, now)) {
    await prisma.oAuthToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })
      .catch((err) => logError('Update OAuth token lastUsedAt failed', err));
  }
  return {
    ok: true,
    token: {
      tokenId: row.id, familyId: row.familyId, clientId: row.clientId, userId: row.userId, role: row.user.role,
      scopes: row.scopes, mfaEnabled: row.user.mfaEnabledAt !== null,
    },
  };
}

// ---- 사용자 설정: 연결된 앱 ----

/**
 * 목록에 보이는 살아 있는 토큰 행: 폐기·회전되지 않았고 리프레시 수명이 남았다.
 * 리프레시 토큰은 항상 액세스 토큰보다 늦게 끝나므로 리프레시 만료만 보면 된다.
 */
function liveTokenWhere(now: Date) {
  return { revokedAt: null, rotatedAt: null, refreshExpiresAt: { gt: now } };
}

/** 살아 있는 연결(폐기 안 됨, 리프레시나 액세스가 아직 유효)을 클라이언트별로 묶는다. */
export async function listConnectedApps(userId: number) {
  const rows = await prisma.oAuthToken.findMany({
    where: { userId, ...liveTokenWhere(new Date()) },
    include: { client: { select: { id: true, clientName: true, redirectUris: true } } },
    orderBy: { id: 'desc' },
  });
  const byClient = new Map<number, {
    id: number; name: string; redirectHosts: string[]; scopes: Set<string>; connectedAt: Date | null; lastUsedAt: Date | null;
  }>();
  for (const r of rows) {
    let entry = byClient.get(r.clientId);
    if (!entry) {
      entry = {
        id: r.client.id, name: r.client.clientName, redirectHosts: [...new Set(r.client.redirectUris.map((u) => new URL(u).host))],
        scopes: new Set(), connectedAt: null, lastUsedAt: null,
      };
      byClient.set(r.clientId, entry);
    }
    r.scopes.forEach((s) => entry!.scopes.add(s));
    // 연결한 때: 계열 첫 발급 시각(행마다 복사돼 있어 옛 행을 지워도 남는다)
    if (!entry.connectedAt || r.familyCreatedAt < entry.connectedAt) entry.connectedAt = r.familyCreatedAt;
    if (r.lastUsedAt && (!entry.lastUsedAt || r.lastUsedAt > entry.lastUsedAt)) entry.lastUsedAt = r.lastUsedAt;
  }
  return [...byClient.values()].map((e) => ({
    id: e.id, name: e.name, redirectHosts: e.redirectHosts,
    scopes: ALLOWED_SCOPES.filter((s) => e.scopes.has(s)), connectedAt: e.connectedAt, lastUsedAt: e.lastUsedAt,
  }));
}

/**
 * 이 사용자가 이 클라이언트에 준 모든 연결을 끊는다. 아직 교환하지 않은 코드도 지운다.
 * 돌려주는 값은 목록에 보이던 살아 있는 토큰 수와 지운 코드 수다. 둘 다 0이면 끊을 것이 없었다(라우트가 404).
 * 목록에 안 보이는 회전·만료 행도 함께 폐기하지만 세지는 않는다.
 */
export async function disconnectApp(userId: number, clientId: number): Promise<{ tokens: number; codes: number }> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const live = await tx.oAuthToken.updateMany({ where: { userId, clientId, ...liveTokenWhere(now) }, data: { revokedAt: now } });
    await tx.oAuthToken.updateMany({ where: { userId, clientId, revokedAt: null }, data: { revokedAt: now } });
    const codes = await tx.oAuthAuthorizationCode.deleteMany({ where: { userId, clientId, usedAt: null } });
    return { tokens: live.count, codes: codes.count };
  });
}

// ---- 정리(스케줄러) ----

/**
 * 더 이상 쓸 일이 없는 행을 지운다.
 * - 토큰: 리프레시 수명이 지난 행(회전·폐기 여부와 상관없이), 폐기된 지 하루 지난 행. 회전됐지만 수명이 남은 행은 재사용 탐지에 필요해 둔다.
 * - 코드: 만료된 지 하루 지난 행(쓴 코드는 만료 전까지 재사용 탐지에 필요하다).
 * - 클라이언트: 토큰을 한 번도 받지 않았고 등록한 지 30일 지난 행.
 */
export async function purgeOAuth(now: Date = new Date()): Promise<{ tokens: number; codes: number; clients: number }> {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const tokens = await prisma.oAuthToken.deleteMany({
    where: {
      OR: [
        { refreshExpiresAt: { lt: now } },
        { refreshExpiresAt: null, accessExpiresAt: { lt: now } },
        { revokedAt: { lt: dayAgo } },
      ],
    },
  });
  const codes = await prisma.oAuthAuthorizationCode.deleteMany({ where: { expiresAt: { lt: dayAgo } } });
  const clients = await prisma.oAuthClient.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - UNUSED_CLIENT_TTL_MS) }, lastIssuedAt: null, tokens: { none: {} } },
  });
  return { tokens: tokens.count, codes: codes.count, clients: clients.count };
}
