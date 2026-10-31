import { jest } from '@jest/globals';
import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import webpush from 'web-push';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { settleBackgroundWork as settle } from '../services/mentionService.js';
import { clearExpired, isSingleEmoji, cleanStatusText } from '../services/statusService.js';
import { shouldNotify } from '../services/pushService.js';

// 파트 05: 커스텀 상태, 방해금지(DND), 푸시 억제, user:status 이벤트

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-sd@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('Custom status and Do Not Disturb', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  let alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser;
  let pubId: number;
  let pushSpy: ReturnType<typeof jest.spyOn>;
  const sockets: ClientSocket[] = [];

  const setStatus = (u: TestUser, body: object) => request(app).put('/users/me/custom-status').set(auth(u)).send(body);
  const clearStatus = (u: TestUser) => request(app).delete('/users/me/custom-status').set(auth(u));
  const getMe = async (u: TestUser) => (await request(app).get('/users/me').set(auth(u))).body;
  const getUser = async (viewer: TestUser, id: number) => (await request(app).get(`/users/${id}`).set(auth(viewer))).body;
  const dndOn = (u: TestUser, body: object = { minutes: 30 }) => request(app).post('/users/me/dnd').set(auth(u)).send(body);
  const dndOff = (u: TestUser) => request(app).delete('/users/me/dnd').set(auth(u));
  const dndGet = (u: TestUser) => request(app).get('/users/me/dnd').set(auth(u));
  const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  const resetState = (u: TestUser) => prisma.user.update({
    where: { id: u.id },
    data: { customStatusEmoji: null, customStatusText: null, customStatusExpiresAt: null, dndUntil: null, dndWithStatus: false },
  });

  function connect(u: TestUser): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = Client(`http://localhost:${port}`, { auth: { token: u.token }, forceNew: true });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }
  const collect = (s: ClientSocket, event: string) => {
    const got: any[] = [];
    s.on(event, (p) => got.push(p));
    return got;
  };

  beforeAll(async () => {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    pushSpy = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} } as never);

    [alice, bob, carol, dave] = [await register('Alice'), await register('Bob'), await register('Carol'), await register('Dave')];
    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'sd-pub' })).body.id;
    for (const u of [bob, carol]) await request(app).post(`/channels/${pubId}/join`).set(auth(u));
    // 가입 때 자동으로 들어간 기본 채널에서 dave를 빼서 아무와도 겹치지 않는 사용자로 만든다
    await prisma.channelMember.deleteMany({ where: { userId: dave.id } });
    // 푸시 구독은 DB에 직접 넣는다(오프라인 사용자 bob)
    await prisma.pushSubscription.create({
      data: { userId: bob.id, endpoint: 'http://push.invalid/sub-bob', p256dh: 'p256dh-key', auth: 'auth-key' },
    });

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
    pushSpy.mockRestore();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    sockets.forEach((s) => s.disconnect());
    io.close();
    httpServer.close();
  });

  afterEach(async () => {
    await settle();
  });

  it('requires authentication', async () => {
    expect((await request(app).put('/users/me/custom-status').send({ text: 'x' })).status).toBe(401);
    expect((await request(app).delete('/users/me/custom-status')).status).toBe(401);
    expect((await request(app).get('/users/me/dnd')).status).toBe(401);
    expect((await request(app).post('/users/me/dnd').send({ minutes: 5 })).status).toBe(401);
    expect((await request(app).delete('/users/me/dnd')).status).toBe(401);
  });

  describe('custom status CRUD', () => {
    afterEach(() => resetState(alice));

    it('creates, reads, updates and deletes a status, repeatedly', async () => {
      for (let round = 1; round <= 2; round++) {
        // Create
        const expiresAt = inMinutes(30);
        const created = await setStatus(alice, { emoji: '🏖️', text: `On vacation ${round}`, expiresAt });
        expect(created.status).toBe(200);
        expect(created.body.customStatus).toEqual({ emoji: '🏖️', text: `On vacation ${round}`, expiresAt: new Date(expiresAt).toISOString() });
        expect(created.body.dnd.active).toBe(false);

        // Read: 본인, 타인, 목록
        expect((await getMe(alice)).customStatus.text).toBe(`On vacation ${round}`);
        const seen = await getUser(bob, alice.id);
        expect(seen.customStatus.emoji).toBe('🏖️');
        const listed = (await request(app).get('/users').set(auth(bob)).query({ search: 'Alice' })).body;
        expect(listed.find((u: any) => u.id === alice.id).customStatus.text).toBe(`On vacation ${round}`);

        // Update (만료 제거)
        const updated = await setStatus(alice, { emoji: '🎯', text: 'Focus', expiresAt: null });
        expect(updated.body.customStatus).toEqual({ emoji: '🎯', text: 'Focus', expiresAt: null });
        expect((await getUser(bob, alice.id)).customStatus.text).toBe('Focus');

        // Delete
        const deleted = await clearStatus(alice);
        expect(deleted.status).toBe(200);
        expect(deleted.body.customStatus).toBeNull();
        expect((await getMe(alice)).customStatus).toBeNull();
        expect((await getUser(bob, alice.id)).customStatus).toBeNull();
      }
    });

    it('accepts emoji only or text only', async () => {
      expect((await setStatus(alice, { emoji: '🎧' })).body.customStatus).toEqual({ emoji: '🎧', text: null, expiresAt: null });
      expect((await setStatus(alice, { text: 'Heads down' })).body.customStatus).toEqual({ emoji: null, text: 'Heads down', expiresAt: null });
    });

    it('validates input', async () => {
      expect((await setStatus(alice, { text: 'x'.repeat(101) })).status).toBe(400);
      expect((await setStatus(alice, { text: 'x'.repeat(100) })).status).toBe(200);
      expect((await setStatus(alice, {})).status).toBe(400);
      expect((await setStatus(alice, { text: '   ' })).status).toBe(400);
      expect((await setStatus(alice, { emoji: 'ab' })).status).toBe(400);
      expect((await setStatus(alice, { emoji: '😀😀' })).status).toBe(400);
      expect((await setStatus(alice, { emoji: '<b>' })).status).toBe(400);
      expect((await setStatus(alice, { text: 'ok', expiresAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
      expect((await setStatus(alice, { text: 'ok', expiresAt: new Date(Date.now() + 10_000).toISOString() })).status).toBe(400);
      expect((await setStatus(alice, { text: 'ok', expiresAt: inMinutes(8 * 24 * 60) })).status).toBe(400);
      expect((await setStatus(alice, { text: 'ok', expiresAt: 'not-a-date' })).status).toBe(400);
      expect((await setStatus(alice, { text: 'ok', pauseNotifications: 'yes' })).status).toBe(400);
      expect((await setStatus(alice, { text: 'ok', extra: 1 })).status).toBe(400);
    });

    it('strips HTML and control characters from the text', async () => {
      const res = await setStatus(alice, { text: '<script>alert(1)</script>Hi\u0000\n<b>there</b>' });
      expect(res.status).toBe(200);
      expect(res.body.customStatus.text).toBe('alert(1)Hi there');
      expect(cleanStatusText('a\tb')).toBe('a b');
      expect(isSingleEmoji('👨‍👩‍👧')).toBe(true);
      expect(isSingleEmoji('🇰🇷')).toBe(true);
      expect(isSingleEmoji('a')).toBe(false);
    });
  });

  describe('expiry', () => {
    afterEach(() => resetState(alice));

    it('hides an expired status on read even before the scheduler runs, then clearExpired cleans it', async () => {
      await setStatus(alice, { emoji: '🍕', text: 'Lunch', expiresAt: inMinutes(60) });
      await prisma.user.update({ where: { id: alice.id }, data: { customStatusExpiresAt: new Date(Date.now() - 1000) } });

      expect((await getMe(alice)).customStatus).toBeNull();
      expect((await getUser(bob, alice.id)).customStatus).toBeNull();
      // 아직 DB에는 남아 있다
      expect((await prisma.user.findUnique({ where: { id: alice.id } }))!.customStatusText).toBe('Lunch');

      expect(await clearExpired()).toBeGreaterThanOrEqual(1);
      const row = (await prisma.user.findUnique({ where: { id: alice.id } }))!;
      expect(row.customStatusEmoji).toBeNull();
      expect(row.customStatusText).toBeNull();
      expect(row.customStatusExpiresAt).toBeNull();
      expect(await clearExpired()).toBe(0);
    });

    it('turns DND off by itself when it ends', async () => {
      expect((await dndOn(alice, { minutes: 30 })).status).toBe(200);
      await prisma.user.update({ where: { id: alice.id }, data: { dndUntil: new Date(Date.now() - 1000) } });
      expect((await dndGet(alice)).body).toEqual({ active: false, until: null });
      expect(await clearExpired()).toBeGreaterThanOrEqual(1);
      expect((await prisma.user.findUnique({ where: { id: alice.id } }))!.dndUntil).toBeNull();
    });

    it('clears the paired DND when the status expires', async () => {
      await setStatus(alice, { text: 'Meeting', expiresAt: inMinutes(60), pauseNotifications: true });
      await prisma.user.update({ where: { id: alice.id }, data: { customStatusExpiresAt: new Date(Date.now() - 1000), dndUntil: new Date(Date.now() - 1000) } });
      await clearExpired();
      const row = (await prisma.user.findUnique({ where: { id: alice.id } }))!;
      expect(row.dndUntil).toBeNull();
      expect(row.dndWithStatus).toBe(false);
    });
  });

  describe('Do Not Disturb CRUD', () => {
    afterEach(() => resetState(alice));

    it('turns on, reads, extends and turns off, repeatedly', async () => {
      for (let round = 0; round < 2; round++) {
        expect((await dndGet(alice)).body).toEqual({ active: false, until: null });

        const on = await dndOn(alice, { minutes: 30 });
        expect(on.status).toBe(200);
        expect(on.body.active).toBe(true);
        const remaining = new Date(on.body.until).getTime() - Date.now();
        expect(remaining).toBeGreaterThan(29 * 60_000);
        expect(remaining).toBeLessThanOrEqual(30 * 60_000);
        expect((await dndGet(alice)).body.active).toBe(true);
        expect((await getMe(alice)).dnd.active).toBe(true);

        // 연장 (until 지정, PUT 별칭)
        const until = inMinutes(120);
        const extended = await request(app).put('/users/me/dnd').set(auth(alice)).send({ until });
        expect(extended.body).toEqual({ active: true, until: new Date(until).toISOString() });

        const off = await dndOff(alice);
        expect(off.status).toBe(200);
        expect(off.body).toEqual({ active: false, until: null });
        expect((await dndGet(alice)).body.active).toBe(false);
      }
    });

    it('validates the range', async () => {
      expect((await dndOn(alice, { minutes: 0 })).status).toBe(400);
      expect((await dndOn(alice, { minutes: 10081 })).status).toBe(400);
      expect((await dndOn(alice, { minutes: 1.5 })).status).toBe(400);
      expect((await dndOn(alice, { minutes: '30' })).status).toBe(400);
      expect((await dndOn(alice, {})).status).toBe(400);
      expect((await dndOn(alice, { minutes: 30, until: inMinutes(30) })).status).toBe(400);
      expect((await dndOn(alice, { until: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
      expect((await dndOn(alice, { until: inMinutes(8 * 24 * 60) })).status).toBe(400);
      expect((await dndOn(alice, { minutes: 10080 })).status).toBe(200);
      expect((await dndOn(alice, { minutes: 1 })).status).toBe(200);
    });

    it('does not change presence', async () => {
      const before = (await getMe(alice)).status;
      await dndOn(alice, { minutes: 30 });
      expect((await getMe(alice)).status).toBe(before);
    });
  });

  describe('pauseNotifications option', () => {
    afterEach(() => resetState(alice));

    it('sets DND together with the status and lifts it when the status is cleared', async () => {
      const expiresAt = inMinutes(60);
      const res = await setStatus(alice, { emoji: '📅', text: 'In a meeting', expiresAt, pauseNotifications: true });
      expect(res.body.dnd).toEqual({ active: true, until: new Date(expiresAt).toISOString() });
      expect((await dndGet(alice)).body.active).toBe(true);

      const cleared = await clearStatus(alice);
      expect(cleared.body.dnd).toEqual({ active: false, until: null });
      expect((await dndGet(alice)).body.active).toBe(false);
    });

    it('keeps DND on until the status is cleared when the status has no expiry', async () => {
      await setStatus(alice, { text: 'Deep work', pauseNotifications: true });
      expect((await dndGet(alice)).body).toEqual({ active: true, until: null });
      await clearStatus(alice);
      expect((await dndGet(alice)).body.active).toBe(false);
    });

    it('lifts the paired DND when saved again without the option', async () => {
      await setStatus(alice, { text: 'Deep work', pauseNotifications: true });
      await setStatus(alice, { text: 'Deep work' });
      expect((await dndGet(alice)).body.active).toBe(false);
    });

    it('keeps a DND the user turned on by hand when the status is cleared', async () => {
      await setStatus(alice, { text: 'Hi' });
      await dndOn(alice, { minutes: 30 });
      await clearStatus(alice);
      expect((await dndGet(alice)).body.active).toBe(true);
    });
  });

  describe('visibility to other users', () => {
    afterEach(() => resetState(alice));

    it('shows others only whether DND is on and when it ends', async () => {
      await setStatus(alice, { text: 'Busy', expiresAt: inMinutes(30), pauseNotifications: true });
      const asBob = await getUser(bob, alice.id);
      expect(Object.keys(asBob.dnd).sort()).toEqual(['active', 'until']);
      expect(asBob.dnd.active).toBe(true);
      expect(asBob).not.toHaveProperty('dndUntil');
      expect(asBob).not.toHaveProperty('dndWithStatus');
      expect(asBob).not.toHaveProperty('customStatusText');

      const listed = (await request(app).get('/users').set(auth(bob)).query({ search: 'Alice' })).body[0];
      expect(listed).not.toHaveProperty('dndWithStatus');
      expect(listed.dnd.active).toBe(true);

      const me = await getMe(alice);
      expect(me).not.toHaveProperty('dndWithStatus');
      expect(me).not.toHaveProperty('customStatusEmoji');
    });
  });

  describe('push suppression', () => {
    let groupId: number;

    // bob에게 푸시가 가는 네 경로: 채널 메시지, 1:1 DM, 그룹 DM, 스레드 답글
    async function triggerAllPaths(tag: string) {
      await request(app).post(`/channels/${pubId}/messages`).set(auth(alice)).send({ content: `channel ${tag}` });
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: `dm ${tag}` });
      await request(app).post(`/dms/groups/${groupId}/messages`).set(auth(alice)).send({ content: `group ${tag}` });
      const parent = (await request(app).post(`/channels/${pubId}/messages`).set(auth(bob)).send({ content: `bob parent ${tag}` })).body;
      await request(app).post(`/messages/${parent.id}/reply`).set(auth(alice)).send({ content: `thread ${tag}` });
      await settle();
      await pause();
    }
    const bodies = () => pushSpy.mock.calls.map((c: unknown[]) => JSON.parse(c[1] as string)) as Array<{ title: string; url: string }>;

    beforeAll(async () => {
      groupId = (await request(app).post('/dms/groups').set(auth(alice)).send({ userIds: [bob.id, carol.id] })).body.group.id;
    });
    beforeEach(async () => {
      await resetState(bob);
      pushSpy.mockClear();
    });
    afterAll(() => resetState(bob));

    it('sends pushes on all four paths when DND is off', async () => {
      await triggerAllPaths('off');
      const titles = bodies().map((b) => b.title);
      expect(titles.some((t: string) => t === '#sd-pub')).toBe(true); // 채널 메시지
      expect(titles.some((t: string) => t === 'Alice')).toBe(true); // 1:1 DM
      expect(bodies().some((b) => b.url === `/g/${groupId}`)).toBe(true); // 그룹 DM
      expect(titles.some((t: string) => t === '#sd-pub thread')).toBe(true); // 스레드 답글
      expect(pushSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('sends nothing while DND is on, then resumes after it is turned off', async () => {
      expect((await dndOn(bob, { minutes: 30 })).status).toBe(200);
      await triggerAllPaths('on');
      expect(pushSpy).not.toHaveBeenCalled();

      expect((await dndOff(bob)).status).toBe(200);
      await triggerAllPaths('after');
      expect(pushSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('sends again once the DND time has passed, without the scheduler', async () => {
      await dndOn(bob, { minutes: 30 });
      await prisma.user.update({ where: { id: bob.id }, data: { dndUntil: new Date(Date.now() - 1000) } });
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'after expiry' });
      await pause();
      expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it('suppresses pushes while a status with pauseNotifications is set and resumes when it is cleared', async () => {
      await setStatus(bob, { text: 'Meeting', pauseNotifications: true });
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'during meeting' });
      await pause();
      expect(pushSpy).not.toHaveBeenCalled();

      await clearStatus(bob);
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'after meeting' });
      await pause();
      expect(pushSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps recording the activity while the push is suppressed', async () => {
      await dndOn(bob, { minutes: 30 });
      const msg = (await request(app).post(`/channels/${pubId}/messages`).set(auth(alice))
        .send({ content: `hey <@${bob.id}|${bob.name}> dnd mention` })).body;
      await settle();
      await pause();
      expect(pushSpy).not.toHaveBeenCalled();
      const rows = await prisma.activity.findMany({ where: { userId: bob.id, messageId: msg.id } });
      expect(rows.length).toBe(1);
      const feed = (await request(app).get('/activity').set(auth(bob))).body;
      expect(JSON.stringify(feed)).toContain('dnd mention');
    });

    it('shouldNotify reflects DND and still allows other users', async () => {
      expect(await shouldNotify(bob.id)).toBe(true);
      await dndOn(bob, { minutes: 30 });
      expect(await shouldNotify(bob.id, { kind: 'dm' })).toBe(false);
      expect(await shouldNotify(carol.id, { kind: 'reminder' })).toBe(true);
    });
  });

  describe('user:status socket event', () => {
    afterEach(() => resetState(alice));

    it('reaches the owner on every tab and shared users, not strangers', async () => {
      const [aliceTab1, aliceTab2, bobSock, daveSock] = [await connect(alice), await connect(alice), await connect(bob), await connect(dave)];
      const a1 = collect(aliceTab1, 'user:status');
      const a2 = collect(aliceTab2, 'user:status');
      const b = collect(bobSock, 'user:status');
      const d = collect(daveSock, 'user:status');
      await pause(); // 연결 직후 room 가입 대기

      await setStatus(alice, { emoji: '🌴', text: 'Away', expiresAt: inMinutes(30) });
      await pause();
      for (const got of [a1, a2, b]) {
        expect(got).toHaveLength(1);
        expect(got[0].userId).toBe(alice.id);
        expect(got[0].customStatus.emoji).toBe('🌴');
        expect(got[0].dnd).toEqual({ active: false, until: null });
      }
      expect(d).toHaveLength(0);

      await dndOn(alice, { minutes: 30 });
      await pause();
      expect(b).toHaveLength(2);
      expect(b[1].dnd.active).toBe(true);
      expect(Object.keys(b[1].dnd).sort()).toEqual(['active', 'until']);

      await dndOff(alice);
      await clearStatus(alice);
      await pause();
      expect(b).toHaveLength(4);
      expect(b[3].customStatus).toBeNull();
      expect(b[3].dnd.active).toBe(false);
      expect(d).toHaveLength(0);
    });

    it('is sent when the status expires and the scheduler step clears it', async () => {
      const bobSock = await connect(bob);
      const aliceSock = await connect(alice);
      await setStatus(alice, { text: 'Short', expiresAt: inMinutes(30), pauseNotifications: true });
      await prisma.user.update({ where: { id: alice.id }, data: { customStatusExpiresAt: new Date(Date.now() - 1000), dndUntil: new Date(Date.now() - 1000) } });
      const b = collect(bobSock, 'user:status');
      const a = collect(aliceSock, 'user:status');
      await pause();

      await clearExpired();
      await pause();
      expect(b).toHaveLength(1);
      expect(b[0]).toEqual({ userId: alice.id, customStatus: null, dnd: { active: false, until: null } });
      expect(a).toHaveLength(1);
    });
  });
});
