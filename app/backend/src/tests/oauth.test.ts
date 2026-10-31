import { TEST_PASSWORD } from './test-constants.js';
import crypto from 'crypto';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app from '../app.js';
import prisma from '../db.js';
import { hashSecret } from '../services/accessTokenService.js';
import express from 'express';
import { isAllowedRedirectUri, purgeOAuth } from '../services/oauthService.js';
import { createOAuthBrowserLimiter, createOAuthTokenLimiters } from '../routes/oauth.js';
import { createMcpAuthFailureLimiter } from '../mcp/rateLimit.js';
import { accessTokenAuth } from '../middleware/accessTokenAuth.js';
import mcpRoutes from '../routes/mcp.js';

// OAuth 2.1 인가 서버(mcp-4): 메타데이터, 동적 등록, 동의, 코드 교환(PKCE), /mcp 호출, 리프레시 회전과 재사용 탐지,
// 폐기, 연결된 앱, 조직 정책, tokenVersion·비활성·2FA 필수에 따른 무효화.
// 출처는 PUBLIC_URL로 고정한다(supertest는 요청마다 포트가 바뀌어 Host로 정하면 리소스가 매번 달라진다).

const ORIGIN = 'http://localhost:3999';
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';
const MCP_ACCEPT = { Accept: 'application/json, text/event-stream' };
const KEY_HEX = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16) + 'd'.repeat(16);

interface TestUser { id: number; token: string }
interface TokenSet { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string }

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(name: string): Promise<TestUser> {
  const res = await request(app).post('/auth/register')
    .send({ email: `${name.toLowerCase()}-oauth@example.com`, password: TEST_PASSWORD, name });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, token: res.body.token };
}

async function registerClient(body: object = {}) {
  return request(app).post('/oauth/register').send({
    client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...body,
  });
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', scope: 'channels:read channels:history chat:write', state: 'st-123', resource: RESOURCE,
    ...extra,
  };
}

/** 동의 화면이 하는 일: details 확인 → 허용. 받은 code를 돌려준다. */
async function approve(user: TestUser, params: Record<string, string>): Promise<string> {
  const res = await request(app).post('/oauth/authorize/decision').set(auth(user)).send({ params, approve: true });
  expect(res.status).toBe(200);
  const url = new URL(res.body.redirectTo);
  expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
  expect(url.searchParams.get('state')).toBe(params.state);
  expect(url.searchParams.get('iss')).toBe(ORIGIN);
  return url.searchParams.get('code')!;
}

function tokenRequest(form: Record<string, string>, basic?: string) {
  const req = request(app).post('/oauth/token').type('form');
  if (basic) req.set('Authorization', `Basic ${basic}`);
  return req.send(form);
}

function rpc(token: string | null, method = 'tools/list', params: object = {}) {
  const req = request(app).post('/mcp').set(MCP_ACCEPT);
  if (token) req.set(bearer(token));
  return req.send({ jsonrpc: '2.0', id: 1, method, params });
}

