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
import { initializeWebSocket, isUserOnline } from '../websocket/index.js';
import { settleBackgroundWork } from '../services/mentionService.js';
import webpush from 'web-push';
import { jest } from '@jest/globals';
import { mcpWriteLimiter } from '../mcp/rateLimit.js';

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-mcpdm@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const mention = (u: TestUser) => `<@${u.id}|${u.name}>`;

const CHANNEL_READ = ['channels:read', 'channels:history', 'users:read'];
const DM_READ = ['im:read', 'im:history'];
const DM_ALL = [...DM_READ, 'im:write'];
const DM_TOOLS = ['list_dms', 'read_dm', 'send_dm', 'edit_dm_message', 'delete_dm_message'];

const NOT_ACCESSIBLE_CONVERSATION = 'Conversation not found or not accessible';
const NOT_ACCESSIBLE_MESSAGE = 'Message not found or not accessible';

async function createToken(u: TestUser, scopes?: string[]) {
  const res = await request(app).post('/tokens').set(auth(u)).send({ name: 'claude', ...(scopes && { scopes }) });
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

describe('MCP DM tools (mcp-2b)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  let alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser, gina: TestUser, hank: TestUser;
  let groupId: number;
  let otherGroupId: number;
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

  async function listen(user: TestUser): Promise<ClientSocket> {
    const socket = SocketClient(baseUrl, { auth: { token: user.token } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  }

  const clientFor = async (u: TestUser, scopes: string[] = [...CHANNEL_READ, ...DM_ALL]) =>
    connectClient((await createToken(u, scopes)).token);

  beforeAll(async () => {
    await prisma.personalAccessToken.deleteMany();
    [alice, bob, carol, dave, gina, hank] = [
      await register('Adm'), await register('Bdm'), await register('Cdm'),
      await register('Ddm'), await register('Gdm'), await register('Hdm'),
    ];

    const created = await request(app).post('/dms/groups').set(auth(alice)).send({ userIds: [bob.id, carol.id] });
    groupId = created.body.group.id;
    // alice가 없는 그룹: 비참여자 검사용
    const other = await request(app).post('/dms/groups').set(auth(dave)).send({ userIds: [bob.id, carol.id] });
    otherGroupId = other.body.group.id;

    // gina는 게스트이고 alice와만 채널을 공유한다
    const pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'mcpdm-pub' })).body.id;
    // 가입 때 자동으로 들어간 기본 채널에서 gina를 빼고 pub 하나만 alice와 공유하게 한다
    await prisma.channelMember.deleteMany({ where: { userId: gina.id } });
    await request(app).post(`/channels/${pubId}/join`).set(auth(gina));
    await prisma.user.update({ where: { id: gina.id }, data: { role: 'GUEST' } });
    // bob과 gina 사이에는 예전 DM이 있지만 채널 공유가 없어 게스트에게는 보이면 안 된다
    await prisma.directMessage.create({ data: { content: 'old bob to gina', fromUserId: bob.id, toUserId: gina.id } });
    // 비활성 사용자
    await prisma.user.update({ where: { id: hank.id }, data: { deactivatedAt: new Date() } });

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

  // 사용자당 활성 토큰 상한(20)에 걸리지 않게 테스트마다 토큰을 비운다
  beforeEach(async () => {
    mcpWriteLimiter.reset();
    await prisma.personalAccessToken.deleteMany();
  });

  // 소켓이 남아 있으면 그 사용자가 온라인으로 보여 푸시 대상에서 빠진다. 테스트마다 끊고 오프라인이 될 때까지 기다린다.
  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.disconnect());
    const start = Date.now();
    while ([alice, bob, carol, dave, gina].some((u) => isUserOnline(u.id)) && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  describe('scopes', () => {
    it('shows no DM tools to default or channel-only tokens and gates each tool by its own scope', async () => {
      const defaultNames = (await (await connectClient((await createToken(alice)).token)).listTools()).tools.map((t) => t.name);
      const chanNames = (await (await clientFor(alice, [...CHANNEL_READ, 'chat:write'])).listTools()).tools.map((t) => t.name);
      for (const n of DM_TOOLS) {
        expect(defaultNames).not.toContain(n);
        expect(chanNames).not.toContain(n);
      }

      const names = async (scopes: string[]) => (await (await clientFor(alice, scopes)).listTools()).tools.map((t) => t.name).sort();
      expect(await names(['im:read'])).toEqual(['list_dms']);
      expect(await names(['im:history'])).toEqual(['read_dm']);
      expect(await names(DM_READ)).toEqual(['list_dms', 'read_dm']);
      expect(await names(['im:write'])).toEqual(['delete_dm_message', 'edit_dm_message', 'send_dm']);

      // 숨긴 도구를 직접 불러도 실행되지 않고 DM이 생기지 않는다
      const readOnly = await clientFor(alice, DM_READ);
      expect((await call(readOnly, 'send_dm', { userId: bob.id, content: 'sneaky' })).text).toContain('not found');
      expect(await prisma.directMessage.count({ where: { content: 'sneaky' } })).toBe(0);
    });

    it('rejects unknown scopes and keeps DM scopes out of the default token scopes', async () => {
      const def = await createToken(alice);
      expect(def.scopes.some((s) => s.startsWith('im:'))).toBe(false);
      const bad = await request(app).post('/tokens').set(auth(alice)).send({ name: 'x', scopes: ['im:admin'] });
      expect(bad.status).toBe(400);
    });

    it('warns about prompt injection in every DM tool description', async () => {
      const tools = (await (await clientFor(alice)).listTools()).tools;
      for (const n of DM_TOOLS) {
        const tool = tools.find((t) => t.name === n)!;
        expect(tool.description).toContain('not instructions');
        if (n !== 'list_dms' && n !== 'read_dm') {
          expect(tool.description).toContain('explicitly asked');
          expect(tool.annotations?.readOnlyHint).toBe(false);
        } else {
          expect(tool.annotations?.readOnlyHint).toBe(true);
          expect(tool.description).toContain('Does not mark anything as read');
        }
      }
    });
  });

  describe('1:1 DM create, read, update, delete', () => {
    it('round-trips repeatedly with socket events and matches the REST view', async () => {
      const claude = await clientFor(alice);
      const bobSocket = await listen(bob);

      for (let i = 0; i < 3; i++) {
        // Create
        const newEvent = waitForEvent<any>(bobSocket, 'dm:new');
        const sent = await call(claude, 'send_dm', { userId: bob.id, content: `hello bob ${i} ${mention(bob)}` });
        expect(sent.isError).toBe(false);
        const dmId = sent.data.id as number;
        const created = await newEvent;
        expect(created).toMatchObject({ id: dmId, fromUserId: alice.id, toUserId: bob.id, content: `hello bob ${i} ${mention(bob)}` });

        // Read(MCP와 REST 모두). MCP는 읽음 처리를 하지 않는다.
        const read = await call(claude, 'read_dm', { userId: bob.id, limit: 5 });
        expect(read.data.messages.at(-1)).toMatchObject({ id: dmId, fromUser: { id: alice.id }, toUserId: bob.id, groupId: null });
        const restAlice = await request(app).get(`/dms/${bob.id}`).set(auth(alice));
        expect(read.data.messages.map((m: any) => m.id)).toEqual(
          restAlice.body.messages.slice(0, 5).map((m: any) => m.id).reverse(),
        );
        // 받는 사람의 REST 읽음 처리는 MCP 쓰기와 무관하게 동작한다
        expect(restAlice.status).toBe(200);

        // Update
        const updEvent = waitForEvent<any>(bobSocket, 'dm:updated');
        const edited = await call(claude, 'edit_dm_message', { messageId: dmId, content: `edited ${i}` });
        expect(edited.isError).toBe(false);
        expect(edited.data.editedAt).not.toBeNull();
        expect(await updEvent).toMatchObject({ id: dmId, content: `edited ${i}` });
        const afterEdit = await call(claude, 'read_dm', { userId: bob.id, limit: 5 });
        expect(afterEdit.data.messages.at(-1)).toMatchObject({ id: dmId, content: `edited ${i}` });
        expect(afterEdit.data.messages.at(-1).editedAt).not.toBeNull();

        // Delete
        const delEvent = waitForEvent<any>(bobSocket, 'dm:deleted');
        const deleted = await call(claude, 'delete_dm_message', { messageId: dmId });
        expect(deleted.data).toMatchObject({ id: dmId, deleted: true });
        expect(await delEvent).toMatchObject({ dmId, fromUserId: alice.id, toUserId: bob.id });
        const afterDel = await call(claude, 'read_dm', { userId: bob.id, limit: 5 });
        expect(afterDel.data.messages.some((m: any) => m.id === dmId)).toBe(false);
        // 지운 메시지는 다시 고치거나 지울 수 없다
        expect((await call(claude, 'edit_dm_message', { messageId: dmId, content: 'again' })).text).toBe(NOT_ACCESSIBLE_MESSAGE);
        expect((await call(claude, 'delete_dm_message', { messageId: dmId })).text).toBe(NOT_ACCESSIBLE_MESSAGE);
      }
      await settleBackgroundWork();
    });

    it('supports notes-to-self and pages older messages with a cursor', async () => {
      const claude = await clientFor(alice);
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) ids.push((await call(claude, 'send_dm', { userId: alice.id, content: `note ${i}` })).data.id);
      const page1 = await call(claude, 'read_dm', { userId: alice.id, limit: 2 });
      expect(page1.data.messages.map((m: any) => m.id)).toEqual(ids.slice(1));
      expect(page1.data.nextCursor).toBe(ids[1]);
      const page2 = await call(claude, 'read_dm', { userId: alice.id, limit: 2, cursor: page1.data.nextCursor });
      expect(page2.data.messages.map((m: any) => m.id)).toEqual([ids[0]]);
      expect(page2.data.nextCursor).toBeNull();
      // 자기 DM은 읽음 상태로 저장된다(REST와 같음)
      expect((await prisma.directMessage.findUnique({ where: { id: ids[0] } }))!.readAt).not.toBeNull();
    });
  });

  describe('group DM create, read, update, delete', () => {
    it('round-trips repeatedly with socket events to every other member and matches the REST view', async () => {
      const claude = await clientFor(alice);
      const bobSocket = await listen(bob);
      const carolSocket = await listen(carol);

      for (let i = 0; i < 3; i++) {
        const bobNew = waitForEvent<any>(bobSocket, 'dm:new');
        const carolNew = waitForEvent<any>(carolSocket, 'dm:new');
        const sent = await call(claude, 'send_dm', { groupId, content: `hi group ${i}` });
        expect(sent.isError).toBe(false);
        const dmId = sent.data.id as number;
        expect(sent.data.groupId).toBe(groupId);
        expect(await bobNew).toMatchObject({ id: dmId, groupId, fromUserId: alice.id });
        expect(await carolNew).toMatchObject({ id: dmId, groupId });

        const read = await call(claude, 'read_dm', { groupId, limit: 5 });
        expect(read.data.messages.at(-1)).toMatchObject({ id: dmId, groupId, toUserId: null, content: `hi group ${i}` });
        const restBob = await request(app).get(`/dms/groups/${groupId}/messages`).set(auth(bob));
        expect(restBob.body.messages.some((m: any) => m.id === dmId)).toBe(true);
        expect(read.data.messages.map((m: any) => m.id)).toEqual(
          restBob.body.messages.slice(0, 5).map((m: any) => m.id).reverse(),
        );

        const bobUpd = waitForEvent<any>(bobSocket, 'dm:updated');
        const carolUpd = waitForEvent<any>(carolSocket, 'dm:updated');
        const edited = await call(claude, 'edit_dm_message', { messageId: dmId, content: `group edited ${i}` });
        expect(edited.isError).toBe(false);
        expect(await bobUpd).toMatchObject({ id: dmId, content: `group edited ${i}` });
        expect(await carolUpd).toMatchObject({ id: dmId });
        expect((await call(claude, 'read_dm', { groupId, limit: 5 })).data.messages.at(-1)).toMatchObject({ id: dmId, content: `group edited ${i}` });

        const bobDel = waitForEvent<any>(bobSocket, 'dm:deleted');
        const deleted = await call(claude, 'delete_dm_message', { messageId: dmId });
        expect(deleted.data).toMatchObject({ id: dmId, deleted: true });
        expect(await bobDel).toMatchObject({ dmId, groupId, fromUserId: alice.id });
        expect((await call(claude, 'read_dm', { groupId, limit: 5 })).data.messages.some((m: any) => m.id === dmId)).toBe(false);
        expect((await call(claude, 'edit_dm_message', { messageId: dmId, content: 'again' })).text).toBe(NOT_ACCESSIBLE_MESSAGE);
      }
      await settleBackgroundWork();
    });
  });

  describe('same effects as the normal REST and socket paths', () => {
    it('creates the same row, mention activity and push as the REST route', async () => {
      const claude = await clientFor(alice);
      const keys = webpush.generateVAPIDKeys();
      process.env.VAPID_PUBLIC_KEY = keys.publicKey;
      process.env.VAPID_PRIVATE_KEY = keys.privateKey;
      const pushSpy = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} } as never);
      // bob과 carol은 소켓이 없는 오프라인 사용자이고 푸시 구독이 있다
      for (const u of [bob, carol]) {
        await prisma.pushSubscription.create({ data: { userId: u.id, endpoint: `http://push.invalid/${u.id}`, p256dh: 'p', auth: 'a' } });
      }
      const pushedTo = () => pushSpy.mock.calls.map((c) => (c[0] as any).endpoint as string).sort();
      const payloads = () => pushSpy.mock.calls.map((c) => JSON.parse(c[1] as string));
      try {
        const rest = await request(app).post('/dms').set(auth(alice)).send({ toUserId: carol.id, content: `rest ${mention(carol)}` });
        expect(rest.status).toBe(201);
        await settleBackgroundWork();
        expect(pushedTo()).toEqual([`http://push.invalid/${carol.id}`]);
        const restPayload = payloads()[0];
        pushSpy.mockClear();

        const sent = await call(claude, 'send_dm', { userId: carol.id, content: `mcp ${mention(carol)}` });
        await settleBackgroundWork();
        expect(pushedTo()).toEqual([`http://push.invalid/${carol.id}`]);
        expect(payloads()[0]).toEqual({ ...restPayload, body: `mcp ${mention(carol)}`.slice(0, 100) });

        // REST와 MCP가 만든 행은 같은 모양이다
        const [restRow, mcpRow] = await Promise.all([
          prisma.directMessage.findUnique({ where: { id: rest.body.id } }),
          prisma.directMessage.findUnique({ where: { id: sent.data.id } }),
        ]);
        expect(Object.keys(mcpRow!).sort()).toEqual(Object.keys(restRow!).sort());
        expect(mcpRow).toMatchObject({ fromUserId: alice.id, toUserId: carol.id, groupId: null, readAt: null, threadId: null });

        // 멘션 활동: REST로 만든 것과 MCP로 만든 것이 모두 carol에게 생긴다
        const activities = await prisma.activity.findMany({ where: { userId: carol.id, dmId: { in: [rest.body.id, sent.data.id] } } });
        expect(activities.map((a) => a.dmId).sort()).toEqual([rest.body.id, sent.data.id].sort());

        // 그룹 DM: 오프라인 멤버(bob, carol)에게 푸시가 가고 멘션 활동이 생긴다
        pushSpy.mockClear();
        const g = await call(claude, 'send_dm', { groupId, content: `group ${mention(bob)}` });
        await settleBackgroundWork();
        expect(pushedTo()).toEqual([`http://push.invalid/${bob.id}`, `http://push.invalid/${carol.id}`].sort());
        expect(payloads()[0]).toMatchObject({ url: `/g/${groupId}` });
        expect(await prisma.activity.count({ where: { userId: bob.id, dmId: g.data.id } })).toBe(1);
      } finally {
        pushSpy.mockRestore();
        delete process.env.VAPID_PUBLIC_KEY;
        delete process.env.VAPID_PRIVATE_KEY;
        await prisma.pushSubscription.deleteMany({ where: { userId: { in: [bob.id, carol.id] } } });
      }
    });

    it('sends over the socket through the same service and keeps the guest and deactivated rules', async () => {
      const aliceSocket = await listen(alice);
      const bobSocket = await listen(bob);
      const evt = waitForEvent<any>(bobSocket, 'dm:new');
      aliceSocket.emit('dm:send', { toUserId: bob.id, content: 'via socket' });
      expect(await evt).toMatchObject({ fromUserId: alice.id, toUserId: bob.id, content: 'via socket' });

      const ginaSocket = await listen(gina);
      const err = waitForEvent<any>(ginaSocket, 'error');
      ginaSocket.emit('dm:send', { toUserId: bob.id, content: 'guest to stranger' });
      expect(await err).toEqual({ message: 'Unable to send message' });
      const err2 = waitForEvent<any>(aliceSocket, 'error');
      aliceSocket.emit('dm:send', { toUserId: hank.id, content: 'to deactivated' });
      expect(await err2).toEqual({ message: 'Unable to send message' });
      expect(await prisma.directMessage.count({ where: { content: { in: ['guest to stranger', 'to deactivated'] } } })).toBe(0);
    });

    it('keeps REST rules after the refactor (guest, deactivated, owner-only edit/delete)', async () => {
      expect((await request(app).post('/dms').set(auth(gina)).send({ toUserId: bob.id, content: 'x' })).status).toBe(400);
      expect((await request(app).post('/dms').set(auth(alice)).send({ toUserId: hank.id, content: 'x' })).status).toBe(400);
      const dm = (await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'mine' })).body;
      expect((await request(app).patch(`/dms/messages/${dm.id}`).set(auth(bob)).send({ content: 'hijack' })).status).toBe(403);
      expect((await request(app).delete(`/dms/messages/${dm.id}`).set(auth(bob))).status).toBe(403);
      expect((await request(app).patch(`/dms/messages/${dm.id}`).set(auth(alice)).send({ content: 'ok' })).body.content).toBe('ok');
      expect((await request(app).delete(`/dms/messages/${dm.id}`).set(auth(alice))).status).toBe(200);
      expect((await request(app).patch(`/dms/messages/${dm.id}`).set(auth(alice)).send({ content: 'ok' })).status).toBe(404);
    });
  });

  describe('events reach the author\'s other tabs too', () => {
    it('sends dm:updated and dm:deleted to the author, the other side and group members, for 1:1, group and self DMs', async () => {
      const claude = await clientFor(alice);
      const aliceTab = await listen(alice);
      const bobSocket = await listen(bob);
      const carolSocket = await listen(carol);
      const collect = (s: ClientSocket, event: string) => {
        const got: any[] = [];
        s.on(event, (p) => got.push(p));
        return got;
      };
      const waitUntil = async (fn: () => boolean) => {
        const start = Date.now();
        while (!fn() && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
        expect(fn()).toBe(true);
      };
      // 한 소켓에 이벤트별 수집기를 한 번만 붙이고 반복마다 비운다
      const tabUpd = collect(aliceTab, 'dm:updated'), tabDel = collect(aliceTab, 'dm:deleted');
      const bobUpd = collect(bobSocket, 'dm:updated'), bobDel = collect(bobSocket, 'dm:deleted');
      const carolDel = collect(carolSocket, 'dm:deleted');
      const reset = () => { for (const a of [tabUpd, tabDel, bobUpd, bobDel, carolDel]) a.length = 0; };

      for (let i = 0; i < 2; i++) {
        // 1:1: 작성자 탭과 상대 모두 받고, 삭제 payload에 threadId가 있다
        reset();
        const one = (await call(claude, 'send_dm', { userId: bob.id, content: `tab ${i}` })).data.id;
        await call(claude, 'edit_dm_message', { messageId: one, content: `tab edited ${i}` });
        await call(claude, 'delete_dm_message', { messageId: one });
        await waitUntil(() => tabUpd.length === 1 && tabDel.length === 1 && bobUpd.length === 1 && bobDel.length === 1);
        expect(tabUpd[0]).toMatchObject({ id: one, content: `tab edited ${i}` });
        expect(tabDel[0]).toEqual({ dmId: one, fromUserId: alice.id, toUserId: bob.id, groupId: null, threadId: null });
        expect(bobDel[0]).toEqual(tabDel[0]);

        // 그룹: 작성자 탭과 다른 멤버 모두 받는다
        reset();
        const g = (await call(claude, 'send_dm', { groupId, content: `gtab ${i}` })).data.id;
        await call(claude, 'edit_dm_message', { messageId: g, content: `gtab edited ${i}` });
        await call(claude, 'delete_dm_message', { messageId: g });
        await waitUntil(() => tabUpd.length === 1 && tabDel.length === 1 && carolDel.length === 1);
        expect(tabDel[0]).toEqual({ dmId: g, fromUserId: alice.id, toUserId: null, groupId, threadId: null });

        // 나와의 대화: 작성자 탭이 한 번만 받는다(중복 방 전송 없음)
        reset();
        const note = (await call(claude, 'send_dm', { userId: alice.id, content: `note ${i}` })).data.id;
        await call(claude, 'edit_dm_message', { messageId: note, content: `note edited ${i}` });
        await call(claude, 'delete_dm_message', { messageId: note });
        await waitUntil(() => tabUpd.length === 1 && tabDel.length === 1);
        await new Promise((r) => setTimeout(r, 150));
        expect(tabUpd).toHaveLength(1);
        expect(tabDel).toHaveLength(1);
        expect(tabDel[0]).toEqual({ dmId: note, fromUserId: alice.id, toUserId: alice.id, groupId: null, threadId: null });
        expect((await call(claude, 'read_dm', { userId: alice.id })).data.messages.some((m: any) => m.id === note)).toBe(false);
      }

      // REST 경로도 같은 서비스라 같은 이벤트를 낸다
      reset();
      const dm = (await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'rest tab' })).body;
      expect((await request(app).patch(`/dms/messages/${dm.id}`).set(auth(alice)).send({ content: 'rest tab edited' })).status).toBe(200);
      expect((await request(app).delete(`/dms/messages/${dm.id}`).set(auth(alice))).status).toBe(200);
      await waitUntil(() => tabUpd.length === 1 && tabDel.length === 1);
    });
  });

  describe('group mention activity is created exactly once', () => {
    it('creates one activity per mentioned member for MCP, REST, thread reply and socket sends, and edits do not add more', async () => {
      const claude = await clientFor(alice);
      const count = (dmId: number) => prisma.activity.count({ where: { userId: bob.id, dmId } });

      const viaMcp = (await call(claude, 'send_dm', { groupId, content: `mcp ${mention(bob)}` })).data.id;
      const viaRest = (await request(app).post(`/dms/groups/${groupId}/messages`).set(auth(alice)).send({ content: `rest ${mention(bob)}` })).body.id;
      const reply = (await request(app).post(`/dms/messages/${viaRest}/reply`).set(auth(alice)).send({ content: `reply ${mention(bob)}` })).body.id;
      const aliceSocket = await listen(alice);
      const sockId = await new Promise<number>((resolve) =>
        aliceSocket.emit('dmgroup:send', { groupId, content: `socket ${mention(bob)}` }, (r: any) => resolve(r.id)));
      await settleBackgroundWork();
      for (const id of [viaMcp, viaRest, reply, sockId]) expect(await count(id)).toBe(1);

      // 수정해도 활동이 늘지 않는다
      await call(claude, 'edit_dm_message', { messageId: viaMcp, content: `mcp edited ${mention(bob)}` });
      await settleBackgroundWork();
      expect(await count(viaMcp)).toBe(1);
    });
  });

  describe('REST: a member who left cannot edit or delete their own group messages', () => {
    it('answers 403 for PATCH and DELETE and keeps the message', async () => {
      const g = (await request(app).post('/dms/groups').set(auth(dave)).send({ userIds: [alice.id, carol.id] })).body.group.id as number;
      const mine = (await request(app).post(`/dms/groups/${g}/messages`).set(auth(dave)).send({ content: 'dave before leaving' })).body.id;
      expect((await request(app).patch(`/dms/messages/${mine}`).set(auth(dave)).send({ content: 'ok while member' })).status).toBe(200);
      expect((await request(app).delete(`/dms/groups/${g}/members/me`).set(auth(dave))).status).toBe(200);
      expect((await request(app).patch(`/dms/messages/${mine}`).set(auth(dave)).send({ content: 'after leaving' })).status).toBe(403);
      expect((await request(app).delete(`/dms/messages/${mine}`).set(auth(dave))).status).toBe(403);
      const row = await prisma.directMessage.findUnique({ where: { id: mine } });
      expect(row).toMatchObject({ content: 'ok while member', deletedAt: null });
    });
  });

  describe('list_dms limit', () => {
    it('applies the limit per kind to the most recent conversations', async () => {
      const claude = await clientFor(alice);
      const g2 = (await request(app).post('/dms/groups').set(auth(alice)).send({ userIds: [bob.id, dave.id] })).body.group.id as number;
      await call(claude, 'send_dm', { groupId: g2, content: 'newest group' });
      await call(claude, 'send_dm', { userId: dave.id, content: 'newest direct' });
      const one = await call(claude, 'list_dms', { limit: 1 });
      expect(one.data.direct).toHaveLength(1);
      expect(one.data.groups).toHaveLength(1);
      expect(one.data.direct[0]).toMatchObject({ userId: dave.id, lastMessage: { content: 'newest direct' } });
      expect(one.data.groups[0]).toMatchObject({ groupId: g2, lastMessage: { content: 'newest group' } });
      expect(Object.keys(one.data.direct[0]).sort()).toEqual(['lastMessage', 'name', 'unreadCount', 'userId']);
      const all = await call(claude, 'list_dms', { limit: 100 });
      expect(all.data.groups.map((c: any) => c.groupId)).toEqual(expect.arrayContaining([g2, groupId]));
    });
  });

  describe('read tools do not mark anything as read', () => {
    it('leaves readAt, the group read cursor and mention counts untouched', async () => {
      const claude = await clientFor(alice);
      const fromBob = (await request(app).post('/dms').set(auth(bob)).send({ toUserId: alice.id, content: `unread ${mention(alice)}` })).body;
      const groupMsg = (await request(app).post(`/dms/groups/${groupId}/messages`).set(auth(bob)).send({ content: 'group unread' })).body;
      await settleBackgroundWork();
      const cursorBefore = (await prisma.dMGroupMember.findUnique({ where: { groupId_userId: { groupId, userId: alice.id } } }))!.lastReadDmId;
      const mentionsBefore = (await request(app).get('/activity/mention-counts').set(auth(alice))).body;

      const list = await call(claude, 'list_dms');
      const readOne = await call(claude, 'read_dm', { userId: bob.id });
      const readGroup = await call(claude, 'read_dm', { groupId });
      expect(readOne.data.messages.some((m: any) => m.id === fromBob.id)).toBe(true);
      expect(readGroup.data.messages.some((m: any) => m.id === groupMsg.id)).toBe(true);
      expect(list.data.direct.find((c: any) => c.userId === bob.id).unreadCount).toBeGreaterThanOrEqual(1);

      expect((await prisma.directMessage.findUnique({ where: { id: fromBob.id } }))!.readAt).toBeNull();
      expect((await prisma.dMGroupMember.findUnique({ where: { groupId_userId: { groupId, userId: alice.id } } }))!.lastReadDmId).toBe(cursorBefore);
      expect((await request(app).get('/activity/mention-counts').set(auth(alice))).body).toEqual(mentionsBefore);
      const rest = await request(app).get('/dms').set(auth(alice));
      expect(rest.body.find((c: any) => c.otherUser.id === bob.id).unreadCount).toBe(list.data.direct.find((c: any) => c.userId === bob.id).unreadCount);
    });

    it('lists 1:1 and group conversations like the REST lists', async () => {
      const claude = await clientFor(alice);
      const list = await call(claude, 'list_dms');
      const restDirect = (await request(app).get('/dms').set(auth(alice))).body as any[];
      const restGroups = (await request(app).get('/dms/groups').set(auth(alice))).body as any[];
      expect(list.data.direct.map((c: any) => [c.userId, c.unreadCount, c.lastMessage?.id])).toEqual(
        restDirect.map((c) => [c.otherUser.id, c.unreadCount, c.lastMessage?.id]),
      );
      expect(list.data.groups.map((c: any) => [c.groupId, c.unreadCount, c.lastMessage?.id])).toEqual(
        restGroups.map((c) => [c.group.id, c.unreadCount, c.lastMessage?.id]),
      );
      expect(list.data.groups[0].members.map((m: any) => m.id).sort()).toEqual([alice.id, bob.id, carol.id].sort());
      expect((await call(claude, 'list_dms', { limit: 1 })).data.direct).toHaveLength(1);
    });
  });

  describe('permissions', () => {
    it('answers non-members and missing targets with the same error', async () => {
      const claude = await clientFor(alice);
      // alice는 otherGroup 멤버가 아니다. 없는 그룹과 같은 문구여야 한다.
      for (const gid of [otherGroupId, 999999]) {
        expect((await call(claude, 'read_dm', { groupId: gid })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
        expect((await call(claude, 'send_dm', { groupId: gid, content: 'intruder' })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
      }
      expect((await call(claude, 'read_dm', { userId: 999999 })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
      expect((await call(claude, 'send_dm', { userId: 999999, content: 'ghost' })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
      expect((await call(claude, 'send_dm', { userId: hank.id, content: 'to deactivated' })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
      expect(await prisma.directMessage.count({ where: { content: { in: ['intruder', 'ghost', 'to deactivated'] } } })).toBe(0);

      // 남의 대화에 있는 메시지 id로 수정·삭제하면 없는 id와 같은 문구
      const secret = (await request(app).post(`/dms/groups/${otherGroupId}/messages`).set(auth(dave)).send({ content: 'dave secret' })).body;
      const private1to1 = (await request(app).post('/dms').set(auth(bob)).send({ toUserId: carol.id, content: 'bob to carol' })).body;
      for (const id of [secret.id, private1to1.id, 999999]) {
        expect((await call(claude, 'edit_dm_message', { messageId: id, content: 'hijack' })).text).toBe(NOT_ACCESSIBLE_MESSAGE);
        expect((await call(claude, 'delete_dm_message', { messageId: id })).text).toBe(NOT_ACCESSIBLE_MESSAGE);
      }
      const bobRead = await call(claude, 'read_dm', { userId: bob.id });
      expect(JSON.stringify(bobRead.data)).not.toContain('bob to carol');
      expect((await prisma.directMessage.findUnique({ where: { id: secret.id } }))!.content).toBe('dave secret');
      expect((await prisma.directMessage.findUnique({ where: { id: secret.id } }))!.deletedAt).toBeNull();
    });

    it('lets participants touch only their own messages', async () => {
      const claude = await clientFor(alice);
      const fromBob = (await request(app).post('/dms').set(auth(bob)).send({ toUserId: alice.id, content: 'bob wrote' })).body;
      const fromBobGroup = (await request(app).post(`/dms/groups/${groupId}/messages`).set(auth(bob)).send({ content: 'bob group' })).body;
      for (const id of [fromBob.id, fromBobGroup.id]) {
        expect((await call(claude, 'edit_dm_message', { messageId: id, content: 'rewrite' })).text).toBe('You can only modify your own messages');
        expect((await call(claude, 'delete_dm_message', { messageId: id })).text).toBe('You can only modify your own messages');
      }
      expect((await prisma.directMessage.findUnique({ where: { id: fromBob.id } }))!.content).toBe('bob wrote');
    });

    it('denies a member who left the group, even for their own old messages', async () => {
      const fresh = await request(app).post('/dms/groups').set(auth(carol)).send({ userIds: [bob.id, dave.id] });
      const gid = fresh.body.group.id as number;
      const claude = await clientFor(carol);
      const mine = (await call(claude, 'send_dm', { groupId: gid, content: 'before leaving' })).data.id as number;
      expect((await request(app).delete(`/dms/groups/${gid}/members/me`).set(auth(carol))).status).toBe(200);
      expect((await call(claude, 'read_dm', { groupId: gid })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
      expect((await call(claude, 'send_dm', { groupId: gid, content: 'after leaving' })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
      expect((await call(claude, 'edit_dm_message', { messageId: mine, content: 'edit' })).text).toBe(NOT_ACCESSIBLE_MESSAGE);
      expect((await call(claude, 'delete_dm_message', { messageId: mine })).text).toBe(NOT_ACCESSIBLE_MESSAGE);
      expect((await prisma.directMessage.findUnique({ where: { id: mine } }))!.deletedAt).toBeNull();
      expect(await prisma.directMessage.count({ where: { content: 'after leaving' } })).toBe(0);
    });

    it('isolates guests: only people sharing a channel can be read or written', async () => {
      const guest = await clientFor(gina);
      // 채널을 공유하지 않는 bob: 예전 DM이 있어도 존재하지 않는 사용자와 같은 오류
      for (const uid of [bob.id, 999999]) {
        expect((await call(guest, 'read_dm', { userId: uid })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
        expect((await call(guest, 'send_dm', { userId: uid, content: 'guest probe' })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
      }
      expect(await prisma.directMessage.count({ where: { content: 'guest probe' } })).toBe(0);
      // 목록에도 bob과의 대화는 없다
      const list = await call(guest, 'list_dms');
      expect(list.data.direct.map((c: any) => c.userId)).not.toContain(bob.id);

      // 채널을 공유하는 alice에게는 보내고 읽고 고치고 지울 수 있다
      const sent = await call(guest, 'send_dm', { userId: alice.id, content: 'guest hello' });
      expect(sent.isError).toBe(false);
      expect((await call(guest, 'read_dm', { userId: alice.id })).data.messages.at(-1).content).toBe('guest hello');
      expect((await call(guest, 'edit_dm_message', { messageId: sent.data.id, content: 'guest edited' })).isError).toBe(false);
      expect((await call(guest, 'delete_dm_message', { messageId: sent.data.id })).isError).toBe(false);
      // 게스트가 속하지 않은 그룹은 읽을 수 없다
      expect((await call(guest, 'read_dm', { groupId })).text).toBe(NOT_ACCESSIBLE_CONVERSATION);
    });

    it('validates arguments', async () => {
      const claude = await clientFor(alice);
      expect((await call(claude, 'send_dm', { content: 'no target' })).text).toBe('Provide exactly one of userId or groupId');
      expect((await call(claude, 'send_dm', { userId: bob.id, groupId, content: 'both' })).text).toBe('Provide exactly one of userId or groupId');
      expect((await call(claude, 'read_dm', {})).text).toBe('Provide exactly one of userId or groupId');
      expect((await call(claude, 'send_dm', { userId: bob.id, content: '   ' })).isError).toBe(true);
      expect((await call(claude, 'send_dm', { userId: bob.id, content: 'a\u0000b' })).isError).toBe(true);
      expect((await call(claude, 'edit_dm_message', { messageId: 1, content: '' })).isError).toBe(true);
      expect(await prisma.directMessage.count({ where: { content: { in: ['no target', 'both'] } } })).toBe(0);
    });
  });

  describe('rate limit and audit log', () => {
    it('counts DM writes in the shared per-token write limit', async () => {
      const claude = await clientFor(alice);
      for (let i = 0; i < 30; i++) {
        expect((await call(claude, 'send_dm', { userId: alice.id, content: `limit ${i}` })).text).not.toMatch(/Too many/);
      }
      const blocked = await call(claude, 'send_dm', { userId: alice.id, content: 'over the limit' });
      expect(blocked.text).toMatch(/^Too many write requests for this token; retry in \d+ seconds$/);
      expect((await call(claude, 'read_dm', { userId: alice.id })).isError).toBe(false);
      expect(await prisma.directMessage.count({ where: { content: 'over the limit' } })).toBe(0);
    });

    it('records tool and target id in the audit log but never the DM body', async () => {
      const t = await createToken(alice, DM_ALL);
      const claude = await connectClient(t.token);
      await prisma.auditLog.deleteMany({ where: { action: 'mcp.tool_call', actorId: alice.id } });
      const secretBody = 'dm-audit-secret-body-xyz';
      const sent = await call(claude, 'send_dm', { userId: bob.id, content: secretBody });
      await call(claude, 'edit_dm_message', { messageId: sent.data.id, content: `${secretBody}-edited` });
      await call(claude, 'delete_dm_message', { messageId: sent.data.id });

      const find = async () => prisma.auditLog.findMany({ where: { action: 'mcp.tool_call', actorId: alice.id }, orderBy: { id: 'asc' } });
      const start = Date.now();
      let rows = await find();
      while (rows.length < 3 && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 50));
        rows = await find();
      }
      expect(rows.map((r) => [r.targetName, r.targetType, r.targetId])).toEqual([
        ['send_dm', 'direct_message', sent.data.id],
        ['edit_dm_message', 'direct_message', sent.data.id],
        ['delete_dm_message', 'direct_message', sent.data.id],
      ]);
      for (const row of rows) {
        expect(JSON.parse(row.details!)).toMatchObject({ via: 'mcp', tokenId: t.id, ok: true });
        expect(JSON.stringify(row)).not.toContain(secretBody);
      }
    });
  });
});
