import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { listenOnLoopback } from './listenLoopback.js';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket, isUserOnline } from '../websocket/index.js';
import { jest } from '@jest/globals';
import {
  settleBackgroundWork as settle,
  activityQueue,
  messageKey,
  dmKey,
  parseMentions,
  createReactionActivity,
} from '../services/mentionService.js';
import { KeyedQueue } from '../utils/keyedQueue.js';

// 활동 생성은 응답·ack 뒤에서 await 없이 돈다. 생성 → 조회 → 수정 → 삭제를 기다리지 않고 연달아 보내도
// 백그라운드 작업이 끝난 뒤의 결과가 맞는지(지운 메시지의 활동이 남지 않는지) 확인한다.

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-race@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const mention = (u: TestUser) => `<@${u.id}|${u.name}>`;
const ROUNDS = 5;
const CRUD_ROUNDS = 20;

/** 조건에 맞는 이벤트를 count개 받을 때까지 기다린다. 오지 않으면 실패한다. */
function waitFor<T>(s: ClientSocket, event: string, match: (p: T) => boolean, count = 1): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const got: T[] = [];
    const on = (p: T) => {
      if (!match(p)) return;
      got.push(p);
      if (got.length < count) return;
      clearTimeout(timer);
      s.off(event, on);
      resolve(got);
    };
    const timer = setTimeout(() => {
      s.off(event, on);
      reject(new Error(`timed out waiting for ${event}`));
    }, 5000);
    s.on(event, on);
  });
}

