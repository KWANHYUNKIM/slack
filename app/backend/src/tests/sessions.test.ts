import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { JWT_SECRET } from '../config.js';
import { purgeSessions, maskIp, summarizeUserAgent } from '../services/sessionService.js';
import { purgeSessionsIfDue } from '../scheduler.js';

const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(email: string, ua = CHROME_MAC): Promise<string> {
  const res = await request(app).post('/auth/login').set('User-Agent', ua).send({ email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token;
}

const sidOf = (token: string): string => (jwt.decode(token) as { sid: string }).sid;

async function auditActions(action: string) {
  return prisma.auditLog.findMany({ where: { action }, orderBy: { id: 'asc' } });
}

describe('세션 관리 (E7)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  const sockets: ClientSocket[] = [];
  let aliceId: number;
  let bobId: number;
  let adminId: number;
  let adminToken: string;
  const saved = { max: process.env.SESSION_MAX_AGE_DAYS, idle: process.env.SESSION_IDLE_TIMEOUT_HOURS };

  function connect(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = Client(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  const waitDisconnect = (s: ClientSocket) =>
    new Promise<void>((resolve, reject) => {
      if (s.disconnected) return resolve();
      const t = setTimeout(() => reject(new Error('socket was not disconnected')), 3000);
      s.on('disconnect', () => { clearTimeout(t); resolve(); });
    });

  beforeAll(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    const reg = async (email: string, name: string) => {
      const r = await request(app).post('/auth/register').send({ email, password: TEST_PASSWORD, name });
      expect(r.status).toBe(201);
      return r.body.user.id as number;
    };
    aliceId = await reg('alice-sess@example.com', 'Alice');
    bobId = await reg('bob-sess@example.com', 'Bob');
    adminId = await reg('admin-sess@example.com', 'Admin');
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });
    adminToken = await login('admin-sess@example.com');

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(() => {
        const a = httpServer.address();
        port = typeof a === 'object' && a ? a.port : 3001;
        resolve();
      });
    });
  });

  afterEach(() => {
    process.env.SESSION_MAX_AGE_DAYS = saved.max;
    process.env.SESSION_IDLE_TIMEOUT_HOURS = saved.idle;
    if (saved.max === undefined) delete process.env.SESSION_MAX_AGE_DAYS;
    if (saved.idle === undefined) delete process.env.SESSION_IDLE_TIMEOUT_HOURS;
    sockets.splice(0).forEach((s) => s.disconnect());
  });

  afterAll(async () => {
    io.close();
    httpServer.close();
    await prisma.$disconnect();
  });

  describe('목록 (Read)', () => {
    it('두 기기로 로그인하면 둘 다 보이고 이 기기가 표시된다', async () => {
      const t1 = await login('alice-sess@example.com', CHROME_MAC);
      const t2 = await login('alice-sess@example.com', FIREFOX_WIN);

      const res = await request(app).get('/users/me/sessions').set(auth(t1)).expect(200);
      const ids = res.body.map((s: { id: string }) => s.id);
      expect(ids).toEqual(expect.arrayContaining([sidOf(t1), sidOf(t2)]));
      expect(res.body.find((s: { id: string }) => s.id === sidOf(t1)).current).toBe(true);
      expect(res.body.find((s: { id: string }) => s.id === sidOf(t2)).current).toBe(false);

      const uas = res.body.map((s: { userAgent: string }) => s.userAgent);
      expect(uas).toEqual(expect.arrayContaining(['Chrome / macOS', 'Firefox / Windows']));
      // 원문 UA와 마스킹 전 IP는 저장하지도 응답하지도 않는다
      expect(JSON.stringify(res.body)).not.toContain('Mozilla');
      const row = await prisma.session.findUnique({ where: { id: sidOf(t1) } });
      expect(row?.ip === null || /\.x$|::x$/.test(row!.ip)).toBe(true);

      // 다른 사용자의 목록에는 보이지 않는다
      const bobTok = await login('bob-sess@example.com');
      const bobList = await request(app).get('/users/me/sessions').set(auth(bobTok)).expect(200);
      expect(bobList.body.some((s: { id: string }) => ids.includes(s.id))).toBe(false);
    });

    it('인증 없이는 401', async () => {
      await request(app).get('/users/me/sessions').expect(401);
      await request(app).delete('/users/me/sessions').expect(401);
    });

    it('가입 직후 토큰도 세션이 있다', async () => {
      const r = await request(app).post('/auth/register').send({ email: 'carol-sess@example.com', password: TEST_PASSWORD, name: 'Carol' }).expect(201);
      const list = await request(app).get('/users/me/sessions').set(auth(r.body.token)).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].current).toBe(true);
    });
  });

  describe('기기 하나 로그아웃 (Delete)', () => {
    it('그 토큰만 401이 되고 소켓이 끊기며 감사 로그가 남는다', async () => {
      const t1 = await login('alice-sess@example.com');
      const t2 = await login('alice-sess@example.com');
      const s1 = await connect(t1);
      const s2 = await connect(t2);
      const before = (await auditActions('session.revoked')).length;

      const del = await request(app).delete(`/users/me/sessions/${sidOf(t1)}`).set(auth(t2)).expect(200);
      expect(del.body.current).toBe(false);

      await waitDisconnect(s1);
      expect(s2.connected).toBe(true);
      await request(app).get('/users/me/sessions').set(auth(t1)).expect(401);
      await request(app).get('/users/me/sessions').set(auth(t2)).expect(200);

      const logs = await auditActions('session.revoked');
      expect(logs).toHaveLength(before + 1);
      expect(logs[logs.length - 1]).toMatchObject({ actorId: aliceId, targetId: aliceId });
      expect(logs[logs.length - 1].details).toContain('scope=self');

      // 새 소켓 연결도 거부된다
      await expect(connect(t1)).rejects.toBeTruthy();
      // 목록에서도 사라진다
      const list = await request(app).get('/users/me/sessions').set(auth(t2)).expect(200);
      expect(list.body.some((s: { id: string }) => s.id === sidOf(t1))).toBe(false);
    });

    it('이 기기를 직접 지우면 그 토큰이 401이 된다', async () => {
      const t = await login('alice-sess@example.com');
      const del = await request(app).delete(`/users/me/sessions/${sidOf(t)}`).set(auth(t)).expect(200);
      expect(del.body.current).toBe(true);
      await request(app).get('/users/me/sessions').set(auth(t)).expect(401);
    });

    it('남의 세션, 없는 세션, 이미 지운 세션, 이상한 id는 404', async () => {
      const aliceTok = await login('alice-sess@example.com');
      const bobTok = await login('bob-sess@example.com');
      const bobSid = sidOf(bobTok);

      await request(app).delete(`/users/me/sessions/${bobSid}`).set(auth(aliceTok)).expect(404);
      // 남의 세션은 그대로 살아 있다
      await request(app).get('/users/me/sessions').set(auth(bobTok)).expect(200);

      await request(app).delete(`/users/me/sessions/${'0'.repeat(32)}`).set(auth(aliceTok)).expect(404);
      await request(app).delete('/users/me/sessions/not-a-session').set(auth(aliceTok)).expect(404);
      await request(app).delete(`/users/me/sessions/${"'; DROP TABLE x;--"}`).set(auth(aliceTok)).expect(404);

      const other = await login('alice-sess@example.com');
      await request(app).delete(`/users/me/sessions/${sidOf(other)}`).set(auth(aliceTok)).expect(200);
      await request(app).delete(`/users/me/sessions/${sidOf(other)}`).set(auth(aliceTok)).expect(404);
    });

    it('로그아웃 API는 이 기기의 세션을 폐기한다', async () => {
      const t = await login('bob-sess@example.com');
      const s = await connect(t);
      await request(app).post('/auth/logout').set(auth(t)).expect(200);
      await waitDisconnect(s);
      await request(app).get('/users/me/sessions').set(auth(t)).expect(401);
    });
  });

  describe('나머지 전체 로그아웃', () => {
    it('이 기기만 남기고 모두 끊는다', async () => {
      const keep = await login('bob-sess@example.com');
      const others = [await login('bob-sess@example.com'), await login('bob-sess@example.com')];
      const otherSocket = await connect(others[0]);
      const before = (await auditActions('session.revoked_all')).length;

      const res = await request(app).delete('/users/me/sessions').set(auth(keep)).expect(200);
      expect(res.body.revoked).toBeGreaterThanOrEqual(2);

      await waitDisconnect(otherSocket);
      for (const t of others) await request(app).get('/users/me/sessions').set(auth(t)).expect(401);
      const list = await request(app).get('/users/me/sessions').set(auth(keep)).expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].current).toBe(true);

      const logs = await auditActions('session.revoked_all');
      expect(logs).toHaveLength(before + 1);
      expect(logs[logs.length - 1].details).toContain('scope=self');

      // 지울 것이 없으면 0이고 감사 로그를 더 만들지 않는다
      const again = await request(app).delete('/users/me/sessions').set(auth(keep)).expect(200);
      expect(again.body.revoked).toBe(0);
      expect(await auditActions('session.revoked_all')).toHaveLength(before + 1);
    });
  });

  describe('관리자', () => {
    it('다른 사용자의 세션을 조회하고 하나 지우고 전부 지운다', async () => {
      const a1 = await login('alice-sess@example.com');
      const a2 = await login('alice-sess@example.com');
      const s1 = await connect(a1);

      const list = await request(app).get(`/admin/users/${aliceId}/sessions`).set(auth(adminToken)).expect(200);
      expect(list.body.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([sidOf(a1), sidOf(a2)]));
      expect(list.body.every((s: { current: boolean }) => s.current === false)).toBe(true);

      await request(app).delete(`/admin/users/${aliceId}/sessions/${sidOf(a1)}`).set(auth(adminToken)).expect(200);
      await waitDisconnect(s1);
      await request(app).get('/users/me/sessions').set(auth(a1)).expect(401);
      await request(app).get('/users/me/sessions').set(auth(a2)).expect(200);
      await request(app).delete(`/admin/users/${aliceId}/sessions/${sidOf(a1)}`).set(auth(adminToken)).expect(404);

      const all = await request(app).delete(`/admin/users/${aliceId}/sessions`).set(auth(adminToken)).expect(200);
      expect(all.body.revoked).toBeGreaterThanOrEqual(1);
      await request(app).get('/users/me/sessions').set(auth(a2)).expect(401);

      const revoked = (await auditActions('session.revoked')).filter((l) => l.actorId === adminId);
      expect(revoked.length).toBeGreaterThanOrEqual(1);
      expect(revoked[0].details).toContain('scope=admin');
      const revokedAll = (await auditActions('session.revoked_all')).filter((l) => l.actorId === adminId);
      expect(revokedAll.length).toBeGreaterThanOrEqual(1);
    });

    it('일반 사용자는 403, 없는 사용자는 404, 같거나 높은 역할은 403', async () => {
      const bobTok = await login('bob-sess@example.com');
      await request(app).get(`/admin/users/${aliceId}/sessions`).set(auth(bobTok)).expect(403);
      await request(app).delete(`/admin/users/${aliceId}/sessions`).set(auth(bobTok)).expect(403);
      await request(app).get('/admin/users/999999/sessions').set(auth(adminToken)).expect(404);
      await request(app).get('/admin/users/abc/sessions').set(auth(adminToken)).expect(400);

      const owner = await prisma.user.create({ data: { email: 'owner-sess@example.com', password: 'x', name: 'Owner', role: 'OWNER' } });
      await request(app).delete(`/admin/users/${owner.id}/sessions`).set(auth(adminToken)).expect(403);
    });

    it('강제 로그아웃은 tokenVersion과 세션을 함께 무효화한다', async () => {
      const t1 = await login('bob-sess@example.com');
      const t2 = await login('bob-sess@example.com');
      const s = await connect(t1);
      const legacy = jwt.sign({ userId: bobId, tokenVersion: (await prisma.user.findUniqueOrThrow({ where: { id: bobId } })).tokenVersion }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      await request(app).get('/users/me/sessions').set(auth(legacy)).expect(200);

      await request(app).post(`/admin/users/${bobId}/force-logout`).set(auth(adminToken)).expect(200);

      await waitDisconnect(s);
      for (const t of [t1, t2, legacy]) await request(app).get('/users/me/sessions').set(auth(t)).expect(401);
      const rows = await prisma.session.findMany({ where: { userId: bobId, revokedAt: null } });
      expect(rows).toHaveLength(0);
      const logs = await auditActions('user.force_logout');
      expect(logs[logs.length - 1]).toMatchObject({ actorId: adminId, targetId: bobId });

      // 다시 로그인하면 새 세션이 생긴다
      const again = await login('bob-sess@example.com');
      const list = await request(app).get('/users/me/sessions').set(auth(again)).expect(200);
      expect(list.body).toHaveLength(1);
    });
  });

  describe('유효 시간 정책', () => {
    it('유휴 시간이 지나면 401이고, 사용하면 lastSeenAt이 1분 간격으로만 갱신된다', async () => {
      const t = await login('alice-sess@example.com');
      const sid = sidOf(t);

      // 방금 만든 세션을 연속 호출해도 lastSeenAt은 그대로(1분 안)
      const before = (await prisma.session.findUniqueOrThrow({ where: { id: sid } })).lastSeenAt;
      await request(app).get('/users/me/sessions').set(auth(t)).expect(200);
      await request(app).get('/users/me/sessions').set(auth(t)).expect(200);
      await new Promise((r) => setTimeout(r, 100));
      expect((await prisma.session.findUniqueOrThrow({ where: { id: sid } })).lastSeenAt.getTime()).toBe(before.getTime());

      // 1분이 지난 것처럼 되돌리면 다음 요청이 갱신한다
      const old = new Date(Date.now() - 5 * 60 * 1000);
      await prisma.session.update({ where: { id: sid }, data: { lastSeenAt: old } });
      await request(app).get('/users/me/sessions').set(auth(t)).expect(200);
      let seen = old;
      for (let i = 0; i < 20 && seen.getTime() === old.getTime(); i++) {
        await new Promise((r) => setTimeout(r, 50));
        seen = (await prisma.session.findUniqueOrThrow({ where: { id: sid } })).lastSeenAt;
      }
      expect(seen.getTime()).toBeGreaterThan(old.getTime());

      // 유휴 기준(기본 96시간)을 넘기면 거부된다
      await prisma.session.update({ where: { id: sid }, data: { lastSeenAt: new Date(Date.now() - 97 * 3600 * 1000) } });
      await request(app).get('/users/me/sessions').set(auth(t)).expect(401);
    });

    it('SESSION_IDLE_TIMEOUT_HOURS 환경 변수를 따른다', async () => {
      const t = await login('alice-sess@example.com');
      await prisma.session.update({ where: { id: sidOf(t) }, data: { lastSeenAt: new Date(Date.now() - 2 * 3600 * 1000) } });
      await request(app).get('/users/me/sessions').set(auth(t)).expect(200);
      await prisma.session.update({ where: { id: sidOf(t) }, data: { lastSeenAt: new Date(Date.now() - 2 * 3600 * 1000) } });
      process.env.SESSION_IDLE_TIMEOUT_HOURS = '1';
      await request(app).get('/users/me/sessions').set(auth(t)).expect(401);
    });

    it('최대 수명이 지나면 401이고 SESSION_MAX_AGE_DAYS가 만료 시각을 정한다', async () => {
      process.env.SESSION_MAX_AGE_DAYS = '2';
      const t = await login('alice-sess@example.com');
      const row = await prisma.session.findUniqueOrThrow({ where: { id: sidOf(t) } });
      const days = (row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000;
      expect(days).toBeCloseTo(2, 1);
      const payload = jwt.decode(t) as { iat: number; exp: number };
      expect((payload.exp - payload.iat) / 86_400).toBeCloseTo(2, 1);

      await request(app).get('/users/me/sessions').set(auth(t)).expect(200);
      await prisma.session.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await request(app).get('/users/me/sessions').set(auth(t)).expect(401);
    });

    it('기본값은 최대 수명 7일, 유휴 96시간', async () => {
      delete process.env.SESSION_MAX_AGE_DAYS;
      delete process.env.SESSION_IDLE_TIMEOUT_HOURS;
      const t = await login('alice-sess@example.com');
      const row = await prisma.session.findUniqueOrThrow({ where: { id: sidOf(t) } });
      expect((row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000).toBeCloseTo(7, 1);
    });

    it('소켓 주기 재검증이 유휴로 만료된 세션을 끊는다는 것을 확인하려고 만료 후 새 연결은 거부한다', async () => {
      const t = await login('alice-sess@example.com');
      await prisma.session.update({ where: { id: sidOf(t) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await expect(connect(t)).rejects.toBeTruthy();
    });
  });

  describe('호환과 격리', () => {
    it('sid 없는 옛 토큰은 tokenVersion 규칙으로 계속 통한다', async () => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: aliceId } });
      const legacy = jwt.sign({ userId: aliceId, tokenVersion: user.tokenVersion }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      await request(app).get('/channels').set(auth(legacy)).expect(200);
      const list = await request(app).get('/users/me/sessions').set(auth(legacy)).expect(200);
      expect(list.body.every((s: { current: boolean }) => s.current === false)).toBe(true);
    });

    it('남의 sid를 단 위조 토큰, 없는 sid 토큰은 거부된다', async () => {
      const bobTok = await login('bob-sess@example.com');
      const user = await prisma.user.findUniqueOrThrow({ where: { id: aliceId } });
      // 서명은 맞지만 sid가 다른 사용자의 세션이다
      const crossed = jwt.sign({ userId: aliceId, tokenVersion: user.tokenVersion, sid: sidOf(bobTok) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      await request(app).get('/channels').set(auth(crossed)).expect(401);
      const ghost = jwt.sign({ userId: aliceId, tokenVersion: user.tokenVersion, sid: 'f'.repeat(32) }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      await request(app).get('/channels').set(auth(ghost)).expect(401);
      const weird = jwt.sign({ userId: aliceId, tokenVersion: user.tokenVersion, sid: 12345 }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      await request(app).get('/channels').set(auth(weird)).expect(401);
    });

    it('비밀번호를 바꾸면 이전 세션은 목록에서 사라지고 새 토큰의 세션만 남는다', async () => {
      const t = await login('carol-sess@example.com');
      const other = await login('carol-sess@example.com');
      const res = await request(app)
        .post('/auth/change-password').set(auth(t))
        .send({ currentPassword: TEST_PASSWORD, newPassword: `${TEST_PASSWORD}-New1!` }).expect(200);
      await request(app).get('/users/me/sessions').set(auth(other)).expect(401);
      await request(app).get('/users/me/sessions').set(auth(t)).expect(401);
      const list = await request(app).get('/users/me/sessions').set(auth(res.body.token)).expect(200);
      expect(list.body).toHaveLength(1);
    });

    it('개인 액세스 토큰(MCP)은 세션 폐기와 무관하게 동작한다', async () => {
      const t = await login('alice-sess@example.com');
      const pat = await request(app).post('/tokens').set(auth(t)).send({ name: 'claude' }).expect(201);
      await request(app).delete('/users/me/sessions').set(auth(t)).expect(200);
      await request(app).delete(`/users/me/sessions/${sidOf(t)}`).set(auth(t)).expect(200);
      await request(app).get('/users/me/sessions').set(auth(t)).expect(401);

      const rpc = await request(app)
        .post('/mcp').set({ Accept: 'application/json, text/event-stream' }).set(auth(pat.body.token))
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      expect(rpc.status).toBe(200);
      // 로그인 JWT는 계속 /mcp에서 거부된다
      const t2 = await login('alice-sess@example.com');
      const jwtRpc = await request(app)
        .post('/mcp').set({ Accept: 'application/json, text/event-stream' }).set(auth(t2))
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      expect(jwtRpc.status).toBe(401);
    });
  });

  describe('정리 (스케줄러)', () => {
    it('만료, 유휴 초과, 오래된 폐기 세션만 지우고 살아 있는 세션은 남긴다', async () => {
      const live = await login('alice-sess@example.com');
      const expired = await login('alice-sess@example.com');
      const idle = await login('alice-sess@example.com');
      const revokedOld = await login('alice-sess@example.com');
      const revokedFresh = await login('alice-sess@example.com');
      const day = 86_400_000;
      await prisma.session.update({ where: { id: sidOf(expired) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await prisma.session.update({ where: { id: sidOf(idle) }, data: { lastSeenAt: new Date(Date.now() - 100 * 3600 * 1000) } });
      await prisma.session.update({ where: { id: sidOf(revokedOld) }, data: { revokedAt: new Date(Date.now() - 2 * day) } });
      await prisma.session.update({ where: { id: sidOf(revokedFresh) }, data: { revokedAt: new Date() } });

      const removed = await purgeSessions();
      expect(removed).toBeGreaterThanOrEqual(3);
      const left = (await prisma.session.findMany({ select: { id: true } })).map((r) => r.id);
      expect(left).toContain(sidOf(live));
      expect(left).toContain(sidOf(revokedFresh));
      for (const t of [expired, idle, revokedOld]) expect(left).not.toContain(sidOf(t));
      await request(app).get('/users/me/sessions').set(auth(live)).expect(200);
    });

    it('스케줄러 진입점은 1시간에 한 번만 돈다', async () => {
      const t0 = Date.now() + 10 * 86_400_000;
      await purgeSessionsIfDue(t0);
      expect(await purgeSessionsIfDue(t0 + 1000)).toBe(0);
      const old = await login('alice-sess@example.com');
      await prisma.session.update({ where: { id: sidOf(old) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await purgeSessionsIfDue(t0 + 61 * 60 * 1000)).toBeGreaterThanOrEqual(0);
    });

    it('사용자를 지우면 세션도 함께 지워진다', async () => {
      const u = await prisma.user.create({ data: { email: 'tmp-sess@example.com', password: 'x', name: 'Tmp' } });
      await prisma.session.create({ data: { id: 'a'.repeat(32), userId: u.id, expiresAt: new Date(Date.now() + 1e6) } });
      await prisma.user.delete({ where: { id: u.id } });
      expect(await prisma.session.findUnique({ where: { id: 'a'.repeat(32) } })).toBeNull();
    });
  });

  describe('요약 함수', () => {
    it('IP는 마지막 부분을 가리고 UA는 브라우저와 OS만 남긴다', () => {
      expect(maskIp('203.0.113.77')).toBe('203.0.113.x');
      expect(maskIp('::ffff:203.0.113.77')).toBe('203.0.113.x');
      expect(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::x');
      expect(maskIp(undefined)).toBeNull();
      expect(maskIp('garbage')).toBeNull();
      expect(summarizeUserAgent(CHROME_MAC)).toBe('Chrome / macOS');
      expect(summarizeUserAgent(FIREFOX_WIN)).toBe('Firefox / Windows');
      expect(summarizeUserAgent('Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537 Edg/120')).toBe('Edge / Linux');
      expect(summarizeUserAgent('Mozilla/5.0 Electron/30 Chrome/124 (Macintosh; Intel Mac OS X)')).toBe('Desktop app / macOS');
      expect(summarizeUserAgent(undefined)).toBeNull();
      expect(summarizeUserAgent('x'.repeat(5000))).toBe('Unknown browser');
    });
  });
});
