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
import { isAllowedRedirectUri } from '../services/oauthService.js';

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
  let alice: TestUser, bob: TestUser, admin: TestUser;
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

      // 틀린 verifier: 실패하고 코드는 이미 소모된다
      const wrong = await tokenRequest({
        grant_type: 'authorization_code', code, code_verifier: pkce().verifier, redirect_uri: REDIRECT, client_id: clientId,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject({ error: 'invalid_grant' });
      expect(wrong.headers['cache-control']).toBe('no-store');
      const again = await tokenRequest({
        grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId,
      });
      expect(again.status).toBe(400);

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
      // Update: 리프레시 → 새 쌍. 옛 액세스 토큰은 만료까지 쓸 수 있다.
      const r1 = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
      expect(r1.status).toBe(200);
      rawSecrets.push(r1.body.access_token, r1.body.refresh_token);
      expect(r1.body.refresh_token).not.toBe(first.refresh_token);
      expect((await rpc(r1.body.access_token)).status).toBe(200);

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