describe('Activity: rapid CRUD overlapping background work', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  let alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser, erin: TestUser, frank: TestUser;
  let pubId: number;
  const sockets: ClientSocket[] = [];

  const activities = async (where: object) => {
    await settle();
    return prisma.activity.findMany({ where, orderBy: { id: 'asc' } });
  };
  const mentionCounts = async (u: TestUser) => {
    await settle();
    return (await request(app).get('/activity/mention-counts').set(auth(u))).body;
  };

  function connect(u: TestUser): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = Client(`http://127.0.0.1:${port}`, { auth: { token: u.token }, forceNew: true });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  beforeAll(async () => {
    [alice, bob, carol] = [await register('Alice'), await register('Bob'), await register('Carol')];
    [dave, erin, frank] = [await register('Dave'), await register('Erin'), await register('Frank')];
    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'race-pub' })).body.id;
    for (const u of [bob, carol, dave, erin, frank]) await request(app).post(`/channels/${pubId}/join`).set(auth(u));

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    port = await listenOnLoopback(httpServer);
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    // io.close()는 붙은 HTTP 서버도 닫는다. 끊김 처리가 남긴 presence 쓰기까지 끝난 뒤 다음 파일로 넘어간다.
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await settle();
  });

  afterEach(async () => {
    await settle();
    await prisma.activity.deleteMany();
  });

  it('HTTP channel message: create → read → edit → delete back to back leaves no activity', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const created = await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: `c${i} ${mention(bob)}` });
      expect(created.status).toBe(201);
      const id = created.body.id;
      const read = await request(app).get(`/channels/${pubId}/messages`).set(auth(bob));
      expect(read.body.messages.some((m: { id: number }) => m.id === id)).toBe(true);
      const edited = await request(app).patch(`/messages/${id}`).set(auth(alice)).send({ content: `c${i} ${mention(carol)}` });
      expect(edited.status).toBe(200);
      expect((await request(app).delete(`/messages/${id}`).set(auth(alice))).status).toBe(200);
    }
    expect(await activities({})).toHaveLength(0);
    expect((await mentionCounts(bob)).channels[pubId] ?? 0).toBe(0);
    expect((await mentionCounts(carol)).channels[pubId] ?? 0).toBe(0);
  });

  it('HTTP channel message: an edit right after create wins over the create-time mentions', async () => {
    const ids: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const created = await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: `e${i} ${mention(bob)}` });
      ids.push(created.body.id);
      await request(app).patch(`/messages/${created.body.id}`).set(auth(alice)).send({ content: `e${i} ${mention(carol)}` });
    }
    const rows = await activities({ messageId: { in: ids } });
    expect(rows.map((r) => r.userId)).toEqual(ids.map(() => carol.id));
    for (const id of ids) await request(app).delete(`/messages/${id}`).set(auth(alice));
    expect(await activities({})).toHaveLength(0);
  });

  it('thread reply: create → edit → delete back to back leaves no activity', async () => {
    const parent = await request(app).post(`/channels/${pubId}/messages`).set(auth(bob)).send({ content: 'parent' });
    for (let i = 0; i < ROUNDS; i++) {
      const reply = await request(app).post(`/messages/${parent.body.id}/reply`).set(auth(alice)).send({ content: `r${i} ${mention(carol)}` });
      expect(reply.status).toBe(201);
      await request(app).patch(`/messages/${reply.body.id}`).set(auth(alice)).send({ content: `r${i} edited` });
      expect((await request(app).delete(`/messages/${reply.body.id}`).set(auth(alice))).status).toBe(200);
    }
    expect(await activities({})).toHaveLength(0);
  });

  it('reaction: add → remove back to back leaves no REACTION activity', async () => {
    const msg = await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: 'react to me' });
    for (let i = 0; i < ROUNDS; i++) {
      expect((await request(app).post(`/messages/${msg.body.id}/reactions`).set(auth(bob)).send({ emoji: '👍' })).status).toBe(201);
      const listed = await request(app).get(`/messages/${msg.body.id}/reactions`).set(auth(bob));
      expect(listed.status).toBe(200);
      expect((await request(app).delete(`/messages/${msg.body.id}/reactions/${encodeURIComponent('👍')}`).set(auth(bob))).status).toBe(200);
    }
    expect(await activities({ type: 'REACTION' })).toHaveLength(0);
  });

  it('DM: create → edit → delete back to back leaves no activity', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const dm = await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: `d${i} ${mention(bob)}` });
      expect(dm.status).toBe(201);
      const read = await request(app).get(`/dms/${alice.id}`).set(auth(bob));
      expect(read.status).toBe(200);
      await request(app).patch(`/dms/messages/${dm.body.id}`).set(auth(alice)).send({ content: `d${i} edited ${mention(bob)}` });
      expect((await request(app).delete(`/dms/messages/${dm.body.id}`).set(auth(alice))).status).toBe(200);
    }
    expect(await activities({})).toHaveLength(0);
    expect((await mentionCounts(bob)).dms[alice.id] ?? 0).toBe(0);
  });

  it('WebSocket: message:send right after connect is acked (handlers are attached before presence work)', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const s = await connect(carol);
      const ack = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => resolve('no ack'), 2000);
        s.emit('message:send', { channelId: pubId, content: `fresh ${i}` }, (res: unknown) => {
          clearTimeout(timer);
          resolve(res);
        });
      });
      expect(ack).toEqual({});
      s.disconnect();
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  it('WebSocket: send → edit → delete back to back leaves no activity', async () => {
    const s = await connect(alice);
    for (let i = 0; i < ROUNDS; i++) {
      const created = new Promise<any>((resolve) => s.once('message:new', resolve));
      s.emit('message:send', { channelId: pubId, content: `w${i} ${mention(bob)}` });
      const msg = await created;
      s.emit('message:edit', { messageId: msg.id, content: `w${i} ${mention(carol)}` });
      const deleted = new Promise<void>((resolve) => s.once('message:deleted', () => resolve()));
      await new Promise((resolve) => s.emit('join:channel', pubId, resolve));
      s.emit('message:delete', { messageId: msg.id });
      await deleted;
    }
    expect(await activities({})).toHaveLength(0);
  });

  /** 큐 작업이 끝난 뒤 메시지의 멘션 활동이 DB의 최종 내용(삭제면 없음)과 같은지 본다. */
  async function expectMentionsMatchMessage(id: number): Promise<void> {
    await settle();
    const msg = await prisma.message.findUniqueOrThrow({ where: { id } });
    const rows = await prisma.activity.findMany({ where: { messageId: id } });
    if (msg.deletedAt) {
      expect(rows).toHaveLength(0);
      return;
    }
    const expected = parseMentions(msg.content).userIds.filter((u) => u !== msg.userId).sort();
    expect(rows.filter((r) => r.type === 'MENTION').map((r) => r.userId).sort()).toEqual(expected);
  }

  it('CRUD x20: concurrent HTTP and WS edits leave activities matching the committed content', async () => {
    const s = await connect(dave);
    await new Promise((resolve) => s.emit('join:channel', pubId, resolve));
    for (let i = 0; i < CRUD_ROUNDS; i++) {
      // Create
      const created = await request(app).post(`/channels/${pubId}/messages`).set(auth(dave)).send({ content: `x${i} ${mention(bob)}` });
      expect(created.status).toBe(201);
      const id = created.body.id;
      await expectMentionsMatchMessage(id);
      // Read
      const feed = await request(app).get('/activity').set(auth(bob));
      expect(feed.body.items.some((a: { messageId: number }) => a.messageId === id)).toBe(true);
      // Update: 두 경로가 동시에 편집한다. 어느 쪽이 나중에 커밋되든 활동은 그 내용을 따라야 한다.
      const wsUpdated = waitFor<{ id: number }>(s, 'message:updated', (m) => m.id === id);
      const [patched] = await Promise.all([
        request(app).patch(`/messages/${id}`).set(auth(dave)).send({ content: `x${i} http ${mention(carol)}` }),
        (s.emit('message:edit', { messageId: id, content: `x${i} ws ${mention(alice)}` }), wsUpdated),
      ]);
      expect(patched.status).toBe(200);
      await expectMentionsMatchMessage(id);
      // Delete: HTTP와 WS를 번갈아 쓴다
      if (i % 2 === 0) {
        expect((await request(app).delete(`/messages/${id}`).set(auth(dave))).status).toBe(200);
      } else {
        const deleted = waitFor<{ messageId: number }>(s, 'message:deleted', (d) => d.messageId === id);
        s.emit('message:delete', { messageId: id });
        await deleted;
      }
      await expectMentionsMatchMessage(id);
    }
    expect(await activities({})).toHaveLength(0);
  });

  it('CRUD x20: deleting right after an @channel send leaves no activity', async () => {
    const s = await connect(erin);
    await new Promise((resolve) => s.emit('join:channel', pubId, resolve));
    const ids: number[] = [];
    for (let i = 0; i < CRUD_ROUNDS; i++) {
      const content = `burst ${i} <@channel> ${mention(bob)}`;
      const created = waitFor<{ id: number; content: string }>(s, 'message:new', (m) => m.content === content);
      s.emit('message:send', { channelId: pubId, content });
      const [msg] = await created;
      ids.push(msg.id);
      // 생성 후처리(@channel 대량 insert)를 기다리지 않고 바로 지운다
      expect((await request(app).delete(`/messages/${msg.id}`).set(auth(erin))).status).toBe(200);
    }
    expect(await activities({ messageId: { in: ids } })).toHaveLength(0);
    for (const u of [alice, bob, carol]) expect((await mentionCounts(u)).channels[pubId] ?? 0).toBe(0);
  });

  it('delete responses and broadcasts do not wait for queued activity work on the same target', async () => {
    const s = await connect(alice);
    await new Promise((resolve) => s.emit('join:channel', pubId, resolve));
    const msg = await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: `gated ${mention(bob)}` });
    const reacted = await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: 'gated reaction' });
    expect((await request(app).post(`/messages/${reacted.body.id}/reactions`).set(auth(bob)).send({ emoji: '👍' })).status).toBe(201);
    const dm = await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: `gated dm ${mention(bob)}` });
    await settle();
    expect(await activities({ messageId: msg.body.id })).toHaveLength(1);

    // 같은 키 앞에 끝나지 않는 작업(대량 생성 후처리 대신)을 세워 둔다
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    for (const key of [messageKey(msg.body.id), messageKey(reacted.body.id), dmKey(dm.body.id)]) void activityQueue.run(key, () => gate);
    try {
      const deleted = waitFor<{ messageId: number }>(s, 'message:deleted', (d) => d.messageId === msg.body.id);
      expect((await request(app).delete(`/messages/${msg.body.id}`).set(auth(alice))).status).toBe(200);
      await deleted;
      const unreacted = await request(app).delete(`/messages/${reacted.body.id}/reactions/${encodeURIComponent('👍')}`).set(auth(bob));
      expect(unreacted.status).toBe(200);
      expect((await request(app).delete(`/dms/messages/${dm.body.id}`).set(auth(alice))).status).toBe(200);
      // 정리는 큐에서 차례를 기다리는 중이다
      expect(await prisma.activity.count({ where: { messageId: msg.body.id } })).toBe(1);
    } finally {
      release();
    }
    expect(await activities({ messageId: { in: [msg.body.id, reacted.body.id] } })).toHaveLength(0);
    expect(await activities({ dmId: dm.body.id })).toHaveLength(0);
  });

  it('a reaction without messageId or dmId fails fast instead of sharing a global queue key', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(createReactionActivity({ actorId: bob.id, targetUserId: alice.id, emoji: '👍' })).resolves.toBeNull();
      expect(spy).toHaveBeenCalledWith('Reaction activity without messageId or dmId', expect.anything());
    } finally {
      spy.mockRestore();
    }
  });

  describe('presence status', () => {
    const statusOf = async (u: TestUser) => {
      await settle();
      return (await prisma.user.findUniqueOrThrow({ where: { id: u.id }, select: { status: true } })).status;
    };

    /** 클라이언트 disconnect는 서버에 비동기로 닿는다. 서버가 끊김을 처리해 offline 쓰기를 큐에 넣을 때까지 기다린다. */
    const disconnectFully = async (s: ClientSocket, u: TestUser) => {
      s.disconnect();
      for (let t = 0; isUserOnline(u.id) && t < 100; t++) await new Promise((r) => setTimeout(r, 20));
      expect(isUserOnline(u.id)).toBe(false);
    };

    it('connecting does not overwrite a status the user chose', async () => {
      expect((await request(app).put('/users/me/status').set(auth(frank)).send({ status: 'away' })).body.status).toBe('away');
      const s = await connect(frank);
      expect(await statusOf(frank)).toBe('away');
      await disconnectFully(s, frank);
      expect(await statusOf(frank)).toBe('offline');
    });

    it('CRUD x20: connect then set away right away keeps away; disconnect writes offline', async () => {
      for (let i = 0; i < CRUD_ROUNDS; i++) {
        const s = await connect(frank);
        const put = await request(app).put('/users/me/status').set(auth(frank)).send({ status: i % 2 ? 'away' : 'busy' });
        expect(put.status).toBe(200);
        expect(await statusOf(frank)).toBe(i % 2 ? 'away' : 'busy');
        const me = await request(app).get('/users/me').set(auth(frank));
        expect(me.body.isOnline).toBe(true);
        await disconnectFully(s, frank);
        expect(await statusOf(frank)).toBe('offline');
        // 끊긴 뒤 다시 연결하면 offline에서 online으로 바뀐다
        const again = await connect(frank);
        expect(await statusOf(frank)).toBe('online');
        await disconnectFully(again, frank);
      }
    });
  });
});

describe('KeyedQueue', () => {
  it('runs tasks of one key in order, isolates failures, and is awaited by settle', async () => {
    const q = new KeyedQueue<string>();
    const order: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const slow = q.run('k', async () => { await new Promise((r) => setTimeout(r, 30)); order.push('a'); });
      const failed = q.run('k', async () => { order.push('b'); throw new Error('boom'); });
      q.fire('k', async () => { order.push('c'); throw new Error('fired'); }, 'fire failed');
      const last = q.run('k', async () => { order.push('d'); return 'ok'; });
      const other = q.run('other', async () => { order.push('x'); });
      await settle();
      await expect(slow).resolves.toBeUndefined();
      await expect(failed).rejects.toThrow('boom');
      await expect(last).resolves.toBe('ok');
      await other;
      expect(order).toEqual(['x', 'a', 'b', 'c', 'd']);
      expect(spy).toHaveBeenCalledWith('fire failed', expect.anything());
    } finally {
      spy.mockRestore();
    }
  });
});
