import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { clearTokenCache } from '../middleware/auth.js';
import { initializeWebSocket } from '../websocket/index.js';

// 파트 03: 채널 메타(토픽·설명·이름), 즐겨찾기, 사이드바 접기 상태
describe('Channel meta, stars, sidebar prefs', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: ReturnType<typeof initializeWebSocket>;
  let port: number;
  const sockets: ClientSocket[] = [];

  let ownerToken: string;
  let ownerId: number;
  let memberToken: string;
  let memberId: number;
  let modToken: string;
  let adminToken: string;
  let outsiderToken: string;
  let channelId: number;

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const patch = (t: string, id: number, body: object) =>
    request(app).patch(`/channels/${id}`).set(auth(t)).send(body);

  async function register(name: string) {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: `${name}@meta.test`, password: TEST_PASSWORD, name });
    return { token: res.body.token as string, id: res.body.user.id as number };
  }

  beforeAll(async () => {
    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(() => resolve()));
    const address = httpServer.address();
    port = typeof address === 'object' && address ? address.port : 0;
  });

  afterEach(() => {
    sockets.splice(0).forEach((s) => s.disconnect());
  });

  afterAll(async () => {
    io.close();
    httpServer.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.dMReaction.deleteMany();
    await prisma.directMessage.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    const owner = await register('owner');
    ownerToken = owner.token;
    ownerId = owner.id;
    const member = await register('member');
    memberToken = member.token;
    memberId = member.id;
    const mod = await register('mod');
    modToken = mod.token;
    const admin = await register('admin');
    adminToken = admin.token;
    const outsider = await register('outsider');
    outsiderToken = outsider.token;
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    clearTokenCache();

    const ch = await request(app).post('/channels').set(auth(ownerToken)).send({ name: 'meta-ch' });
    channelId = ch.body.id;
    await prisma.channelMember.createMany({
      data: [
        { userId: memberId, channelId },
        { userId: mod.id, channelId, role: 'MODERATOR' },
      ],
    });
  });

  describe('PATCH /channels/:id', () => {
    it('sets, reads, changes, and clears topic and description (CRUD loop)', async () => {
      for (let round = 1; round <= 2; round++) {
        let res = await patch(ownerToken, channelId, { topic: `topic ${round}`, description: `desc ${round}` });
        expect(res.status).toBe(200);
        expect(res.body.topic).toBe(`topic ${round}`);

        res = await request(app).get(`/channels/${channelId}`).set(auth(memberToken));
        expect(res.body.topic).toBe(`topic ${round}`);
        expect(res.body.description).toBe(`desc ${round}`);

        res = await request(app).get('/channels').set(auth(memberToken));
        const listed = res.body.find((c: { id: number }) => c.id === channelId);
        expect(listed.topic).toBe(`topic ${round}`);

        // 일부 필드만 바꾸면 나머지는 유지
        res = await patch(ownerToken, channelId, { topic: '  changed  ' });
        expect(res.body.topic).toBe('changed');
        expect(res.body.description).toBe(`desc ${round}`);

        // 빈 문자열과 null은 비우기
        res = await patch(ownerToken, channelId, { topic: '', description: null });
        expect(res.status).toBe(200);
        expect(res.body.topic).toBeNull();
        expect(res.body.description).toBeNull();
        res = await request(app).get(`/channels/${channelId}`).set(auth(ownerToken));
        expect(res.body.topic).toBeNull();
        expect(res.body.description).toBeNull();
      }
    });

    it('rejects over-length and malformed input with 400', async () => {
      let res = await patch(ownerToken, channelId, { topic: 'a'.repeat(251) });
      expect(res.status).toBe(400);
      res = await patch(ownerToken, channelId, { description: 'a'.repeat(501) });
      expect(res.status).toBe(400);
      res = await patch(ownerToken, channelId, { topic: 'a'.repeat(250), description: 'b'.repeat(500) });
      expect(res.status).toBe(200);
      res = await patch(ownerToken, channelId, {});
      expect(res.status).toBe(400);
      res = await patch(ownerToken, channelId, { topic: 5 });
      expect(res.status).toBe(400);
      res = await patch(ownerToken, channelId, { isPrivate: true });
      expect(res.status).toBe(400);
      res = await patch(ownerToken, 0, { topic: 'x' });
      expect(res.status).toBe(400);
    });

    it('forbids plain members, allows channel moderator and workspace admin', async () => {
      let res = await patch(memberToken, channelId, { topic: 'nope' });
      expect(res.status).toBe(403);
      res = await patch(modToken, channelId, { topic: 'by mod' });
      expect(res.status).toBe(200);
      res = await patch(adminToken, channelId, { topic: 'by admin' });
      expect(res.status).toBe(200);
      const ch = await prisma.channel.findUnique({ where: { id: channelId } });
      expect(ch?.topic).toBe('by admin');
    });

    it('hides private channels from non-members and forbids non-member edits on public ones', async () => {
      const priv = await request(app).post('/channels').set(auth(ownerToken)).send({ name: 'secret', isPrivate: true });
      let res = await patch(outsiderToken, priv.body.id, { topic: 'x' });
      expect(res.status).toBe(404);
      res = await patch(outsiderToken, channelId, { topic: 'x' });
      expect(res.status).toBe(403);
      res = await patch(ownerToken, 999999, { topic: 'x' });
      expect(res.status).toBe(404);
      res = await request(app).patch(`/channels/${channelId}`).send({ topic: 'x' });
      expect(res.status).toBe(401);
    });

    it('renames: conflict 409, bad format 400, archived refused', async () => {
      await request(app).post('/channels').set(auth(ownerToken)).send({ name: 'taken' });
      let res = await patch(ownerToken, channelId, { name: 'Taken' });
      expect(res.status).toBe(409);
      res = await patch(ownerToken, channelId, { name: 'bad name!' });
      expect(res.status).toBe(400);
      res = await patch(ownerToken, channelId, { name: '' });
      expect(res.status).toBe(400);
      res = await patch(ownerToken, channelId, { name: '새-이름' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('새-이름');
      // 같은 이름으로 다시 보내도 충돌이 아니다
      res = await patch(ownerToken, channelId, { name: '새-이름' });
      expect(res.status).toBe(200);

      await prisma.channel.update({ where: { id: channelId }, data: { archivedAt: new Date() } });
      res = await patch(ownerToken, channelId, { name: 'after-archive' });
      expect(res.status).toBe(403);
      res = await patch(ownerToken, channelId, { topic: 'after-archive' });
      expect(res.status).toBe(403);
    });

    it('writes audit logs', async () => {
      await patch(ownerToken, channelId, { name: 'renamed-ch', topic: 'hello' });
      const logs = await prisma.auditLog.findMany({ where: { action: 'channel.edited', targetId: channelId } });
      expect(logs).toHaveLength(1);
      expect(logs[0].actorId).toBe(ownerId);
      expect(logs[0].details).toContain('Renamed from #meta-ch to #renamed-ch');
      expect(logs[0].details).toContain('Topic changed');
      // 변경이 없으면 기록하지 않는다
      await patch(ownerToken, channelId, { topic: 'hello' });
      expect(await prisma.auditLog.count({ where: { action: 'channel.edited' } })).toBe(1);
    });

    it('broadcasts channel:updated to channel members', async () => {
      const socket = Client(`http://localhost:${port}`, { auth: { token: memberToken } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });
      const received = new Promise<Record<string, unknown>>((resolve) => socket.on('channel:updated', resolve));
      const res = await patch(ownerToken, channelId, { topic: 'live topic', name: 'live-name' });
      expect(res.status).toBe(200);
      const payload = await received;
      expect(payload).toEqual({ id: channelId, name: 'live-name', topic: 'live topic', description: null });
    });
  });

  describe('stars', () => {
    it('adds and removes channel stars idempotently and reflects isStarred', async () => {
      for (let round = 0; round < 2; round++) {
        let res = await request(app).put(`/channels/${channelId}/star`).set(auth(memberToken));
        expect(res.status).toBe(200);
        res = await request(app).put(`/channels/${channelId}/star`).set(auth(memberToken));
        expect(res.status).toBe(200);
        expect(await prisma.channelStar.count({ where: { userId: memberId, channelId } })).toBe(1);

        res = await request(app).get('/channels').set(auth(memberToken));
        expect(res.body.find((c: { id: number }) => c.id === channelId).isStarred).toBe(true);
        res = await request(app).get(`/channels/${channelId}`).set(auth(memberToken));
        expect(res.body.isStarred).toBe(true);

        // 타인의 별표에는 영향이 없다
        res = await request(app).get(`/channels/${channelId}`).set(auth(ownerToken));
        expect(res.body.isStarred).toBe(false);

        res = await request(app).delete(`/channels/${channelId}/star`).set(auth(memberToken));
        expect(res.status).toBe(200);
        res = await request(app).delete(`/channels/${channelId}/star`).set(auth(memberToken));
        expect(res.status).toBe(200);
        res = await request(app).get('/channels').set(auth(memberToken));
        expect(res.body.find((c: { id: number }) => c.id === channelId).isStarred).toBe(false);
      }
    });

    it('requires channel membership to star', async () => {
      let res = await request(app).put(`/channels/${channelId}/star`).set(auth(outsiderToken));
      expect(res.status).toBe(403);
      res = await request(app).delete(`/channels/${channelId}/star`).set(auth(outsiderToken));
      expect(res.status).toBe(403);
      res = await request(app).put(`/channels/${channelId}/star`);
      expect(res.status).toBe(401);
    });

    it('stars DM partners and lists them as isStarred', async () => {
      await request(app).post('/dms').set(auth(memberToken)).send({ toUserId: ownerId, content: 'hi' });
      let res = await request(app).get('/dms').set(auth(memberToken));
      expect(res.body[0].isStarred).toBe(false);

      res = await request(app).put(`/dms/${ownerId}/star`).set(auth(memberToken));
      expect(res.status).toBe(200);
      res = await request(app).put(`/dms/${ownerId}/star`).set(auth(memberToken));
      expect(res.status).toBe(200);
      res = await request(app).get('/dms').set(auth(memberToken));
      expect(res.body[0].isStarred).toBe(true);
      res = await request(app).get('/dms').set(auth(ownerToken));
      expect(res.body[0].isStarred).toBe(false);

      res = await request(app).delete(`/dms/${ownerId}/star`).set(auth(memberToken));
      expect(res.status).toBe(200);
      res = await request(app).get('/dms').set(auth(memberToken));
      expect(res.body[0].isStarred).toBe(false);

      res = await request(app).put(`/dms/${memberId}/star`).set(auth(memberToken));
      expect(res.status).toBe(400);
      res = await request(app).put('/dms/999999/star').set(auth(memberToken));
      expect(res.status).toBe(404);
    });

    it('emits star:updated to the user own room', async () => {
      const socket = Client(`http://localhost:${port}`, { auth: { token: memberToken } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });
      const received = new Promise<Record<string, unknown>>((resolve) => socket.on('star:updated', resolve));
      await request(app).put(`/channels/${channelId}/star`).set(auth(memberToken));
      expect(await received).toEqual({ type: 'channel', id: channelId, isStarred: true });
    });
  });

  describe('sidebar prefs', () => {
    it('defaults to expanded, saves, merges, and isolates per user', async () => {
      let res = await request(app).get('/users/me/sidebar').set(auth(memberToken));
      expect(res.body.collapsed).toEqual({ starred: false, channels: false, dms: false });

      res = await request(app).patch('/users/me/sidebar').set(auth(memberToken)).send({ collapsed: { channels: true } });
      expect(res.status).toBe(200);
      res = await request(app).patch('/users/me/sidebar').set(auth(memberToken)).send({ collapsed: { dms: true } });
      expect(res.body.collapsed).toEqual({ starred: false, channels: true, dms: true });

      res = await request(app).get('/users/me/sidebar').set(auth(memberToken));
      expect(res.body.collapsed).toEqual({ starred: false, channels: true, dms: true });
      res = await request(app).get('/users/me/sidebar').set(auth(ownerToken));
      expect(res.body.collapsed).toEqual({ starred: false, channels: false, dms: false });

      res = await request(app).patch('/users/me/sidebar').set(auth(memberToken)).send({ collapsed: { channels: false, dms: false } });
      expect(res.body.collapsed).toEqual({ starred: false, channels: false, dms: false });
    });

    it('rejects unknown keys and non-boolean values', async () => {
      let res = await request(app).patch('/users/me/sidebar').set(auth(memberToken)).send({ collapsed: { evil: true } });
      expect(res.status).toBe(400);
      res = await request(app).patch('/users/me/sidebar').set(auth(memberToken)).send({ collapsed: { dms: 'yes' } });
      expect(res.status).toBe(400);
      res = await request(app).patch('/users/me/sidebar').set(auth(memberToken)).send({});
      expect(res.status).toBe(400);
      res = await request(app).get('/users/me/sidebar');
      expect(res.status).toBe(401);
    });
  });
});