describe('OAuth 2.1 authorization server (mcp-4)', () => {
  const savedPublicUrl = process.env.PUBLIC_URL;
  const savedKey = process.env.TOTP_ENCRYPTION_KEY;
  let alice: TestUser, bob: TestUser, carol: TestUser, admin: TestUser;
  let clientId: string;
  let clientRowId: number;
  const rawSecrets: string[] = [];

  /** 등록부터 토큰까지 한 번에 */
  async function fullGrant(user: TestUser, scope = 'channels:read channels:history chat:write'): Promise<TokenSet> {
    const { verifier, challenge } = pkce();
    const code = await approve(user, authorizeParams(clientId, challenge, { scope }));
    rawSecrets.push(code);
    const res = await tokenRequest({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId, resource: RESOURCE,
    });
    expect(res.status).toBe(200);
    rawSecrets.push(res.body.access_token, res.body.refresh_token);
    return res.body;
  }

  beforeAll(async () => {
    process.env.PUBLIC_URL = ORIGIN;
    await prisma.workspaceSetting.deleteMany();
    await prisma.oAuthClient.deleteMany();
    alice = await register('Alice');
    bob = await register('Bob');
    carol = await register('Carol');
    admin = await register('Admin');
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  });

  afterAll(async () => {
    if (savedPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = savedPublicUrl;
    if (savedKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
    else process.env.TOTP_ENCRYPTION_KEY = savedKey;
    await prisma.workspaceSetting.deleteMany();
  });

  describe('metadata and discovery', () => {
    it('serves authorization server metadata (RFC 8414)', async () => {
      const res = await request(app).get('/.well-known/oauth-authorization-server');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        registration_endpoint: `${ORIGIN}/oauth/register`,
        revocation_endpoint: `${ORIGIN}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      });
      expect(res.body.scopes_supported).toContain('chat:write');
    });

    it('serves protected resource metadata (RFC 9728) at the path-specific and root URLs', async () => {
      for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
        const res = await request(app).get(path);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN], bearer_methods_supported: ['header'] });
      }
    });

    it('/mcp 401 points to the resource metadata in WWW-Authenticate', async () => {
      const none = await rpc(null);
      expect(none.status).toBe(401);
      expect(none.headers['www-authenticate']).toBe(
        `Bearer realm="mcp", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      );
      const bad = await rpc('scoat_' + 'x'.repeat(43));
      expect(bad.status).toBe(401);
      expect(bad.headers['www-authenticate']).toContain('resource_metadata=');
      expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
    });
  });

  describe('dynamic client registration (RFC 7591)', () => {
    it('registers a public client and stores no secret', async () => {
      const res = await registerClient();
      expect(res.status).toBe(201);
      expect(res.body.client_id).toMatch(/^scoc_[0-9a-f]{32}$/);
      expect(res.body.client_secret).toBeUndefined();
      expect(res.body).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
      clientId = res.body.client_id;
      const row = await prisma.oAuthClient.findUniqueOrThrow({ where: { clientId } });
      clientRowId = row.id;
      expect(row.clientSecretHash).toBeNull();

      const log = await prisma.auditLog.findFirst({ where: { action: 'oauth.client_registered', targetId: row.id } });
      expect(log).not.toBeNull();
      expect(JSON.parse(log!.details!)).toEqual({ authMethod: 'none', redirectHosts: ['127.0.0.1:33418'] });
    });

    it('registers a confidential client by default and keeps only the secret hash', async () => {
      const res = await request(app).post('/oauth/register').send({ client_name: 'Server app', redirect_uris: ['https://app.example.com/cb'] });
      expect(res.status).toBe(201);
      expect(res.body.token_endpoint_auth_method).toBe('client_secret_basic');
      expect(res.body.client_secret).toMatch(/^scocs_[A-Za-z0-9_-]{43}$/);
      rawSecrets.push(res.body.client_secret);
      const row = await prisma.oAuthClient.findUniqueOrThrow({ where: { clientId: res.body.client_id } });
      expect(row.clientSecretHash).toBe(hashSecret(res.body.client_secret));
      expect(JSON.stringify(row)).not.toContain(res.body.client_secret);
    });

    it('rejects redirect URIs that are not https or loopback http', async () => {
      for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://app.example.com/cb#frag', 'ftp://x/y',
        'https://user:pw@app.example.com/cb', 'myapp://cb', 'not a url']) {
        const res = await registerClient({ redirect_uris: [uri] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_redirect_uri');
        expect(typeof res.body.error_description).toBe('string');
      }
      expect((await registerClient({ redirect_uris: [] })).status).toBe(400);
      expect((await registerClient({ token_endpoint_auth_method: 'private_key_jwt' })).body.error).toBe('invalid_client_metadata');
      expect((await registerClient({ grant_types: ['client_credentials'] })).body.error).toBe('invalid_client_metadata');
      expect(isAllowedRedirectUri('http://localhost:8080/cb')).toBe(true);
      expect(isAllowedRedirectUri('http://[::1]:8080/cb')).toBe(true);
      expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
      expect(isAllowedRedirectUri('http://localhost.evil.example/cb')).toBe(false);
    });
  });

  describe('authorization request', () => {
    it('does not redirect when the client or redirect_uri is unknown', async () => {
      const { challenge } = pkce();
      const unknown = await request(app).get('/oauth/authorize').query(authorizeParams('scoc_nope', challenge));
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toBe('invalid_client');
      expect(unknown.headers.location).toBeUndefined();
      const wrongRedirect = await request(app).get('/oauth/authorize')
        .query(authorizeParams(clientId, challenge, { redirect_uri: 'https://evil.example/cb' }));
      expect(wrongRedirect.status).toBe(400);
      expect(wrongRedirect.headers.location).toBeUndefined();
    });

    it('redirects protocol errors back to the client with state and iss', async () => {
      const { challenge } = pkce();
      const cases: Array<[Record<string, string>, string]> = [
        [{ code_challenge: '' }, 'invalid_request'],
        [{ code_challenge_method: 'plain' }, 'invalid_request'],
        [{ response_type: 'token' }, 'unsupported_response_type'],
        [{ scope: 'admin:all' }, 'invalid_scope'],
        [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
      ];
      for (const [extra, error] of cases) {
        const res = await request(app).get('/oauth/authorize').query(authorizeParams(clientId, challenge, extra));
        expect(res.status).toBe(302);
        const loc = new URL(res.headers.location);
        expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
        expect(loc.searchParams.get('error')).toBe(error);
        expect(loc.searchParams.get('state')).toBe('st-123');
        expect(loc.searchParams.get('iss')).toBe(ORIGIN);
      }
    });

    it('sends a valid request to the consent screen, which shows the client and redirect host', async () => {
      const { challenge } = pkce();
      const params = authorizeParams(clientId, challenge);
      const res = await request(app).get('/oauth/authorize').query(params);
      expect(res.status).toBe(302);
      expect(res.headers.location).toMatch(/^\/oauth-consent\?/);
      const forwarded = Object.fromEntries(new URLSearchParams(res.headers.location.split('?')[1]));
      expect(forwarded).toMatchObject({ client_id: clientId, redirect_uri: REDIRECT, state: 'st-123', resource: RESOURCE });

      expect((await request(app).get('/oauth/authorize/details').query(forwarded)).status).toBe(401);
      const details = await request(app).get('/oauth/authorize/details').set(auth(alice)).query(forwarded);
      expect(details.status).toBe(200);
      expect(details.body).toEqual({
        client: { name: 'Claude', clientId, redirectUri: REDIRECT, redirectHost: '127.0.0.1:33418', loopback: true },
        scopes: ['channels:read', 'channels:history', 'chat:write'],
        mfaRequired: false,
      });

      const bad = await request(app).get('/oauth/authorize/details').set(auth(alice)).query({ ...forwarded, scope: 'nope' });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('OAUTH_INVALID_REQUEST');
      expect(new URL(bad.body.redirectTo).searchParams.get('error')).toBe('invalid_scope');
    });

    it('deny returns access_denied to the client and issues no code', async () => {
      const { challenge } = pkce();
      const before = await prisma.oAuthAuthorizationCode.count();
      const res = await request(app).post('/oauth/authorize/decision').set(auth(alice))
        .send({ params: authorizeParams(clientId, challenge), approve: false });
      expect(res.status).toBe(200);
      const loc = new URL(res.body.redirectTo);
      expect(loc.searchParams.get('error')).toBe('access_denied');
      expect(loc.searchParams.get('code')).toBeNull();
      expect(await prisma.oAuthAuthorizationCode.count()).toBe(before);
    });
  });

  describe('token endpoint, /mcp, refresh rotation and revocation (CRUD loop)', () => {
    it('exchanges a code with PKCE, calls /mcp tools, and never stores raw values', async () => {
      const { verifier, challenge } = pkce();
      const code = await approve(alice, authorizeParams(clientId, challenge));
      rawSecrets.push(code);
      const codeRow = await prisma.oAuthAuthorizationCode.findUniqueOrThrow({ where: { codeHash: hashSecret(code) } });
      expect(codeRow.expiresAt.getTime() - codeRow.createdAt.getTime()).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);

      // 틀린 verifier: 실패하지만 코드는 소모되지 않는다(검증자를 모르면 코드를 태울 수 없다)
      const wrong = await tokenRequest({
        grant_type: 'authorization_code', code, code_verifier: pkce().verifier, redirect_uri: REDIRECT, client_id: clientId,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject({ error: 'invalid_grant' });
      expect(wrong.headers['cache-control']).toBe('no-store');
      const again = await tokenRequest({
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId,
      });
      expect(again.status).toBe(200);
      rawSecrets.push(again.body.access_token, again.body.refresh_token);

      // Create: 새 동의 → 토큰
      const tokens = await fullGrant(alice);
      expect(tokens.access_token).toMatch(/^scoat_[A-Za-z0-9_-]{43}$/);
      expect(tokens.refresh_token).toMatch(/^scort_[A-Za-z0-9_-]{43}$/);
      expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'channels:read channels:history chat:write' });
      const row = await prisma.oAuthToken.findUniqueOrThrow({ where: { accessTokenHash: hashSecret(tokens.access_token) } });
      expect(row.refreshTokenHash).toBe(hashSecret(tokens.refresh_token));
      expect(row.resource).toBe(RESOURCE);
      expect(JSON.stringify(row)).not.toContain(tokens.access_token.slice(6));

      // Read: /mcp 도구 목록은 허용한 범위만
      const list = await rpc(tokens.access_token);
      expect(list.status).toBe(200);
      const names = (list.body.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['list_channels', 'read_channel', 'send_message']));
      expect(names).not.toContain('send_dm');
      expect(names).not.toContain('add_reaction');
    });

    it('works end-to-end with the MCP SDK client: read, write, edit, delete as the token owner', async () => {
      const tokens = await fullGrant(alice);
      const channelId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'oauth-crud' })).body.id;
      const bobSecret = (await request(app).post('/channels').set(auth(bob)).send({ name: 'oauth-bob-secret', isPrivate: true })).body.id;

      const httpServer = createServer(app);
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
      const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
      const client = new Client({ name: 'jest-oauth', version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: bearer(tokens.access_token) } }));
        const call = async (name: string, args: Record<string, unknown>) => {
          const r = await client.callTool({ name, arguments: args });
          const text = (r.content as Array<{ text: string }>)[0].text;
          return { isError: r.isError === true, data: r.isError ? text : JSON.parse(text) };
        };
        const sent = await call('send_message', { channelId, content: 'hello from oauth' });
        expect(sent.isError).toBe(false);
        const read = await call('read_channel', { channelId });
        expect(read.data.messages.map((m: { content: string }) => m.content)).toContain('hello from oauth');
        expect((await call('edit_message', { messageId: sent.data.id, content: 'edited via oauth' })).isError).toBe(false);
        expect((await call('delete_message', { messageId: sent.data.id })).isError).toBe(false);
        // 남의 비공개 채널은 OAuth로도 못 읽는다
        expect((await call('read_channel', { channelId: bobSecret })).isError).toBe(true);

        const log = await prisma.auditLog.findFirst({ where: { action: 'mcp.tool_call', targetName: 'send_message' }, orderBy: { id: 'desc' } });
        expect(JSON.parse(log!.details!)).toMatchObject({ via: 'mcp', tokenKind: 'oauth', oauthClientId: clientRowId, ok: true });
      } finally {
        await client.close().catch(() => {});
        await new Promise((r) => httpServer.close(r));
      }
    });

    it('rotates refresh tokens and revokes the whole family when an old one is reused', async () => {
      const first = await fullGrant(alice);
      // Update: 리프레시 → 새 쌍. 옛 액세스 토큰은 바로 무효가 된다.
      const r1 = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
      expect(r1.status).toBe(200);
      rawSecrets.push(r1.body.access_token, r1.body.refresh_token);
      expect(r1.body.refresh_token).not.toBe(first.refresh_token);
      expect((await rpc(r1.body.access_token)).status).toBe(200);
      expect((await rpc(first.access_token)).status).toBe(401);

      // 범위는 줄이기만 된다
      const widen = await tokenRequest({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: clientId, scope: 'im:write' });
      expect(widen.body.error).toBe('invalid_scope');

      // 다른 클라이언트로는 못 쓴다
      const other = (await registerClient({ client_name: 'Other' })).body.client_id;
      const stolen = await tokenRequest({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: other });
      expect(stolen.body.error).toBe('invalid_grant');

      // 이미 쓴 리프레시 토큰을 다시 보냄 → 재사용 탐지, 계열 전체 폐기
      const reuse = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
      expect(reuse.status).toBe(400);
      expect(reuse.body.error).toBe('invalid_grant');
      expect((await rpc(r1.body.access_token)).status).toBe(401);
      expect((await rpc(first.access_token)).status).toBe(401);
      const r2 = await tokenRequest({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: clientId });
      expect(r2.body.error).toBe('invalid_grant');

      const log = await prisma.auditLog.findFirst({ where: { action: 'oauth.refresh_reuse_detected' }, orderBy: { id: 'desc' } });
      expect(log).toMatchObject({ actorId: alice.id, targetType: 'oauth_client', targetId: clientRowId });
    });

    it('revokes the family when an authorization code is replayed', async () => {
      const { verifier, challenge } = pkce();
      const code = await approve(alice, authorizeParams(clientId, challenge));
      rawSecrets.push(code);
      const form = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId };
      const ok = await tokenRequest(form);
      expect(ok.status).toBe(200);
      rawSecrets.push(ok.body.access_token, ok.body.refresh_token);
      expect((await rpc(ok.body.access_token)).status).toBe(200);
      const replay = await tokenRequest(form);
      expect(replay.body.error).toBe('invalid_grant');
      expect((await rpc(ok.body.access_token)).status).toBe(401);
    });

    it('revocation endpoint (RFC 7009) kills the connection; unknown tokens still get 200', async () => {
      const tokens = await fullGrant(alice);
      expect((await request(app).post('/oauth/revoke').type('form').send({ token: 'scort_unknown', client_id: clientId })).status).toBe(200);
      const res = await request(app).post('/oauth/revoke').type('form').send({ token: tokens.refresh_token, client_id: clientId });
      expect(res.status).toBe(200);
      expect((await rpc(tokens.access_token)).status).toBe(401);
      const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
      expect(refresh.body.error).toBe('invalid_grant');
      const log = await prisma.auditLog.findFirst({ where: { action: 'oauth.token_revoked' }, orderBy: { id: 'desc' } });
      expect(JSON.parse(log!.details!)).toMatchObject({ via: 'client' });
    });

    it('rejects unsupported grants, bad client auth and mismatched resource', async () => {
      expect((await tokenRequest({ grant_type: 'password', client_id: clientId })).body.error).toBe('unsupported_grant_type');
      const noClient = await tokenRequest({ grant_type: 'authorization_code', code: 'x' });
      expect(noClient.status).toBe(401);
      expect(noClient.body.error).toBe('invalid_client');

      const { verifier, challenge } = pkce();
      const code = await approve(alice, authorizeParams(clientId, challenge));
      rawSecrets.push(code);
      const res = await tokenRequest({
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId,
        resource: 'https://other.example/mcp',
      });
      expect(res.body.error).toBe('invalid_target');
    });

    it('confidential clients must authenticate with their secret', async () => {
      const reg = await registerClient({ token_endpoint_auth_method: 'client_secret_basic', client_name: 'Secret app' });
      const { client_id: cid, client_secret: secret } = reg.body;
      rawSecrets.push(secret);
      const { verifier, challenge } = pkce();
      const code = await approve(alice, authorizeParams(cid, challenge));
      rawSecrets.push(code);
      const form = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT };
      const missing = await tokenRequest({ ...form, client_id: cid });
      expect(missing.status).toBe(401);
      expect(missing.headers['www-authenticate']).toContain('Basic');
      const wrongSecret = await tokenRequest(form, Buffer.from(`${cid}:scocs_${'A'.repeat(43)}`).toString('base64'));
      expect(wrongSecret.status).toBe(401);
      const ok = await tokenRequest(form, Buffer.from(`${cid}:${secret}`).toString('base64'));
      expect(ok.status).toBe(200);
      rawSecrets.push(ok.body.access_token, ok.body.refresh_token);
    });

    it('binds tokens to the /mcp resource of this server (audience)', async () => {
      const tokens = await fullGrant(alice);
      process.env.PUBLIC_URL = 'http://other-host:4000';
      try {
        expect((await rpc(tokens.access_token)).status).toBe(401);
      } finally {
        process.env.PUBLIC_URL = ORIGIN;
      }
      expect((await rpc(tokens.access_token)).status).toBe(200);
    });

    it('PUBLIC_URL wins over the Host header; metadata is publicly cacheable only then', async () => {
      const res = await request(app).get('/.well-known/oauth-authorization-server').set('Host', 'evil.example');
      expect(res.body.issuer).toBe(ORIGIN);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      const unauth = await rpc(null).set('Host', 'evil.example');
      expect(unauth.headers['www-authenticate']).toContain(`resource_metadata="${ORIGIN}/`);
    });

    it('development without PUBLIC_URL: Host-based, not cached; audience ignores the host but checks the /mcp path', async () => {
      delete process.env.PUBLIC_URL;
      try {
        const meta = await request(app).get('/.well-known/oauth-protected-resource/mcp').set('Host', 'a.local:1111');
        expect(meta.body.resource).toBe('http://a.local:1111/mcp');
        expect(meta.headers['cache-control']).toBe('no-store');

        // Host a로 동의·교환한 토큰이 Host b로 와도 동작한다(개발 환경은 호스트를 보지 않는다)
        const { verifier, challenge } = pkce();
        const params = authorizeParams(clientId, challenge, { resource: 'http://a.local:1111/mcp' });
        const dec = await request(app).post('/oauth/authorize/decision').set('Host', 'a.local:1111').set(auth(alice))
          .send({ params, approve: true });
        expect(dec.status).toBe(200);
        const code = new URL(dec.body.redirectTo).searchParams.get('code')!;
        rawSecrets.push(code);
        const tok = await request(app).post('/oauth/token').set('Host', 'a.local:1111').type('form')
          .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
        expect(tok.status).toBe(200);
        rawSecrets.push(tok.body.access_token, tok.body.refresh_token);
        expect((await rpc(tok.body.access_token).set('Host', 'b.local:2222')).status).toBe(200);

        // 경로가 /mcp가 아닌 리소스용 토큰은 거부한다
        await prisma.oAuthToken.update({ where: { accessTokenHash: hashSecret(tok.body.access_token) }, data: { resource: 'http://a.local:1111/other' } });
        expect((await rpc(tok.body.access_token)).status).toBe(401);
      } finally {
        process.env.PUBLIC_URL = ORIGIN;
      }
    });

    it('production without PUBLIC_URL: OAuth endpoints 503, /mcp takes PATs only', async () => {
      const tokens = await fullGrant(alice);
      const pat = await request(app).post('/tokens').set(auth(alice)).send({ name: 'prod-check' });
      expect(pat.status).toBe(201);
      const savedEnv = process.env.NODE_ENV;
      delete process.env.PUBLIC_URL;
      process.env.NODE_ENV = 'production';
      try {
        for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
          const res = await request(app).get(path);
          expect(res.status).toBe(503);
          expect(res.body.code).toBe('OAUTH_NOT_CONFIGURED');
          expect(res.headers['cache-control']).toBe('no-store');
        }
        expect((await registerClient()).status).toBe(503);
        expect((await request(app).get('/oauth/authorize').query({ client_id: clientId })).status).toBe(503);
        expect((await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId })).status).toBe(503);
        const oauthCall = await rpc(tokens.access_token);
        expect(oauthCall.status).toBe(401);
        expect(oauthCall.headers['www-authenticate']).toBe('Bearer realm="mcp", error="invalid_token"');
        expect((await rpc(pat.body.token)).status).toBe(200);
      } finally {
        process.env.NODE_ENV = savedEnv;
        process.env.PUBLIC_URL = ORIGIN;
      }
      expect((await rpc(tokens.access_token)).status).toBe(200);
      await request(app).delete(`/tokens/${pat.body.id}`).set(auth(alice));
    });

    it('writes lastIssuedAt only on the first issuance', async () => {
      const before = await prisma.oAuthClient.findUniqueOrThrow({ where: { id: clientRowId } });
      expect(before.lastIssuedAt).not.toBeNull();
      await fullGrant(alice);
      const after = await prisma.oAuthClient.findUniqueOrThrow({ where: { id: clientRowId } });
      expect(after.lastIssuedAt!.getTime()).toBe(before.lastIssuedAt!.getTime());
    });

    it('a revoked family does not raise reuse events; only a live family\'s rotated token does', async () => {
      const first = await fullGrant(bob);
      const r1 = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
      rawSecrets.push(r1.body.access_token, r1.body.refresh_token);
      expect((await request(app).delete(`/users/me/connected-apps/${clientRowId}`).set(auth(bob))).status).toBe(200);
      const countReuse = () => prisma.auditLog.count({ where: { action: 'oauth.refresh_reuse_detected' } });
      const before = await countReuse();
      // 회전된 옛 토큰과 현재 토큰 모두: 폐기된 계열이라 재사용 이벤트 없이 거부
      for (const t of [first.refresh_token, r1.body.refresh_token]) {
        const res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t, client_id: clientId });
        expect(res.body.error).toBe('invalid_grant');
      }
      expect(await countReuse()).toBe(before);
    });

    it('turning OAuth apps off while refreshing never leaves a live token', async () => {
      for (let round = 0; round < 4; round++) {
        const tokens = await fullGrant(alice);
        const [, refresh] = await Promise.all([
          request(app).patch('/admin/settings/security').set(auth(admin)).send({ allowOAuthApps: false }),
          tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }),
        ]);
        if (refresh.status === 200) rawSecrets.push(refresh.body.access_token, refresh.body.refresh_token);
        expect(await prisma.oAuthToken.count({ where: { revokedAt: null } })).toBe(0);
        if (refresh.status === 200) expect((await rpc(refresh.body.access_token)).status).toBe(401);
        await request(app).patch('/admin/settings/security').set(auth(admin)).send({ allowOAuthApps: true });
      }
    });
  });

  describe('connected apps (settings)', () => {
    it('lists, disconnects and then rejects; other users cannot touch it', async () => {
      const tokens = await fullGrant(alice);
      const list = await request(app).get('/users/me/connected-apps').set(auth(alice));
      expect(list.status).toBe(200);
      const item = list.body.items.find((i: { id: number }) => i.id === clientRowId);
      expect(item).toMatchObject({ name: 'Claude', redirectHosts: ['127.0.0.1:33418'] });
      expect(item.scopes).toEqual(['channels:read', 'channels:history', 'chat:write']);
      expect(JSON.stringify(list.body)).not.toContain('scoat_');

      expect((await request(app).get('/users/me/connected-apps').set(auth(bob))).body.items).toEqual([]);
      expect((await request(app).delete(`/users/me/connected-apps/${clientRowId}`).set(auth(bob))).status).toBe(404);
      expect((await rpc(tokens.access_token)).status).toBe(200);

      const del = await request(app).delete(`/users/me/connected-apps/${clientRowId}`).set(auth(alice));
      expect(del.status).toBe(200);
      expect((await rpc(tokens.access_token)).status).toBe(401);
      const again = await request(app).delete(`/users/me/connected-apps/${clientRowId}`).set(auth(alice));
      expect(again.status).toBe(404);
      expect(again.body.code).toBe('OAUTH_CONNECTION_NOT_FOUND');
      const after = await request(app).get('/users/me/connected-apps').set(auth(alice));
      expect(after.body.items.find((i: { id: number }) => i.id === clientRowId)).toBeUndefined();
    });
  });

  describe('invalidation', () => {
    it('tokenVersion bump (password change, forced logout) invalidates access and refresh tokens', async () => {
      const tokens = await fullGrant(bob);
      expect((await rpc(tokens.access_token)).status).toBe(200);
      await prisma.user.update({ where: { id: bob.id }, data: { tokenVersion: { increment: 1 } } });
      expect((await rpc(tokens.access_token)).status).toBe(401);
      const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
      expect(refresh.body.error).toBe('invalid_grant');
      bob.token = (await request(app).post('/auth/login').send({ email: 'bob-oauth@example.com', password: TEST_PASSWORD })).body.token;
    });

    it('deactivated users lose access', async () => {
      const tokens = await fullGrant(bob);
      await prisma.user.update({ where: { id: bob.id }, data: { deactivatedAt: new Date() } });
      try {
        expect((await rpc(tokens.access_token)).status).toBe(401);
      } finally {
        await prisma.user.update({ where: { id: bob.id }, data: { deactivatedAt: null } });
      }
    });

    it('organization 2FA requirement blocks OAuth tokens of unenrolled users (403 JSON-RPC)', async () => {
      const tokens = await fullGrant(alice);
      process.env.TOTP_ENCRYPTION_KEY = KEY_HEX;
      await prisma.workspaceSetting.upsert({ where: { id: 1 }, create: { id: 1, requireMfa: true }, update: { requireMfa: true } });
      try {
        const res = await rpc(tokens.access_token);
        expect(res.status).toBe(403);
        expect(res.body.error.data.code).toBe('MFA_ENROLLMENT_REQUIRED');
        const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
        expect(refresh.body.error).toBe('invalid_grant');
      } finally {
        await prisma.workspaceSetting.update({ where: { id: 1 }, data: { requireMfa: false } });
        if (savedKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
        else process.env.TOTP_ENCRYPTION_KEY = savedKey;
      }
    });

    it('2FA users must confirm a code on the consent screen', async () => {
      await prisma.user.update({ where: { id: bob.id }, data: { mfaEnabledAt: new Date() } });
      try {
        const { challenge } = pkce();
        const params = authorizeParams(clientId, challenge);
        expect((await request(app).get('/oauth/authorize/details').set(auth(bob)).query(params)).body.mfaRequired).toBe(true);
        const res = await request(app).post('/oauth/authorize/decision').set(auth(bob)).send({ params, approve: true });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('MFA_CODE_REQUIRED');
      } finally {
        await prisma.user.update({ where: { id: bob.id }, data: { mfaEnabledAt: null } });
      }
    });
  });

  describe('organization policy: allow OAuth apps', () => {
    it('admin can turn OAuth apps off (revoking every token) and on again', async () => {
      const tokens = await fullGrant(alice);
      const settings = await request(app).get('/admin/settings/security').set(auth(admin));
      expect(settings.body.allowOAuthApps).toBe(true);
      expect((await request(app).patch('/admin/settings/security').set(auth(alice)).send({ allowOAuthApps: false })).status).toBe(403);

      const off = await request(app).patch('/admin/settings/security').set(auth(admin)).send({ allowOAuthApps: false });
      expect(off.status).toBe(200);
      expect(off.body.allowOAuthApps).toBe(false);
      expect((await rpc(tokens.access_token)).status).toBe(401);
      expect((await registerClient()).status).toBe(403);
      const { challenge } = pkce();
      const authz = await request(app).get('/oauth/authorize').query(authorizeParams(clientId, challenge));
      expect(new URL(authz.headers.location).searchParams.get('error')).toBe('access_denied');
      const decision = await request(app).post('/oauth/authorize/decision').set(auth(alice))
        .send({ params: authorizeParams(clientId, challenge), approve: true });
      expect(decision.status).toBe(400);
      expect(decision.body.code).toBe('OAUTH_APPS_DISABLED');

      const on = await request(app).patch('/admin/settings/security').set(auth(admin)).send({ allowOAuthApps: true });
      expect(on.body.allowOAuthApps).toBe(true);
      // 다시 켜도 예전 토큰은 살아나지 않는다
      expect((await rpc(tokens.access_token)).status).toBe(401);
      const policyLog = await prisma.auditLog.findFirst({ where: { action: 'workspace.oauth_policy_changed' }, orderBy: { id: 'asc' } });
      expect(policyLog!.details).toMatch(/^allowOAuthApps=false; revoked=\d+$/);
      expect((await request(app).patch('/admin/settings/security').set(auth(admin)).send({})).status).toBe(400);
    });

    it('turning OAuth apps off deletes codes that were approved but not yet exchanged', async () => {
      const { verifier, challenge } = pkce();
      const code = await approve(alice, authorizeParams(clientId, challenge));
      rawSecrets.push(code);
      await request(app).patch('/admin/settings/security').set(auth(admin)).send({ allowOAuthApps: false });
      await request(app).patch('/admin/settings/security').set(auth(admin)).send({ allowOAuthApps: true });
      expect(await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash: hashSecret(code) } })).toBeNull();
      const res = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
      expect(res.body.error).toBe('invalid_grant');
    });
  });

  describe('code exchange hardening', () => {
    async function approvedCode(user: TestUser) {
      const { verifier, challenge } = pkce();
      const code = await approve(user, authorizeParams(clientId, challenge));
      rawSecrets.push(code);
      return { code, verifier, form: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId } };
    }

    it('rejects the exchange when the password changed after consent (tokenVersion)', async () => {
      const { form } = await approvedCode(bob);
      const changed = await request(app).post('/auth/change-password').set(auth(bob))
        .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD + 'x' });
      expect(changed.status).toBe(200);
      const res = await tokenRequest(form);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
      // 원래 비밀번호로 되돌린다(다른 테스트가 로그인에 쓴다)
      const back = await request(app).post('/auth/change-password').set(auth({ ...bob, token: changed.body.token }))
        .send({ currentPassword: TEST_PASSWORD + 'x', newPassword: TEST_PASSWORD });
      expect(back.status).toBe(200);
      bob.token = back.body.token;
    });

    it('a replayed code without the verifier neither burns the code nor revokes the family', async () => {
      const { code, form } = await approvedCode(alice);
      const ok = await tokenRequest(form);
      expect(ok.status).toBe(200);
      rawSecrets.push(ok.body.access_token, ok.body.refresh_token);
      const attacker = await tokenRequest({ ...form, code_verifier: pkce().verifier });
      expect(attacker.body.error).toBe('invalid_grant');
      expect((await rpc(ok.body.access_token)).status).toBe(200);
      expect(code).toBeTruthy();
    });

    it('concurrent exchanges: exactly one wins and the winner\'s tokens are revoked by reuse detection', async () => {
      for (let round = 0; round < 3; round++) {
        const { form } = await approvedCode(alice);
        const results = await Promise.all([tokenRequest(form), tokenRequest(form), tokenRequest(form)]);
        const winners = results.filter((r) => r.status === 200);
        expect(winners).toHaveLength(1);
        expect(results.filter((r) => r.status === 400 && r.body.error === 'invalid_grant')).toHaveLength(2);
        rawSecrets.push(winners[0].body.access_token, winners[0].body.refresh_token);
        // 재사용이 감지됐으므로 승자의 토큰도 폐기돼 있다(폐기에서 빠지지 않는다)
        expect((await rpc(winners[0].body.access_token)).status).toBe(401);
        const refresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: winners[0].body.refresh_token, client_id: clientId });
        expect(refresh.body.error).toBe('invalid_grant');
      }
    });

    it('disconnect counts live tokens or pending codes; rotated/expired rows alone give 404', async () => {
      // 교환 전 코드만 있어도 200(코드를 지운다)
      const pending = await approvedCode(carol);
      const onlyCode = await request(app).delete(`/users/me/connected-apps/${clientRowId}`).set(auth(carol));
      expect(onlyCode.status).toBe(200);
      expect(await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash: hashSecret(pending.code) } })).toBeNull();
      // 회전·만료된 행만 남은 경우: 목록에 안 보이므로 404
      const t = await fullGrant(carol);
      await prisma.oAuthToken.updateMany({
        where: { accessTokenHash: hashSecret(t.access_token) }, data: { refreshExpiresAt: new Date(Date.now() - 1000) },
      });
      expect((await request(app).get('/users/me/connected-apps').set(auth(carol))).body.items).toEqual([]);
      expect((await request(app).delete(`/users/me/connected-apps/${clientRowId}`).set(auth(carol))).status).toBe(404);
    });

    it('disconnecting an app deletes its unexchanged codes', async () => {
      await fullGrant(alice);
      const { code, form } = await approvedCode(alice);
      expect((await request(app).delete(`/users/me/connected-apps/${clientRowId}`).set(auth(alice))).status).toBe(200);
      expect(await prisma.oAuthAuthorizationCode.findUnique({ where: { codeHash: hashSecret(code) } })).toBeNull();
      expect((await tokenRequest(form)).body.error).toBe('invalid_grant');
    });

    it('unnamed clients are stored with an empty name (the UI shows a translated label)', async () => {
      const res = await request(app).post('/oauth/register')
        .send({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
      expect(res.status).toBe(201);
      expect(res.body.client_name).toBeUndefined();
      const row = await prisma.oAuthClient.findUniqueOrThrow({ where: { clientId: res.body.client_id } });
      expect(row.clientName).toBe('');
      const { challenge } = pkce();
      const details = await request(app).get('/oauth/authorize/details').set(auth(alice))
        .query(authorizeParams(res.body.client_id, challenge));
      expect(details.body.client.name).toBe('');
    });
  });

  describe('cleanup (scheduler)', () => {
    it('purges dead tokens, old codes and never-used registrations; keeps connectedAt per family', async () => {
      const tokens = await fullGrant(alice);
      const live = await prisma.oAuthToken.findUniqueOrThrow({ where: { accessTokenHash: hashSecret(tokens.access_token) } });
      const familyStart = new Date(Date.now() - 40 * 86400_000);
      // 계열 첫 행을 오래전에 만든 것처럼: 첫 행은 수명이 지나 지워지고, 지금 행에 복사된 familyCreatedAt이 남는다
      await prisma.oAuthToken.updateMany({ where: { familyId: live.familyId }, data: { familyCreatedAt: familyStart } });
      const old = await prisma.oAuthToken.create({
        data: {
          familyId: live.familyId, familyCreatedAt: familyStart, clientId: clientRowId, userId: alice.id,
          accessTokenHash: hashSecret('old-a'), refreshTokenHash: hashSecret('old-r'), scopes: live.scopes, resource: RESOURCE,
          tokenVersion: live.tokenVersion, accessExpiresAt: new Date(Date.now() - 39 * 86400_000),
          refreshExpiresAt: new Date(Date.now() - 86400_000), rotatedAt: new Date(Date.now() - 39 * 86400_000), createdAt: familyStart,
        },
      });
      const revokedLongAgo = await prisma.oAuthToken.create({
        data: {
          familyId: 'f'.repeat(32), familyCreatedAt: new Date(), clientId: clientRowId, userId: alice.id,
          accessTokenHash: hashSecret('rev-a'), refreshTokenHash: hashSecret('rev-r'), scopes: [], resource: RESOURCE, tokenVersion: 0,
          accessExpiresAt: new Date(Date.now() + 3600_000), refreshExpiresAt: new Date(Date.now() + 86400_000),
          revokedAt: new Date(Date.now() - 2 * 86400_000),
        },
      });
      const oldCode = await prisma.oAuthAuthorizationCode.create({
        data: {
          codeHash: hashSecret('old-code'), clientId: clientRowId, userId: alice.id, redirectUri: REDIRECT, scopes: [], resource: RESOURCE,
          codeChallenge: 'x'.repeat(43), tokenVersion: 0, expiresAt: new Date(Date.now() - 2 * 86400_000),
        },
      });
      const unused = await prisma.oAuthClient.create({
        data: { clientId: 'scoc_unused', tokenEndpointAuthMethod: 'none', clientName: 'Unused', redirectUris: [REDIRECT], createdAt: new Date(Date.now() - 31 * 86400_000) },
      });
      const recentUnused = await prisma.oAuthClient.create({
        data: { clientId: 'scoc_recent', tokenEndpointAuthMethod: 'none', clientName: 'Recent', redirectUris: [REDIRECT] },
      });

      const result = await purgeOAuth();
      expect(result.tokens).toBeGreaterThanOrEqual(2);
      expect(await prisma.oAuthToken.findUnique({ where: { id: old.id } })).toBeNull();
      expect(await prisma.oAuthToken.findUnique({ where: { id: revokedLongAgo.id } })).toBeNull();
      expect(await prisma.oAuthToken.findUnique({ where: { id: live.id } })).not.toBeNull();
      expect(await prisma.oAuthAuthorizationCode.findUnique({ where: { id: oldCode.id } })).toBeNull();
      expect(await prisma.oAuthClient.findUnique({ where: { id: unused.id } })).toBeNull();
      expect(await prisma.oAuthClient.findUnique({ where: { id: recentUnused.id } })).not.toBeNull();
      expect(await prisma.oAuthClient.findUnique({ where: { id: clientRowId } })).not.toBeNull();

      const list = await request(app).get('/users/me/connected-apps').set(auth(alice));
      const item = list.body.items.find((i: { id: number }) => i.id === clientRowId);
      expect(new Date(item.connectedAt).getTime()).toBe(familyStart.getTime());
      expect((await rpc(tokens.access_token)).status).toBe(200);
    });
  });

  describe('rate limits', () => {
    it('token endpoint: per IP+client bucket, plus an IP cap that random client_ids cannot dodge', async () => {
      const mini = express();
      mini.use(express.urlencoded({ extended: false }));
      mini.post('/t', ...createOAuthTokenLimiters(2, 5), (_req, res) => { res.json({ ok: true }); });
      const hit = (cid: string, basic = false) => {
        const r = request(mini).post('/t').type('form');
        if (basic) r.set('Authorization', `Basic ${Buffer.from(`${encodeURIComponent(cid)}:s`).toString('base64')}`);
        return r.send(basic ? {} : { client_id: cid });
      };
      expect((await hit('a')).status).toBe(200);
      // Basic 헤더의 URL 인코딩된 id도 같은 버킷(같은 파서)
      expect((await hit('a', true)).status).toBe(200);
      expect((await hit('a')).status).toBe(429);
      expect((await hit('b')).status).toBe(200);
      expect((await hit('c')).status).toBe(200);
      // IP 상한 5: 무작위 client_id로 바꿔도 막힌다
      expect((await hit(crypto.randomUUID())).status).toBe(429);
    });

    it('authorize, details and decision share a browser limiter', async () => {
      const mini = express();
      mini.get('/b', createOAuthBrowserLimiter(2), (_req, res) => { res.json({ ok: true }); });
      expect((await request(mini).get('/b')).status).toBe(200);
      expect((await request(mini).get('/b')).status).toBe(200);
      const limited = await request(mini).get('/b');
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('RATE_LIMITED');
    });

    it('/mcp auth-failure limiter ignores token-less discovery and known expired/rotated tokens', async () => {
      const mini = express();
      mini.use(express.json());
      mini.use('/mcp', createMcpAuthFailureLimiter(3), accessTokenAuth, mcpRoutes);
      const post = (token: string | null) => {
        const r = request(mini).post('/mcp').set(MCP_ACCEPT);
        if (token) r.set(bearer(token));
        return r.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      };
      const first = await fullGrant(alice);
      const rotated = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
      rawSecrets.push(rotated.body.access_token, rotated.body.refresh_token);
      for (let i = 0; i < 50; i++) expect((await post(null)).status).toBe(401);
      // 회전된(알려진) 토큰의 401도 세지 않는다
      for (let i = 0; i < 5; i++) expect((await post(first.access_token)).status).toBe(401);
      expect((await post(rotated.body.access_token)).status).toBe(200);
      // 형식이 틀리거나 없는 토큰은 센다: 3번 뒤 잠긴다
      for (let i = 0; i < 3; i++) expect((await post(`scoat_${'z'.repeat(43)}`)).status).toBe(401);
      expect((await post(rotated.body.access_token)).status).toBe(429);
    });
  });

  it('audit logs never contain raw codes, tokens or client secrets', async () => {
    const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: 'oauth.' } } });
    const actions = new Set(logs.map((l) => l.action));
    for (const a of ['oauth.client_registered', 'oauth.authorized', 'oauth.token_revoked', 'oauth.refresh_reuse_detected']) {
      expect(actions).toContain(a);
    }
    const all = JSON.stringify(await prisma.auditLog.findMany());
    expect(rawSecrets.length).toBeGreaterThan(10);
    for (const s of rawSecrets) expect(all).not.toContain(s);
  });
});
