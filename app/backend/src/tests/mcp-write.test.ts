import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as SocketClient, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { settleBackgroundWork } from '../services/mentionService.js';
import { mcpWriteLimiter } from '../mcp/rateLimit.js';

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-mcpw@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const READ = ['channels:read', 'channels:history', 'users:read'];
const WRITE = ['chat:write', 'reactions:write'];

async function createToken(u: TestUser, scopes: string[]) {
  const res = await request(app).post('/tokens').set(auth(u)).send({ name: 'claude', scopes });
  expect(res.status).toBe(201);
  return res.body as { id: number; token: string; scopes: string[] };
}

function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('MCP write tools (mcp-2)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let alice: TestUser, bob: TestUser, gina: TestUser;
  let pubId: number, privId: number, bobPrivId: number, archivedId: number;
  const clients: Client[] = [];
  const sockets: ClientSocket[] = [];

  async function connectClient(token: string): Promise<Client> {
    const client = new Client({ name: 'jest', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: bearer(token) } }));
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) };
  }

  async function listenAs(user: TestUser, channelId: number): Promise<ClientSocket> {
    const socket = SocketClient(baseUrl, { auth: { token: user.token } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    const joined = await new Promise<boolean>((resolve) => socket.emit('join:channel', channelId, resolve));
    expect(joined).toBe(true);
    return socket;
  }

  beforeAll(async () => {
    await prisma.personalAccessToken.deleteMany();
    [alice, bob, gina] = [await register('Awrite'), await register('Bwrite'), await register('Gwrite')];

    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'mcpw-pub' })).body.id;
    privId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'mcpw-priv', isPrivate: true })).body.id;
    bobPrivId = (await request(app).post('/channels').set(auth(bob)).send({ name: 'mcpw-bob-secret', isPrivate: true })).body.id;
    archivedId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'mcpw-archived' })).body.id;
    await request(app).post(`/channels/${pubId}/join`).set(auth(bob));
    await request(app).post(`/channels/${archivedId}/join`).set(auth(bob));
    // gina는 게스트: pub 멤버, 나머지 공개 채널은 비멤버
    await request(app).post(`/channels/${pubId}/join`).set(auth(gina));
    await prisma.user.update({ where: { id: gina.id }, data: { role: 'GUEST' } });

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    io.close();
    await new Promise((r) => httpServer.close(r));
  });

  beforeEach(() => mcpWriteLimiter.reset());

  describe('scopes', () => {
    it('hides write tools from read-only tokens and shows them with the matching scope', async () => {
      const readOnly = await connectClient((await createToken(alice, READ)).token);
      const names = (await readOnly.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['list_channels', 'read_channel']));
      for (const n of ['send_message', 'edit_message', 'delete_message', 'add_reaction', 'remove_reaction']) {
        expect(names).not.toContain(n);
      }
      // 숨긴 도구를 직접 불러도 실행되지 않는다
      expect((await call(readOnly, 'send_message', { channelId: pubId, content: 'sneaky' })).text).toContain('not found');

      const chatOnly = await connectClient((await createToken(alice, [...READ, 'chat:write'])).token);
      const chatNames = (await chatOnly.listTools()).tools.map((t) => t.name);
      expect(chatNames).toEqual(expect.arrayContaining(['send_message', 'edit_message', 'delete_message']));
      expect(chatNames).not.toContain('add_reaction');

      const reactOnly = await connectClient((await createToken(alice, ['reactions:write'])).token);
      expect((await reactOnly.listTools()).tools.map((t) => t.name).sort()).toEqual(['add_reaction', 'remove_reaction']);

      expect(await prisma.message.count({ where: { content: 'sneaky' } })).toBe(0);
    });

    it('warns the model about prompt injection in write tool descriptions', async () => {
      const c = await connectClient((await createToken(alice, [...READ, ...WRITE])).token);
      const tools = (await c.listTools()).tools;
      for (const n of ['send_message', 'edit_message', 'delete_message', 'add_reaction', 'remove_reaction']) {
        const tool = tools.find((t) => t.name === n)!;
        expect(tool.description).toContain('explicitly asked');
        expect(tool.annotations?.readOnlyHint).toBe(false);
      }
    });
  });

  describe('message CRUD round trip', () => {
    it('creates, reads, updates and deletes a message, repeatedly, with socket events', async () => {
      const claude = await connectClient((await createToken(alice, [...READ, ...WRITE])).token);
      const listener = await listenAs(bob, pubId);

      for (let i = 0; i < 3; i++) {
        // Create
        const newEvent = waitForEvent<any>(listener, 'message:new');
        const sent = await call(claude, 'send_message', { channelId: pubId, content: `hello from claude ${i}` });
        expect(sent.isError).toBe(false);
        const messageId = sent.data.id as number;
        const created = await newEvent;
        expect(created.id).toBe(messageId);
        expect(created.content).toBe(`hello from claude ${i}`);
        expect(created.user.id).toBe(alice.id);

        // Read(MCP와 REST 모두)
        const read = await call(claude, 'read_channel', { channelId: pubId, limit: 5 });
        expect(read.data.messages.at(-1)).toMatchObject({ id: messageId, content: `hello from claude ${i}` });
        const rest = await request(app).get(`/channels/${pubId}/messages`).set(auth(bob));
        expect(rest.body.messages.some((m: any) => m.id === messageId)).toBe(true);

        // Update
        const updEvent = waitForEvent<any>(listener, 'message:updated');
        const edited = await call(claude, 'edit_message', { messageId, content: `edited ${i}` });
        expect(edited.isError).toBe(false);
        expect(edited.data.editedAt).not.toBeNull();
        expect((await updEvent).content).toBe(`edited ${i}`);
        const afterEdit = await call(claude, 'read_channel', { channelId: pubId, limit: 5 });
        expect(afterEdit.data.messages.at(-1)).toMatchObject({ id: messageId, content: `edited ${i}` });
        expect(afterEdit.data.messages.at(-1).editedAt).not.toBeNull();

        // Delete
        const delEvent = waitForEvent<any>(listener, 'message:deleted');
        const deleted = await call(claude, 'delete_message', { messageId });
        expect(deleted.data).toMatchObject({ id: messageId, deleted: true });
        expect(await delEvent).toMatchObject({ messageId, channelId: pubId, threadId: null });
        const afterDel = await call(claude, 'read_channel', { channelId: pubId, limit: 5 });
        expect(afterDel.data.messages.some((m: any) => m.id === messageId)).toBe(false);
        // 지운 메시지는 다시 고치거나 지울 수 없다
        expect((await call(claude, 'edit_message', { messageId, content: 'again' })).isError).toBe(true);
        expect((await call(claude, 'delete_message', { messageId })).isError).toBe(true);
      }
      await settleBackgroundWork();
    });

    it('posts thread replies like the REST route and notifies mentions', async () => {
      const claude = await connectClient((await createToken(alice, [...READ, ...WRITE])).token);
      const parent = (await call(claude, 'send_message', { channelId: pubId, content: 'thread parent' })).data;
      const listener = await listenAs(bob, pubId);

      const evt = waitForEvent<any>(listener, 'message:new');
      const reply = await call(claude, 'send_message', {
        channelId: pubId,
        threadId: parent.id,
        content: `ping <@${bob.id}|${bob.name}> please look`,
      });
      expect(reply.isError).toBe(false);
      expect(reply.data.threadId).toBe(parent.id);
      expect((await evt).threadId).toBe(parent.id);

      const thread = await call(claude, 'read_thread', { messageId: parent.id });
      expect(thread.data.replies.map((r: any) => r.id)).toContain(reply.data.id);

      // 멘션 활동이 일반 경로와 똑같이 생긴다
      await settleBackgroundWork();
      const activities = await request(app).get('/activity').set(auth(bob));
      expect(JSON.stringify(activities.body)).toContain(String(reply.data.id));

      // 답글에 답글은 REST와 같은 규칙으로 막힌다
      const nested = await call(claude, 'send_message', { channelId: pubId, threadId: reply.data.id, content: 'nested' });
      expect(nested.isError).toBe(true);
      expect(nested.text).toContain('Cannot reply to a reply');
      // 다른 채널의 부모
      const wrongParent = await call(claude, 'send_message', { channelId: privId, threadId: parent.id, content: 'wrong' });
      expect(wrongParent.isError).toBe(true);
    });

    it('applies the same input validation as REST (length, null bytes, empty)', async () => {
      const claude = await connectClient((await createToken(alice, [...READ, ...WRITE])).token);
      expect((await call(claude, 'send_message', { channelId: pubId, content: 'a'.repeat(40001) })).isError).toBe(true);
      expect((await call(claude, 'send_message', { channelId: pubId, content: 'bad\u0000byte' })).isError).toBe(true);
      expect((await call(claude, 'send_message', { channelId: pubId, content: '   ' })).isError).toBe(true);
      expect((await call(claude, 'send_message', { channelId: -1, content: 'x' })).isError).toBe(true);
      const ok = await call(claude, 'send_message', { channelId: pubId, content: 'a'.repeat(40000) });
      expect(ok.isError).toBe(false);
      await call(claude, 'delete_message', { messageId: ok.data.id });
    });
  });

  describe('reactions', () => {
    it('adds and removes a reaction repeatedly with socket events and activity', async () => {
      const claude = await connectClient((await createToken(bob, [...READ, ...WRITE])).token);
      const msg = (await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: 'react to me' })).body;
      const listener = await listenAs(alice, pubId);

      for (let i = 0; i < 3; i++) {
        const added = waitForEvent<any>(listener, 'reaction:added');
        const res = await call(claude, 'add_reaction', { messageId: msg.id, emoji: '👍' });
        expect(res.isError).toBe(false);
        const evt = await added;
        expect(evt).toMatchObject({ messageId: msg.id });
        expect(evt.reaction).toMatchObject({ emoji: '👍', userId: bob.id });
        const view = await call(claude, 'read_channel', { channelId: pubId, limit: 5 });
        expect(view.data.messages.find((m: any) => m.id === msg.id).reactions).toEqual([{ emoji: '👍', count: 1 }]);

        // 중복 추가는 REST와 같이 거부
        expect((await call(claude, 'add_reaction', { messageId: msg.id, emoji: '👍' })).text).toBe('Reaction already exists');

        const removed = waitForEvent<any>(listener, 'reaction:removed');
        expect((await call(claude, 'remove_reaction', { messageId: msg.id, emoji: '👍' })).isError).toBe(false);
        expect(await removed).toMatchObject({ messageId: msg.id, emoji: '👍', userId: bob.id });
        expect((await call(claude, 'remove_reaction', { messageId: msg.id, emoji: '👍' })).text).toBe('Reaction not found');
      }
      // 쇼트코드와 형식 검사
      expect((await call(claude, 'add_reaction', { messageId: msg.id, emoji: ':tada:' })).isError).toBe(false);
      expect((await call(claude, 'add_reaction', { messageId: msg.id, emoji: 'NOT VALID!' })).isError).toBe(true);
      await call(claude, 'remove_reaction', { messageId: msg.id, emoji: ':tada:' });

      await settleBackgroundWork();
      // 남의 메시지에 단 리액션은 작성자 활동에 한 번 생겼다가 제거 시 사라진다
      const acts = await request(app).get('/activity?type=reactions').set(auth(alice));
      expect(JSON.stringify(acts.body)).not.toContain(`"messageId":${msg.id},"emoji"`);
    });
  });

  describe('permissions', () => {
    it('rejects writing to private channels the token owner is not in, and hides their existence', async () => {
      const claude = await connectClient((await createToken(alice, [...READ, ...WRITE])).token);
      const bobMsg = (await request(app).post(`/channels/${bobPrivId}/messages`).set(auth(bob)).send({ content: 'secret' })).body;

      const noChannel = await call(claude, 'send_message', { channelId: bobPrivId, content: 'intrude' });
      const missing = await call(claude, 'send_message', { channelId: 999999, content: 'intrude' });
      expect(noChannel.isError).toBe(true);
      expect(noChannel.text).toBe(missing.text); // 존재 여부를 알려 주지 않는다

      // 공개 채널이라도 비멤버는 쓸 수 없다(REST requireChannelMembership과 같다)
      const nonMemberPub = (await request(app).post('/channels').set(auth(bob)).send({ name: 'mcpw-bob-pub' })).body.id;
      expect((await call(claude, 'send_message', { channelId: nonMemberPub, content: 'hi' })).isError).toBe(true);

      for (const [tool, args] of [
        ['edit_message', { messageId: bobMsg.id, content: 'x' }],
        ['delete_message', { messageId: bobMsg.id }],
        ['add_reaction', { messageId: bobMsg.id, emoji: '👍' }],
        ['remove_reaction', { messageId: bobMsg.id, emoji: '👍' }],
      ] as const) {
        const res = await call(claude, tool, args);
        expect(res.isError).toBe(true);
        expect(res.text).toBe('Message not found or not accessible');
      }
      const row = await prisma.message.findUniqueOrThrow({ where: { id: bobMsg.id } });
      expect(row.content).toBe('secret');
      expect(row.deletedAt).toBeNull();
      expect(await prisma.message.count({ where: { channelId: bobPrivId, content: 'intrude' } })).toBe(0);
    });

    it("rejects editing or deleting someone else's message in a shared channel", async () => {
      const claude = await connectClient((await createToken(bob, [...READ, ...WRITE])).token);
      const aliceMsg = (await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: 'alice wrote' })).body;

      const edit = await call(claude, 'edit_message', { messageId: aliceMsg.id, content: 'hijacked' });
      expect(edit).toMatchObject({ isError: true, text: 'You can only edit your own messages' });
      const del = await call(claude, 'delete_message', { messageId: aliceMsg.id });
      expect(del).toMatchObject({ isError: true, text: 'You can only delete your own messages' });
      const row = await prisma.message.findUniqueOrThrow({ where: { id: aliceMsg.id } });
      expect(row.content).toBe('alice wrote');
      expect(row.deletedAt).toBeNull();
      // 하지만 리액션은 남의 메시지에도 달 수 있다
      expect((await call(claude, 'add_reaction', { messageId: aliceMsg.id, emoji: '👍' })).isError).toBe(false);
    });

    it('rejects every write in an archived channel but keeps reads working', async () => {
      const claude = await connectClient((await createToken(bob, [...READ, ...WRITE])).token);
      const msg = (await call(claude, 'send_message', { channelId: archivedId, content: 'before archive' })).data;
      await call(claude, 'add_reaction', { messageId: msg.id, emoji: '👍' });
      await prisma.channel.update({ where: { id: archivedId }, data: { archivedAt: new Date() } });

      const archived = 'This channel has been archived';
      expect((await call(claude, 'send_message', { channelId: archivedId, content: 'late' })).text).toBe(archived);
      expect((await call(claude, 'edit_message', { messageId: msg.id, content: 'late' })).text).toBe(archived);
      expect((await call(claude, 'delete_message', { messageId: msg.id })).text).toBe(archived);
      expect((await call(claude, 'add_reaction', { messageId: msg.id, emoji: '🎉' })).text).toBe(archived);
      expect((await call(claude, 'remove_reaction', { messageId: msg.id, emoji: '👍' })).text).toBe(archived);

      const read = await call(claude, 'read_channel', { channelId: archivedId });
      expect(read.data.messages.at(-1)).toMatchObject({ id: msg.id, content: 'before archive', deleted: false });
    });

    it('keeps guests inside the channels they were added to', async () => {
      const guest = await connectClient((await createToken(gina, [...READ, ...WRITE])).token);
      expect((await call(guest, 'send_message', { channelId: pubId, content: 'guest here' })).isError).toBe(false);
      expect((await call(guest, 'send_message', { channelId: archivedId, content: 'nope' })).isError).toBe(true);
      expect((await call(guest, 'send_message', { channelId: privId, content: 'nope' })).isError).toBe(true);
      const otherPub = (await request(app).post('/channels').set(auth(alice)).send({ name: 'mcpw-guest-no' })).body.id;
      const res = await call(guest, 'send_message', { channelId: otherPub, content: 'nope' });
      expect(res).toMatchObject({ isError: true, text: 'Channel not found or not accessible' });
    });

    it('stops working as soon as the token is revoked', async () => {
      const t = await createToken(alice, [...READ, ...WRITE]);
      const claude = await connectClient(t.token);
      expect((await call(claude, 'send_message', { channelId: pubId, content: 'before revoke' })).isError).toBe(false);
      await request(app).delete(`/tokens/${t.id}`).set(auth(alice));
      await expect(call(claude, 'send_message', { channelId: pubId, content: 'after revoke' })).rejects.toThrow(/Invalid token|401/);
      expect(await prisma.message.count({ where: { content: 'after revoke' } })).toBe(0);
    });
  });

  describe('rate limit and audit log', () => {
    it('limits write calls per token (30/min) without limiting reads or other tokens', async () => {
      const t1 = await connectClient((await createToken(alice, [...READ, ...WRITE])).token);
      const t2 = await connectClient((await createToken(alice, [...READ, ...WRITE])).token);
      const first = await call(t1, 'send_message', { channelId: pubId, content: 'limit probe' });
      const sentIds: number[] = [first.data.id];
      for (let i = 1; i < 30; i++) {
        const r = await call(t1, 'add_reaction', { messageId: first.data.id, emoji: i % 2 ? '👍' : ':tada:' });
        expect(r.text).not.toMatch(/Too many/);
      }
      const blocked = await call(t1, 'send_message', { channelId: pubId, content: 'over the limit' });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toMatch(/^Too many write requests for this token; retry in \d+ seconds$/);
      expect(await prisma.message.count({ where: { content: 'over the limit' } })).toBe(0);
      // 읽기는 영향이 없고, 다른 토큰은 따로 센다
      expect((await call(t1, 'read_channel', { channelId: pubId })).isError).toBe(false);
      expect((await call(t2, 'send_message', { channelId: pubId, content: 'other token ok' })).isError).toBe(false);
      void sentIds;
    });

    it('records tool and target id in the audit log but never the message body', async () => {
      const t = await createToken(alice, [...READ, ...WRITE]);
      const claude = await connectClient(t.token);
      await prisma.auditLog.deleteMany({ where: { action: 'mcp.tool_call', actorId: alice.id } });
      const secretBody = 'audit-secret-body-xyz';
      const sent = await call(claude, 'send_message', { channelId: pubId, content: secretBody });
      await call(claude, 'edit_message', { messageId: sent.data.id, content: `${secretBody}-edited` });
      await call(claude, 'delete_message', { messageId: sent.data.id });

      const find = async () => prisma.auditLog.findMany({ where: { action: 'mcp.tool_call', actorId: alice.id }, orderBy: { id: 'asc' } });
      const start = Date.now();
      let rows = await find();
      while (rows.length < 3 && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 50));
        rows = await find();
      }
      expect(rows.map((r) => [r.targetName, r.targetType, r.targetId])).toEqual([
        ['send_message', 'message', sent.data.id],
        ['edit_message', 'message', sent.data.id],
        ['delete_message', 'message', sent.data.id],
      ]);
      for (const row of rows) {
        expect(JSON.parse(row.details!)).toMatchObject({ via: 'mcp', tokenId: t.id, ok: true });
        expect(JSON.stringify(row)).not.toContain(secretBody);
      }
    });
  });
});
