import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import express from 'express';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { settleBackgroundWork } from '../services/mentionService.js';
import { hashSecret } from '../services/accessTokenService.js';
import { createMcpAuthFailureLimiter, createMcpTokenLimiter } from '../mcp/rateLimit.js';
import { accessTokenAuth } from '../middleware/accessTokenAuth.js';
import mcpRoutes from '../routes/mcp.js';

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-mcp@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const MCP_ACCEPT = { Accept: 'application/json, text/event-stream' };

async function createToken(u: TestUser, body: object = { name: 'claude' }) {
  const res = await request(app).post('/tokens').set(auth(u)).send(body);
  expect(res.status).toBe(201);
  return res.body as { id: number; token: string; prefix: string; scopes: string[] };
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** JSON-RPC 한 번을 HTTP로 직접 보낸다(인증·상태 코드 검사용) */
function rpc(token: string | null, method = 'tools/list', params: object = {}) {
  const req = request(app).post('/mcp').set(MCP_ACCEPT);
  if (token) req.set(bearer(token));
  return req.send({ jsonrpc: '2.0', id: 1, method, params });
}

describe('MCP server + personal access tokens (mcp-1)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let alice: TestUser, bob: TestUser, gina: TestUser, dora: TestUser;
  let pubId: number, privId: number, bobPrivId: number, otherPubId: number;
  const clients: Client[] = [];

  async function connectClient(token: string): Promise<Client> {
    const client = new Client({ name: 'jest', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: bearer(token) },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) };
  }

  beforeAll(async () => {
    await prisma.personalAccessToken.deleteMany();
    [alice, bob, gina, dora] = [await register('Alice'), await register('Bob'), await register('Gina'), await register('Dora')];

    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'mcp-pub' })).body.id;
    otherPubId = (await request(app).post('/channels').set(auth(bob)).send({ name: 'mcp-other-pub' })).body.id;
    privId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'mcp-priv', isPrivate: true })).body.id;
    bobPrivId = (await request(app).post('/channels').set(auth(bob)).send({ name: 'mcp-bob-secret', isPrivate: true })).body.id;
    await request(app).post(`/channels/${pubId}/join`).set(auth(bob));
    await request(app).post(`/channels/${pubId}/join`).set(auth(gina));
    // gina는 게스트: #mcp-pub 멤버, #mcp-other-pub(공개)은 비멤버
    await prisma.user.update({ where: { id: gina.id }, data: { role: 'GUEST' } });
    // dora는 gina와 같은 채널이 하나도 없게 한다(가입 시 들어간 기본 채널에서 뺀다)
    await prisma.channelMember.deleteMany({ where: { userId: dora.id } });

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    io.close();
    await new Promise((r) => httpServer.close(r));
  });

  describe('token CRUD', () => {
    it('creates, lists, renames, revokes a token; raw value is shown once and only the hash is stored', async () => {
      // Create
      const created = await createToken(alice, { name: 'laptop', expiresInDays: 7 });
      expect(created.token).toMatch(/^scpat_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
      expect(created.token.startsWith(created.prefix)).toBe(true);
      expect(created.scopes).toEqual(['channels:read', 'channels:history', 'users:read']);

      const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: created.id } });
      const secret = created.token.split('_').slice(2).join('_');
      expect(row.tokenHash).toBe(hashSecret(secret));
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(row.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);

      // Read: 목록에는 원문도 해시도 없다
      const list = await request(app).get('/tokens').set(auth(alice));
      expect(list.status).toBe(200);
      const item = list.body.items.find((t: any) => t.id === created.id);
      expect(item).toMatchObject({ name: 'laptop', prefix: created.prefix, expired: false, revokedAt: null });
      expect(item.token).toBeUndefined();
      expect(item.tokenHash).toBeUndefined();
      expect(JSON.stringify(list.body)).not.toContain(secret);

      // Update: 이름만 바꿀 수 있다
      const renamed = await request(app).patch(`/tokens/${created.id}`).set(auth(alice)).send({ name: 'desktop' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.name).toBe('desktop');
      const badPatch = await request(app).patch(`/tokens/${created.id}`).set(auth(alice)).send({ name: 'x', scopes: ['channels:read'] });
      expect(badPatch.status).toBe(400);

      // 토큰이 동작한다
      expect((await rpc(created.token, 'tools/list')).status).toBe(200);

      // Delete(폐기): 목록에서 빠지고 /mcp는 401
      const del = await request(app).delete(`/tokens/${created.id}`).set(auth(alice));
      expect(del.status).toBe(200);
      expect(del.body.revokedAt).not.toBeNull();
      const after = await request(app).get('/tokens').set(auth(alice));
      expect(after.body.items.find((t: any) => t.id === created.id)).toBeUndefined();
      const revoked = await rpc(created.token);
      expect(revoked.status).toBe(401);
      expect(revoked.headers['www-authenticate']).toMatch(/^Bearer/);
      // 두 번 폐기하거나 폐기된 토큰을 고치면 404
      expect((await request(app).delete(`/tokens/${created.id}`).set(auth(alice))).status).toBe(404);
      expect((await request(app).patch(`/tokens/${created.id}`).set(auth(alice)).send({ name: 'y' })).status).toBe(404);
    });

    it('repeats create/revoke cycles without leaking tokens between cycles', async () => {
      for (let i = 0; i < 3; i++) {
        const t = await createToken(alice, { name: `cycle-${i}` });
        expect((await rpc(t.token)).status).toBe(200);
        expect((await request(app).delete(`/tokens/${t.id}`).set(auth(alice))).status).toBe(200);
        expect((await rpc(t.token)).status).toBe(401);
      }
    });

    it('validates input', async () => {
      const bad = async (body: object) => (await request(app).post('/tokens').set(auth(alice)).send(body)).status;
      expect(await bad({})).toBe(400);
      expect(await bad({ name: '   ' })).toBe(400);
      expect(await bad({ name: 'a'.repeat(101) })).toBe(400);
      expect(await bad({ name: 'x', scopes: ['admin:all'] })).toBe(400);
      expect(await bad({ name: 'x', scopes: [] })).toBe(400);
      expect(await bad({ name: 'x', expiresInDays: 0 })).toBe(400);
      expect(await bad({ name: 'x', expiresInDays: 366 })).toBe(400);
      expect(await bad({ name: 'x', userId: bob.id })).toBe(400);
      expect((await request(app).delete('/tokens/abc').set(auth(alice))).status).toBe(400);
    });

    it('supports tokens without expiry', async () => {
      const t = await createToken(alice, { name: 'forever', expiresInDays: null });
      const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.expiresAt).toBeNull();
      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));
    });

    it("cannot see, rename or revoke another user's token", async () => {
      const t = await createToken(alice, { name: 'mine' });
      const bobList = await request(app).get('/tokens').set(auth(bob));
      expect(bobList.body.items.some((x: any) => x.id === t.id)).toBe(false);
      expect((await request(app).patch(`/tokens/${t.id}`).set(auth(bob)).send({ name: 'stolen' })).status).toBe(404);
      expect((await request(app).delete(`/tokens/${t.id}`).set(auth(bob))).status).toBe(404);
      expect((await rpc(t.token)).status).toBe(200);
      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));
    });

    it('requires a login session to manage tokens (a PAT cannot manage PATs or call the REST API)', async () => {
      const t = await createToken(alice, { name: 'pat-only' });
      expect((await request(app).get('/tokens')).status).toBe(401);
      expect((await request(app).get('/tokens').set(bearer(t.token))).status).toBe(401);
      expect((await request(app).post('/tokens').set(bearer(t.token)).send({ name: 'x' })).status).toBe(401);
      expect((await request(app).get('/channels').set(bearer(t.token))).status).toBe(401);
      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));
    });

    it('enforces the active token limit under concurrent creation', async () => {
      const carl = await register('Carl');
      // 19개를 미리 만들어 두고 동시에 5개를 요청하면 1개만 성공해야 한다
      await prisma.personalAccessToken.createMany({
        data: Array.from({ length: 19 }, (_, i) => ({
          userId: carl.id, name: `pre-${i}`, publicId: `c0ffee${String(i).padStart(6, '0')}`, tokenHash: '0'.repeat(64), scopes: ['users:read'],
        })),
      });
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => request(app).post('/tokens').set(auth(carl)).send({ name: `race-${i}` })),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe('TOKEN_LIMIT_REACHED');
      expect(await prisma.personalAccessToken.count({ where: { userId: carl.id, revokedAt: null } })).toBe(20);

      // 폐기하면 다시 만들 수 있다
      const one = await prisma.personalAccessToken.findFirstOrThrow({ where: { userId: carl.id, name: 'pre-0' } });
      expect((await request(app).delete(`/tokens/${one.id}`).set(auth(carl))).status).toBe(200);
      expect((await request(app).post('/tokens').set(auth(carl)).send({ name: 'after-revoke' })).status).toBe(201);
      expect((await request(app).post('/tokens').set(auth(carl)).send({ name: 'over' })).status).toBe(409);
    });

    it('does not count expired tokens toward the limit', async () => {
      const ella = await register('Ella');
      await prisma.personalAccessToken.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          userId: ella.id, name: `old-${i}`, publicId: `e11a00${String(i).padStart(6, '0')}`, tokenHash: '0'.repeat(64),
          scopes: ['users:read'], expiresAt: i < 2 ? new Date(Date.now() - 1000) : null,
        })),
      });
      // 2개가 만료돼 활성은 18개: 2개 더 만들 수 있고 그다음은 409
      expect((await request(app).post('/tokens').set(auth(ella)).send({ name: 'n1' })).status).toBe(201);
      expect((await request(app).post('/tokens').set(auth(ella)).send({ name: 'n2' })).status).toBe(201);
      expect((await request(app).post('/tokens').set(auth(ella)).send({ name: 'n3' })).status).toBe(409);
    });

    it('writes audit logs for create, revoke and tool calls without the raw token', async () => {
      const t = await createToken(alice, { name: 'audited' });
      const client = await connectClient(t.token);
      await call(client, 'list_channels');
      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));

      // 감사 로그는 응답을 기다리게 하지 않고 뒤에서 기록된다
      const logs = await waitFor(
        () => prisma.auditLog.findMany({ where: { actorId: alice.id }, orderBy: { id: 'asc' } }),
        (rows) => ['token.create', 'token.revoke', 'mcp.tool_call'].every((a) => rows.some((r) => r.action === a)),
      );
      const actions = logs.map((l) => l.action);
      expect(actions).toEqual(expect.arrayContaining(['token.create', 'token.revoke', 'mcp.tool_call']));
      const toolLog = logs.find((l) => l.action === 'mcp.tool_call' && l.targetName === 'list_channels')!;
      expect(JSON.parse(toolLog.details!)).toEqual({ via: 'mcp', tokenId: t.id, tool: 'list_channels', ok: true });
      const secret = t.token.split('_').slice(2).join('_');
      expect(JSON.stringify(logs)).not.toContain(secret);
      const row = await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: t.id } });
      expect(JSON.stringify(logs)).not.toContain(row.tokenHash);
    });
  });

  describe('/mcp authentication', () => {
    it('rejects missing, malformed and JWT bearer tokens with 401', async () => {
      expect((await rpc(null)).status).toBe(401);
      const jwtRes = await rpc(alice.token);
      expect(jwtRes.status).toBe(401);
      expect(jwtRes.headers['www-authenticate']).toContain('invalid_token');
      expect((await rpc('scpat_garbage')).status).toBe(401);
    });

    it('rejects a token whose secret does not match (same public id)', async () => {
      const t = await createToken(alice, { name: 'forged' });
      const [, , ...rest] = t.token.split('_');
      const secret = rest.join('_');
      const forged = `${t.prefix}_${secret[0] === 'A' ? 'B' : 'A'}${secret.slice(1)}`;
      expect((await rpc(forged)).status).toBe(401);
      expect((await rpc(t.token)).status).toBe(200);
      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));
    });

    it('rejects expired tokens with 401', async () => {
      const t = await createToken(alice, { name: 'old' });
      expect((await rpc(t.token)).status).toBe(200);
      await prisma.personalAccessToken.update({ where: { id: t.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await rpc(t.token)).status).toBe(401);
      const list = await request(app).get('/tokens').set(auth(alice));
      expect(list.body.items.find((x: any) => x.id === t.id).expired).toBe(true);
      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));
    });

    it('rejects tokens of deactivated users', async () => {
      const t = await createToken(dora, { name: 'dora' });
      expect((await rpc(t.token)).status).toBe(200);
      await prisma.user.update({ where: { id: dora.id }, data: { deactivatedAt: new Date() } });
      expect((await rpc(t.token)).status).toBe(401);
      await prisma.user.update({ where: { id: dora.id }, data: { deactivatedAt: null } });
    });

    it('records lastUsedAt', async () => {
      const t = await createToken(alice, { name: 'used' });
      expect((await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: t.id } })).lastUsedAt).toBeNull();
      await rpc(t.token);
      expect((await prisma.personalAccessToken.findUniqueOrThrow({ where: { id: t.id } })).lastUsedAt).not.toBeNull();
      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));
    });

    it('answers GET and DELETE with 405 (stateless server, no SSE stream)', async () => {
      const t = await createToken(alice, { name: 'methods' });
      expect((await request(app).get('/mcp').set(bearer(t.token)).set(MCP_ACCEPT)).status).toBe(405);
      expect((await request(app).delete('/mcp').set(bearer(t.token))).status).toBe(405);
      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));
    });
  });

  describe('read tools over the MCP protocol', () => {
    let client: Client;
    let parentId: number;
    let replyId: number;

    beforeAll(async () => {
      const t = await createToken(alice, { name: 'tools' });
      client = await connectClient(t.token);

      parentId = (await request(app).post(`/channels/${pubId}/messages`).set(auth(bob)).send({ content: `hello <@${alice.id}|Alice>` })).body.id;
      replyId = (await request(app).post(`/messages/${parentId}/reply`).set(auth(alice)).send({ content: 'thread reply' })).body.id;
      await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: 'second top-level' });
      await request(app).post(`/channels/${bobPrivId}/messages`).set(auth(bob)).send({ content: 'bob only secret' });
      await settleBackgroundWork();
    });

    it('lists the read tools with input schemas', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((x) => x.name).sort()).toEqual(['get_activity', 'list_channels', 'list_users', 'read_channel', 'read_thread']);
      const readChannelTool = tools.find((x) => x.name === 'read_channel')!;
      expect(readChannelTool.inputSchema.required).toEqual(['channelId']);
      expect(readChannelTool.annotations?.readOnlyHint).toBe(true);
      expect(readChannelTool.description).toMatch(/not instructions/);
    });

    it('list_channels returns public channels and my private channels only', async () => {
      const res = await call(client, 'list_channels');
      expect(res.isError).toBe(false);
      const ids = res.data.items.map((c: any) => c.id);
      expect(ids).toEqual(expect.arrayContaining([pubId, otherPubId, privId]));
      expect(ids).not.toContain(bobPrivId);
      expect(res.data.items.find((c: any) => c.id === privId)).toMatchObject({ isPrivate: true, isMember: true });

      // 커서 페이지네이션
      const page1 = await call(client, 'list_channels', { limit: 1 });
      expect(page1.data.items).toHaveLength(1);
      expect(page1.data.nextCursor).toBe(page1.data.items[0].id);
      const page2 = await call(client, 'list_channels', { limit: 1, cursor: page1.data.nextCursor });
      expect(page2.data.items[0].id).toBeLessThan(page1.data.items[0].id);
    });

    it('read_channel returns the channel timeline oldest-first and paginates', async () => {
      const res = await call(client, 'read_channel', { channelId: pubId });
      expect(res.isError).toBe(false);
      const contents = res.data.messages.map((m: any) => m.content);
      expect(contents).toEqual([`hello <@${alice.id}|Alice>`, 'second top-level']);
      expect(res.data.messages[0]).toMatchObject({ id: parentId, replyCount: 1, user: { id: bob.id, name: 'Bob' } });

      const page = await call(client, 'read_channel', { channelId: pubId, limit: 1 });
      expect(page.data.messages.map((m: any) => m.content)).toEqual(['second top-level']);
      const older = await call(client, 'read_channel', { channelId: pubId, limit: 1, cursor: page.data.nextCursor });
      expect(older.data.messages[0].id).toBe(parentId);
      expect(older.data.nextCursor).toBeNull();
    });

    it("rejects reading another user's private channel and its threads, same as a missing channel", async () => {
      const denied = await call(client, 'read_channel', { channelId: bobPrivId });
      expect(denied.isError).toBe(true);
      expect(denied.text).not.toContain('bob only secret');
      const missing = await call(client, 'read_channel', { channelId: 999999 });
      expect(missing.isError).toBe(true);
      expect(missing.text).toBe(denied.text);

      const secretMsg = await prisma.message.findFirstOrThrow({ where: { channelId: bobPrivId } });
      const thread = await call(client, 'read_thread', { messageId: secretMsg.id });
      expect(thread.isError).toBe(true);
      expect(thread.text).not.toContain('bob only secret');
    });

    it('read_thread returns parent and replies from either id', async () => {
      for (const messageId of [parentId, replyId]) {
        const res = await call(client, 'read_thread', { messageId });
        expect(res.isError).toBe(false);
        expect(res.data.parent.id).toBe(parentId);
        expect(res.data.replies.map((r: any) => r.content)).toEqual(['thread reply']);
      }
    });

    it('read_thread rejects a deleted reply id like a missing message, same as the REST thread route', async () => {
      const r = await request(app).post(`/messages/${parentId}/reply`).set(auth(alice)).send({ content: 'to be deleted' });
      expect((await call(client, 'read_thread', { messageId: r.body.id })).isError).toBe(false);
      await request(app).delete(`/messages/${r.body.id}`).set(auth(alice));

      expect((await request(app).get(`/messages/${r.body.id}/thread`).set(auth(alice))).status).toBe(404);
      const res = await call(client, 'read_thread', { messageId: r.body.id });
      expect(res.isError).toBe(true);
      expect(res.text).toBe((await call(client, 'read_thread', { messageId: 999999 })).text);
      // 부모로 읽으면 지운 답글은 빠진다
      const viaParent = await call(client, 'read_thread', { messageId: parentId });
      expect(viaParent.data.replies.map((x: any) => x.content)).toEqual(['thread reply']);
    });

    it('reflects edits and deletes made through the app (CRUD round trip)', async () => {
      const created = await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: 'crud v1' });
      const msgId = created.body.id;
      let res = await call(client, 'read_channel', { channelId: pubId, limit: 5 });
      expect(res.data.messages.find((m: any) => m.id === msgId).content).toBe('crud v1');

      await request(app).patch(`/messages/${msgId}`).set(auth(alice)).send({ content: 'crud v2' });
      res = await call(client, 'read_channel', { channelId: pubId, limit: 5 });
      const edited = res.data.messages.find((m: any) => m.id === msgId);
      expect(edited.content).toBe('crud v2');
      expect(edited.editedAt).not.toBeNull();

      await request(app).delete(`/messages/${msgId}`).set(auth(alice));
      res = await call(client, 'read_channel', { channelId: pubId, limit: 5 });
      expect(res.data.messages.find((m: any) => m.id === msgId)).toBeUndefined();
    });

    it('list_users lists active users with name filter', async () => {
      const res = await call(client, 'list_users', { search: 'bo' });
      expect(res.isError).toBe(false);
      expect(res.data.items.map((u: any) => u.name)).toEqual(['Bob']);
      expect(res.data.items[0].email).toBeUndefined();
    });

    it('get_activity returns my mentions without marking them read', async () => {
      const res = await call(client, 'get_activity', { type: 'mentions' });
      expect(res.isError).toBe(false);
      expect(res.data.items.length).toBeGreaterThanOrEqual(1);
      expect(res.data.items[0]).toMatchObject({ type: 'MENTION', channelId: pubId, readAt: null });
      const unread = await call(client, 'get_activity', { type: 'mentions', unreadOnly: true });
      expect(unread.data.items.length).toBe(res.data.items.length);
    });

    it('rejects invalid tool arguments', async () => {
      const res = await call(client, 'read_channel', { channelId: -1 });
      expect(res.isError).toBe(true);
    });
  });

  describe('scopes and guests', () => {
    it('exposes only the tools allowed by the token scopes', async () => {
      const t = await createToken(alice, { name: 'users-only', scopes: ['users:read'] });
      const client = await connectClient(t.token);
      const { tools } = await client.listTools();
      expect(tools.map((x) => x.name)).toEqual(['list_users']);
      const res = await call(client, 'read_channel', { channelId: pubId });
      expect(res.isError).toBe(true);
    });

    it('guest tokens follow guest isolation', async () => {
      const t = await createToken(gina, { name: 'guest' });
      const client = await connectClient(t.token);

      const channels = await call(client, 'list_channels');
      // 가입 시 들어가는 기본 채널 + #mcp-pub. 멤버가 아닌 공개 채널은 안 보인다
      const ids = channels.data.items.map((c: any) => c.id);
      expect(ids).toContain(pubId);
      expect(ids).not.toContain(otherPubId);
      expect(ids).not.toContain(privId);
      expect(channels.data.items.every((c: any) => c.isMember)).toBe(true);
      expect((await call(client, 'read_channel', { channelId: pubId })).isError).toBe(false);
      // 게스트는 멤버가 아닌 공개 채널도 읽을 수 없다
      expect((await call(client, 'read_channel', { channelId: otherPubId })).isError).toBe(true);

      // 같은 채널에 있는 사람만 보인다(dora는 #mcp-pub 멤버가 아니다)
      const users = await call(client, 'list_users', { limit: 50 });
      const names = users.data.items.map((u: any) => u.name);
      expect(names).toEqual(expect.arrayContaining(['Alice', 'Bob', 'Gina']));
      expect(names).not.toContain('Dora');
    });
  });

  describe('rate limits', () => {
    it('limits requests per token', async () => {
      const mini = express();
      mini.use((req, _res, next) => { (req as any).accessToken = { tokenId: Number(req.headers['x-token-id']) }; next(); });
      mini.use(createMcpTokenLimiter(2));
      mini.post('/mcp', (_req, res) => { res.json({ ok: true }); });

      expect((await request(mini).post('/mcp').set('x-token-id', '1')).status).toBe(200);
      expect((await request(mini).post('/mcp').set('x-token-id', '1')).status).toBe(200);
      expect((await request(mini).post('/mcp').set('x-token-id', '1')).status).toBe(429);
      // 다른 토큰은 다른 버킷
      expect((await request(mini).post('/mcp').set('x-token-id', '2')).status).toBe(200);
    });

    it('limits failed authentication attempts per IP, counting only 401', async () => {
      const mini = express();
      mini.use(createMcpAuthFailureLimiter(2));
      mini.all('/mcp', (req, res) => { res.status(Number(req.headers['x-status'] ?? 401)).json({}); });
      const hit = (status?: number, method: 'get' | 'post' = 'post') => {
        const r = request(mini)[method]('/mcp');
        if (status) r.set('x-status', String(status));
        return r;
      };

      // 200, 405(GET /mcp), 토큰 단위 429는 인증 실패가 아니므로 몇 번이 와도 IP가 잠기지 않는다
      for (let i = 0; i < 5; i++) {
        expect((await hit(200)).status).toBe(200);
        expect((await hit(405, 'get')).status).toBe(405);
        expect((await hit(429)).status).toBe(429);
      }
      expect((await hit()).status).toBe(401);
      expect((await hit()).status).toBe(401);
      // 401 두 번 뒤에야 잠긴다(잠긴 뒤에는 정상 요청도 429)
      const locked = await hit(200);
      expect(locked.status).toBe(429);
      expect(locked.body.error).toMatch(/Too many attempts/);
    });

    it('does not lock the IP after repeated GET /mcp 405 or per-token 429 with the real /mcp stack', async () => {
      // app.ts와 같은 순서로 조립하되 한도를 낮춘다(테스트 환경의 app은 limiter를 끈다)
      const mini = express();
      mini.use(express.json());
      mini.use('/mcp', createMcpAuthFailureLimiter(3), accessTokenAuth, createMcpTokenLimiter(5), mcpRoutes);
      const t = await createToken(alice, { name: 'get-loop' });
      const get = () => request(mini).get('/mcp').set(bearer(t.token)).set(MCP_ACCEPT);
      const post = (token: string) => request(mini).post('/mcp').set(bearer(token)).set(MCP_ACCEPT)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) statuses.push((await get()).status);
      // 토큰 한도 5회까지 405, 그 뒤는 토큰 단위 429
      expect(statuses.slice(0, 5)).toEqual([405, 405, 405, 405, 405]);
      expect(statuses.slice(5).every((st) => st === 429)).toBe(true);

      // 같은 IP의 다른 토큰은 잠기지 않았다(405·429는 인증 실패로 세지 않는다)
      const other = await createToken(alice, { name: 'get-loop-2' });
      expect((await post(other.token)).status).toBe(200);
      // 인증 실패는 IP 단위로 3번 뒤 잠긴다
      for (let i = 0; i < 3; i++) expect((await post('scpat_nope')).status).toBe(401);
      expect((await post(other.token)).status).toBe(429);

      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));
      await request(app).delete(`/tokens/${other.id}`).set(auth(alice));
    });
  });
});
