import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { settleBackgroundWork as settle } from '../services/mentionService.js';

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

describe('Activity: rapid CRUD overlapping background work', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  let alice: TestUser, bob: TestUser, carol: TestUser;
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
      const s = Client(`http://localhost:${port}`, { auth: { token: u.token }, forceNew: true });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  beforeAll(async () => {
    [alice, bob, carol] = [await register('Alice'), await register('Bob'), await register('Carol')];
    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'race-pub' })).body.id;
    for (const u of [bob, carol]) await request(app).post(`/channels/${pubId}/join`).set(auth(u));

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(() => {
        const address = httpServer.address();
        port = typeof address === 'object' && address ? address.port : 3001;
        resolve();
      });
    });
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    io.close();
    httpServer.close();
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
        s.emit('message:send', { channelId: pubId, content: `fresh ${i}` }, resolve);
        setTimeout(() => resolve('no ack'), 2000);
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
});
