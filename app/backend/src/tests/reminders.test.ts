import { jest } from '@jest/globals';
import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import webpush from 'web-push';
import { listenOnLoopback } from './listenLoopback.js';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { settleBackgroundWork as settle } from '../services/mentionService.js';
import { processDueReminders, MAX_PENDING_REMINDERS, MAX_DELIVERY_ATTEMPTS, pickLocale, pushTextFor } from '../services/reminderService.js';

// 파트 09: 리마인더 CRUD, 권한, 시각 도달 처리(활동·푸시·소켓), 방해금지 억제

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-rm@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('Reminders', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  let alice: TestUser, bob: TestUser, carol: TestUser;
  let pubId: number;
  let privId: number;
  let pushSpy: ReturnType<typeof jest.spyOn>;
  const sockets: ClientSocket[] = [];

  const create = (u: TestUser, body: object, lang?: string) =>
    request(app).post('/reminders').set(auth(u)).set(lang ? { 'Accept-Language': lang } : {}).send(body);
  const list = async (u: TestUser, status = 'pending') => (await request(app).get(`/reminders?status=${status}`).set(auth(u))).body.items;
  const patch = (u: TestUser, id: number, body: object) => request(app).patch(`/reminders/${id}`).set(auth(u)).send(body);
  const remove = (u: TestUser, id: number) => request(app).delete(`/reminders/${id}`).set(auth(u));
  const postMessage = async (u: TestUser, channelId: number, content: string) =>
    (await request(app).post(`/channels/${channelId}/messages`).set(auth(u)).send({ content })).body;
  const activities = async (u: TestUser) => (await request(app).get('/activity?type=all').set(auth(u))).body.items;
  /** 시계를 조작하는 대신 예정 시각을 과거로 돌린다 */
  const makeDue = (id: number) => prisma.reminder.update({ where: { id }, data: { remindAt: new Date(Date.now() - 1000) } });
  const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));

  function connect(u: TestUser): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = Client(`http://127.0.0.1:${port}`, { auth: { token: u.token }, forceNew: true });
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

    [alice, bob, carol] = [await register('Alice'), await register('Bob'), await register('Carol')];
    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'rm-pub' })).body.id;
    privId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'rm-priv', isPrivate: true })).body.id;
    for (const u of [bob, carol]) await request(app).post(`/channels/${pubId}/join`).set(auth(u));
    // 푸시 구독은 DB에 직접 넣는다(오프라인 사용자 bob)
    await prisma.pushSubscription.create({
      data: { userId: bob.id, endpoint: 'http://push.invalid/rm-bob', p256dh: 'p256dh-key', auth: 'auth-key' },
    });

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    port = await listenOnLoopback(httpServer);
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
    pushSpy.mockClear();
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/reminders').send({ text: 'x', remindAt: inMinutes(5) })).status).toBe(401);
    expect((await request(app).get('/reminders')).status).toBe(401);
    expect((await request(app).patch('/reminders/1').send({ completed: true })).status).toBe(401);
    expect((await request(app).delete('/reminders/1')).status).toBe(401);
  });

  describe('CRUD', () => {
    it('creates, lists, snoozes, completes and deletes, repeatedly', async () => {
      const msg = await postMessage(alice, pubId, 'remember this message');
      for (let round = 1; round <= 2; round++) {
        // Create
        const created = await create(alice, { messageId: msg.id, remindAt: inMinutes(20) });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ messageId: msg.id, channelId: pubId, messageDeleted: false });
        expect(created.body.message.excerpt).toBe('remember this message');
        const id = created.body.id;

        // Read
        expect((await list(alice)).map((r: any) => r.id)).toContain(id);
        expect((await list(alice, 'done')).map((r: any) => r.id)).not.toContain(id);

        // Update: 스누즈
        const later = inMinutes(60);
        const snoozed = await patch(alice, id, { remindAt: later });
        expect(snoozed.status).toBe(200);
        expect(new Date(snoozed.body.remindAt).toISOString()).toBe(later);

        // Update: 완료 -> done 목록으로 이동
        const done = await patch(alice, id, { completed: true });
        expect(done.body.completedAt).not.toBeNull();
        expect((await list(alice)).map((r: any) => r.id)).not.toContain(id);
        expect((await list(alice, 'done')).map((r: any) => r.id)).toContain(id);

        // 되돌리기
        const reopened = await patch(alice, id, { completed: false });
        expect(reopened.body.completedAt).toBeNull();
        expect((await list(alice)).map((r: any) => r.id)).toContain(id);

        // Delete
        expect((await remove(alice, id)).status).toBe(200);
        expect((await list(alice)).map((r: any) => r.id)).not.toContain(id);
        expect((await remove(alice, id)).status).toBe(404);
        expect((await patch(alice, id, { completed: true })).status).toBe(404);
      }
    });

    it('creates a text-only reminder (/remind) and a DM reminder', async () => {
      const text = await create(alice, { text: '  물   마시기 ', remindAt: inMinutes(2) });
      expect(text.status).toBe(201);
      expect(text.body).toMatchObject({ text: '물 마시기', messageId: null, messageDeleted: false });

      const dm = (await request(app).post('/dms').set(auth(bob)).send({ toUserId: alice.id, content: 'dm hello' })).body;
      const dmRem = await create(alice, { dmId: dm.id, remindAt: inMinutes(5) });
      expect(dmRem.status).toBe(201);
      expect(dmRem.body).toMatchObject({ dmId: dm.id, dmUserId: bob.id, messageDeleted: false });
      expect(dmRem.body.message.excerpt).toBe('dm hello');
    });

    it('lists pending reminders in remindAt order', async () => {
      await prisma.reminder.deleteMany({ where: { userId: carol.id } });
      const b = await create(carol, { text: 'second', remindAt: inMinutes(30) });
      const a = await create(carol, { text: 'first', remindAt: inMinutes(10) });
      expect((await list(carol)).map((r: any) => r.id)).toEqual([a.body.id, b.body.id]);
    });
  });

  describe('validation', () => {
    it('rejects past, too-far, empty and malformed requests', async () => {
      const msg = await postMessage(alice, pubId, 'v');
      expect((await create(alice, { messageId: msg.id, remindAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
      const farFuture = new Date(Date.now() + 400 * 24 * 3600_000).toISOString();
      expect((await create(alice, { messageId: msg.id, remindAt: farFuture })).status).toBe(400);
      expect((await create(alice, { remindAt: inMinutes(5) })).status).toBe(400); // 대상도 본문도 없음
      expect((await create(alice, { text: '   ', remindAt: inMinutes(5) })).status).toBe(400);
      expect((await create(alice, { messageId: msg.id, dmId: 1, remindAt: inMinutes(5) })).status).toBe(400);
      expect((await create(alice, { text: 'x', remindAt: 'tomorrow' })).status).toBe(400);
      expect((await create(alice, { text: 'x'.repeat(501), remindAt: inMinutes(5) })).status).toBe(400);
      expect((await create(alice, { text: 'x', remindAt: inMinutes(5), userId: bob.id })).status).toBe(400); // 알 수 없는 키
      expect((await patch(alice, 1, {})).status).toBe(400);
      expect((await patch(alice, 1, { completed: true, remindAt: inMinutes(5) })).status).toBe(400);
      expect((await request(app).get('/reminders?status=bogus').set(auth(alice))).status).toBe(400);
      expect((await request(app).patch('/reminders/abc').set(auth(alice)).send({ completed: true })).status).toBe(400);
    });

    it('rejects a snooze into the past', async () => {
      const r = await create(alice, { text: 'snooze me', remindAt: inMinutes(5) });
      expect((await patch(alice, r.body.id, { remindAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
    });

    it('caps pending reminders per user', async () => {
      await prisma.reminder.deleteMany({ where: { userId: carol.id } });
      await prisma.reminder.createMany({
        data: Array.from({ length: MAX_PENDING_REMINDERS }, (_, i) => ({ userId: carol.id, text: `r${i}`, remindAt: new Date(Date.now() + 3600_000) })),
      });
      expect((await create(carol, { text: 'one too many', remindAt: inMinutes(5) })).status).toBe(400);
      // 완료하면 자리가 난다
      const first = await prisma.reminder.findFirstOrThrow({ where: { userId: carol.id } });
      expect((await patch(carol, first.id, { completed: true })).status).toBe(200);
      expect((await create(carol, { text: 'fits now', remindAt: inMinutes(5) })).status).toBe(201);
      await prisma.reminder.deleteMany({ where: { userId: carol.id } });
    });
  });

  describe('authorization', () => {
    it('hides other users reminders (404) and never lists them', async () => {
      const mine = await create(alice, { text: 'private note', remindAt: inMinutes(10) });
      expect((await patch(bob, mine.body.id, { completed: true })).status).toBe(404);
      expect((await patch(bob, mine.body.id, { remindAt: inMinutes(20) })).status).toBe(404);
      expect((await remove(bob, mine.body.id)).status).toBe(404);
      expect((await list(bob)).map((r: any) => r.id)).not.toContain(mine.body.id);
      // 그대로 남아 있다
      const still = (await list(alice)).find((r: any) => r.id === mine.body.id);
      expect(still).toBeDefined();
      expect(still.completedAt).toBeNull();
    });

    it('refuses a reminder on a message the user cannot access', async () => {
      const secret = await postMessage(alice, privId, 'secret');
      expect((await create(bob, { messageId: secret.id, remindAt: inMinutes(10) })).status).toBe(404);
      expect((await create(bob, { messageId: 99999999, remindAt: inMinutes(10) })).status).toBe(404);
      const dm = (await request(app).post('/dms').set(auth(alice)).send({ toUserId: carol.id, content: 'for carol' })).body;
      expect((await create(bob, { dmId: dm.id, remindAt: inMinutes(10) })).status).toBe(404);
      expect(await prisma.reminder.count({ where: { userId: bob.id, remindAt: { gt: new Date() }, messageId: secret.id } })).toBe(0);
    });

    it('refuses a deleted message', async () => {
      const m = await postMessage(alice, pubId, 'gone soon');
      await request(app).delete(`/messages/${m.id}`).set(auth(alice));
      expect((await create(alice, { messageId: m.id, remindAt: inMinutes(10) })).status).toBe(404);
    });

    it('stops showing the excerpt after the user leaves the channel', async () => {
      const ch = (await request(app).post('/channels').set(auth(alice)).send({ name: 'rm-leave' })).body.id;
      await request(app).post(`/channels/${ch}/join`).set(auth(bob));
      const m = await postMessage(alice, ch, 'visible while member');
      const r = await create(bob, { messageId: m.id, remindAt: inMinutes(10) });
      expect(r.body.message.excerpt).toBe('visible while member');
      await request(app).post(`/channels/${ch}/leave`).set(auth(bob));
      const after = (await list(bob)).find((x: any) => x.id === r.body.id);
      expect(after.message).toBeNull();
      expect(after.messageDeleted).toBe(true);
    });

    it('keeps a reminder when its message is deleted, marking it deleted', async () => {
      const m = await postMessage(alice, pubId, 'will be deleted');
      const r = await create(alice, { messageId: m.id, remindAt: inMinutes(10) });
      await request(app).delete(`/messages/${m.id}`).set(auth(alice));
      const after = (await list(alice)).find((x: any) => x.id === r.body.id);
      expect(after).toBeDefined();
      expect(after.messageDeleted).toBe(true);
      expect(after.message).toBeNull();
    });
  });

  describe('delivery', () => {
    beforeEach(async () => {
      await prisma.user.update({ where: { id: bob.id }, data: { dndUntil: null, dndWithStatus: false } });
    });

    it('fires once: one activity, one reminder:due, even when ticks overlap', async () => {
      const s = await connect(alice);
      const due = collect(s, 'reminder:due');
      const newActivity = collect(s, 'activity:new');
      const msg = await postMessage(bob, pubId, 'please follow up');
      const r = await create(alice, { messageId: msg.id, remindAt: inMinutes(10) });

      expect(await processDueReminders()).toBe(0); // 아직 시각 전
      await makeDue(r.body.id);
      const fired = await Promise.all([processDueReminders(), processDueReminders()]);
      expect(fired.reduce((a, b) => a + b, 0)).toBe(1); // firedAt 선점으로 한 번만
      expect(await processDueReminders()).toBe(0);
      await settle();
      await pause();

      expect(due).toHaveLength(1);
      expect(due[0].reminder.id).toBe(r.body.id);
      expect(due[0].reminder.firedAt).not.toBeNull();
      expect(newActivity.filter((e) => e.activity.type === 'REMINDER')).toHaveLength(1);

      const mine = (await activities(alice)).filter((a: any) => a.type === 'REMINDER');
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ messageId: msg.id, reminder: { id: r.body.id } });
      expect(mine[0].message.excerpt).toBe('please follow up');
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(1);
      // 다른 사람에게는 활동이 없다
      expect((await activities(bob)).filter((a: any) => a.type === 'REMINDER')).toHaveLength(0);
    });

    it('does not fire completed reminders and refires after a snooze, replacing the old activity', async () => {
      const r1 = await create(alice, { text: 'completed one', remindAt: inMinutes(10) });
      await makeDue(r1.body.id);
      await patch(alice, r1.body.id, { completed: true });
      expect(await processDueReminders()).toBe(0);

      const r2 = await create(alice, { text: 'snoozed one', remindAt: inMinutes(10) });
      await makeDue(r2.body.id);
      expect(await processDueReminders()).toBe(1);
      await settle();
      expect(await prisma.activity.count({ where: { reminderId: r2.body.id } })).toBe(1);

      const snoozed = await patch(alice, r2.body.id, { remindAt: inMinutes(10) });
      expect(snoozed.body.firedAt).toBeNull();
      expect(await prisma.activity.count({ where: { reminderId: r2.body.id } })).toBe(0);
      await makeDue(r2.body.id);
      expect(await processDueReminders()).toBe(1);
      await settle();
      expect(await prisma.activity.count({ where: { reminderId: r2.body.id } })).toBe(1);

      // 삭제하면 활동도 사라진다
      expect((await remove(alice, r2.body.id)).status).toBe(200);
      await settle();
      expect(await prisma.activity.count({ where: { reminderId: r2.body.id } })).toBe(0);
    });

    it('delivers a text reminder as an activity without a target message', async () => {
      const r = await create(alice, { text: '물 마시기', remindAt: inMinutes(2) });
      await makeDue(r.body.id);
      await processDueReminders();
      await settle();
      const item = (await activities(alice)).find((a: any) => a.reminder?.id === r.body.id);
      expect(item).toMatchObject({ type: 'REMINDER', message: null, reminder: { id: r.body.id, text: '물 마시기' } });
    });

    it('keeps the activity when the target message is later deleted', async () => {
      const m = await postMessage(bob, pubId, 'bob says');
      const r = await create(alice, { messageId: m.id, remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      await processDueReminders();
      await settle();
      await request(app).delete(`/messages/${m.id}`).set(auth(bob));
      await settle();
      const item = (await activities(alice)).find((a: any) => a.reminder?.id === r.body.id);
      expect(item).toBeDefined();
      expect(item.message).toBeNull();
    });

    it('sends a push to an offline user', async () => {
      const r = await create(bob, { text: 'push me', remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      await processDueReminders();
      await settle();
      expect(pushSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse((pushSpy.mock.calls[0] as unknown[])[1] as string);
      expect(payload.body).toBe('push me');
    });

    it('suppresses the push but keeps the activity during do-not-disturb', async () => {
      await prisma.user.update({ where: { id: bob.id }, data: { dndUntil: new Date(Date.now() + 3600_000) } });
      const r = await create(bob, { text: 'quiet please', remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      await processDueReminders();
      await settle();
      expect(pushSpy).not.toHaveBeenCalled();
      expect(await prisma.activity.count({ where: { userId: bob.id, type: 'REMINDER', reminderId: r.body.id } })).toBe(1);
      expect((await prisma.reminder.findUniqueOrThrow({ where: { id: r.body.id } })).firedAt).not.toBeNull();
    });

    it('skips deactivated users', async () => {
      const r = await create(carol, { text: 'deactivated soon', remindAt: inMinutes(5) });
      await prisma.user.update({ where: { id: carol.id }, data: { deactivatedAt: new Date() } });
      await makeDue(r.body.id);
      await processDueReminders();
      await settle();
      await prisma.user.update({ where: { id: carol.id }, data: { deactivatedAt: null } });
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(0);
    });
  });

  describe('completion, listing and cap', () => {
    it('removes the reminder activity when completed, and tells the other tabs', async () => {
      const s = await connect(alice);
      const removed = collect(s, 'activity:removed');
      const r = await create(alice, { text: 'complete removes activity', remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      await processDueReminders();
      await settle();
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(1);
      const activityId = (await prisma.activity.findFirstOrThrow({ where: { reminderId: r.body.id } })).id;

      expect((await patch(alice, r.body.id, { completed: true })).status).toBe(200);
      await settle();
      await pause();
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(0);
      expect(removed.some((e) => e.ids.includes(activityId))).toBe(true);
      expect((await activities(alice)).some((a: any) => a.reminder?.id === r.body.id)).toBe(false);
      // 되돌려도 이미 울린 회차라 활동은 다시 생기지 않는다
      await patch(alice, r.body.id, { completed: false });
      expect(await processDueReminders()).toBe(0);
    });

    it('returns the whole pending list by default and pages the done list with a cursor', async () => {
      await prisma.reminder.deleteMany({ where: { userId: carol.id } });
      await prisma.reminder.createMany({
        data: Array.from({ length: 150 }, (_, i) => ({ userId: carol.id, text: `p${i}`, remindAt: new Date(Date.now() + 3600_000 + i) })),
      });
      expect((await list(carol)).length).toBe(150);
      await prisma.reminder.deleteMany({ where: { userId: carol.id } });

      const base = Date.now() - 100_000;
      await prisma.reminder.createMany({
        data: Array.from({ length: 5 }, (_, i) => ({
          userId: carol.id, text: `d${i}`, remindAt: new Date(base), completedAt: new Date(base + (i < 2 ? 0 : i * 1000)),
        })),
      });
      const page1 = (await request(app).get('/reminders?status=done&limit=2').set(auth(carol))).body;
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBe(page1.items[1].id);
      const page2 = (await request(app).get(`/reminders?status=done&limit=2&cursor=${page1.nextCursor}`).set(auth(carol))).body;
      const page3 = (await request(app).get(`/reminders?status=done&limit=2&cursor=${page2.nextCursor}`).set(auth(carol))).body;
      const all = [...page1.items, ...page2.items, ...page3.items].map((r: any) => r.id);
      expect(all).toHaveLength(5);
      expect(new Set(all).size).toBe(5); // 같은 completedAt이 섞여 있어도 겹침과 누락이 없다
      expect(page3.nextCursor).toBeNull();
      // 남의 cursor는 빈 결과
      const foreign = (await request(app).get(`/reminders?status=done&cursor=${all[0]}`).set(auth(bob))).body;
      expect(foreign.items).toEqual([]);
      await prisma.reminder.deleteMany({ where: { userId: carol.id } });
    });

    it('counts reopening and snoozing a completed reminder against the cap', async () => {
      await prisma.reminder.deleteMany({ where: { userId: carol.id } });
      const done = await create(carol, { text: 'done one', remindAt: inMinutes(5) });
      await patch(carol, done.body.id, { completed: true });
      await prisma.reminder.createMany({
        data: Array.from({ length: MAX_PENDING_REMINDERS }, (_, i) => ({ userId: carol.id, text: `r${i}`, remindAt: new Date(Date.now() + 3600_000) })),
      });
      expect((await patch(carol, done.body.id, { completed: false })).status).toBe(400);
      expect((await patch(carol, done.body.id, { remindAt: inMinutes(30) })).status).toBe(400);
      await prisma.reminder.deleteMany({ where: { userId: carol.id } });
    });
  });

  describe('delivery races', () => {
    /**
     * 활동을 만드는 도중에 끼어들 동작을 심는다(한 번만).
     * 라우트를 부르면 같은 키의 활동 큐에서 이 insert를 기다리게 되어 교착하므로, 이미 커밋된 변경을 DB에 직접 넣는다.
     */
    function interceptActivityCreate(during: () => Promise<unknown>) {
      const original = prisma.activity.createManyAndReturn.bind(prisma.activity);
      return jest.spyOn(prisma.activity, 'createManyAndReturn').mockImplementationOnce(((args: never) =>
        during().then(() => original(args))) as never);
    }

    it('drops the activity when the reminder is snoozed while it is being delivered, then fires the next round', async () => {
      const r = await create(alice, { text: 'snooze race', remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      const spy = interceptActivityCreate(() => prisma.reminder.update({ where: { id: r.body.id }, data: { remindAt: new Date(Date.now() + 1800_000), firedAt: null } }));
      await processDueReminders();
      await settle();
      spy.mockRestore();

      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(0); // 낡은 회차의 활동이 남지 않는다
      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: r.body.id } });
      expect(row.firedAt).toBeNull();

      await makeDue(r.body.id);
      expect(await processDueReminders()).toBe(1);
      await settle();
      const acts = await prisma.activity.findMany({ where: { reminderId: r.body.id } });
      expect(acts).toHaveLength(1);
      expect(acts[0].reminderSeq).toBe(2); // 회차가 달라 새 활동이 생긴다
    });

    it('allows a new activity per round even if the old one was not cleaned up', async () => {
      const r = await create(alice, { text: 'round unique', remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      await processDueReminders();
      await settle();
      // 스누즈의 활동 정리를 거치지 않고 회차만 되감는다
      await prisma.reminder.update({ where: { id: r.body.id }, data: { firedAt: null, remindAt: new Date(Date.now() - 1000) } });
      expect(await processDueReminders()).toBe(1);
      await settle();
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(2);
    });

    it('drops the activity when the reminder is deleted while it is being delivered', async () => {
      const r = await create(alice, { text: 'delete race', remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      const spy = interceptActivityCreate(() => prisma.reminder.delete({ where: { id: r.body.id } }));
      await processDueReminders();
      await settle();
      spy.mockRestore();
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(0);
      expect(await prisma.reminder.count({ where: { id: r.body.id } })).toBe(0);
    });

    it('drops the activity when the reminder is completed while it is being delivered', async () => {
      const r = await create(alice, { text: 'complete race', remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      const spy = interceptActivityCreate(() => prisma.reminder.update({ where: { id: r.body.id }, data: { completedAt: new Date() } }));
      await processDueReminders();
      await settle();
      spy.mockRestore();
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(0);
    });
  });

  describe('delivery failure', () => {
    it('reverts the claim and retries on the next tick', async () => {
      const r = await create(alice, { text: 'retry me', remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      const spy = jest.spyOn(prisma.activity, 'createManyAndReturn').mockRejectedValueOnce(new Error('db down') as never);
      expect(await processDueReminders()).toBe(1);
      await settle();
      const failed = await prisma.reminder.findUniqueOrThrow({ where: { id: r.body.id } });
      expect(failed).toMatchObject({ firedAt: null, failCount: 1, failedAt: null });
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(0);
      spy.mockRestore();

      expect(await processDueReminders()).toBe(1); // 다음 틱
      await settle();
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(1);
      expect((await prisma.reminder.findUniqueOrThrow({ where: { id: r.body.id } })).firedAt).not.toBeNull();
    });

    it('gives up and marks failed after the attempt limit, until the user snoozes it', async () => {
      const r = await create(alice, { text: 'always fails', remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      const spy = jest.spyOn(prisma.activity, 'createManyAndReturn').mockRejectedValue(new Error('db down') as never);
      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) expect(await processDueReminders()).toBe(1);
      await settle();
      const row = await prisma.reminder.findUniqueOrThrow({ where: { id: r.body.id } });
      expect(row.failCount).toBe(MAX_DELIVERY_ATTEMPTS);
      expect(row.failedAt).not.toBeNull();
      expect(await processDueReminders()).toBe(0); // 더 시도하지 않는다
      spy.mockRestore();

      expect((await patch(alice, r.body.id, { remindAt: inMinutes(10) })).status).toBe(200);
      const reset = await prisma.reminder.findUniqueOrThrow({ where: { id: r.body.id } });
      expect(reset).toMatchObject({ failCount: 0, failedAt: null });
      await makeDue(r.body.id);
      expect(await processDueReminders()).toBe(1);
      await settle();
      expect(await prisma.activity.count({ where: { reminderId: r.body.id } })).toBe(1);
    });
  });

  describe('1:1 DM activity', () => {
    it('carries the other participant so the click can open the conversation', async () => {
      const dm = (await request(app).post('/dms').set(auth(bob)).send({ toUserId: alice.id, content: 'dm for reminder activity' })).body;
      const r = await create(alice, { dmId: dm.id, remindAt: inMinutes(5) });
      await makeDue(r.body.id);
      await processDueReminders();
      await settle();
      const item = (await activities(alice)).find((a: any) => a.reminder?.id === r.body.id);
      expect(item).toMatchObject({ type: 'REMINDER', dmId: dm.id, dmUserId: bob.id, dmGroupId: null });
      // 채널 활동에는 없다
      const m = await postMessage(bob, pubId, 'channel one');
      const cr = await create(alice, { messageId: m.id, remindAt: inMinutes(5) });
      await makeDue(cr.body.id);
      await processDueReminders();
      await settle();
      const ch = (await activities(alice)).find((a: any) => a.reminder?.id === cr.body.id);
      expect(ch.dmUserId).toBeNull();
    });
  });

  describe('push text', () => {
    beforeEach(async () => {
      await prisma.user.update({ where: { id: bob.id }, data: { dndUntil: null, dndWithStatus: false } });
    });

    it('picks the locale from Accept-Language and defaults to Korean', () => {
      expect(pickLocale('en-US,en;q=0.9')).toBe('en');
      expect(pickLocale('ko-KR,ko;q=0.9,en;q=0.8')).toBe('ko');
      expect(pickLocale('fr-FR,fr;q=0.9')).toBeNull();
      expect(pickLocale(undefined)).toBeNull();
      expect(pushTextFor(null, '')).toEqual({ title: '리마인더', body: '메시지에 대한 리마인더' });
      expect(pushTextFor('en', '  ')).toEqual({ title: 'Reminder', body: 'Reminder about a message' });
      expect(pushTextFor('ko', 'x'.repeat(300)).body).toHaveLength(100);
    });

    it('sends the push in the locale saved when the reminder was created', async () => {
      const en = await create(bob, { text: 'english please', remindAt: inMinutes(5) }, 'en-US,en;q=0.9');
      const ko = await create(bob, { text: '한국어로', remindAt: inMinutes(5) }, 'ko-KR');
      const none = await create(bob, { text: 'no header', remindAt: inMinutes(5) }, 'fr-FR');
      for (const r of [en, ko, none]) await makeDue(r.body.id);
      await processDueReminders();
      await settle();
      const payloads = pushSpy.mock.calls.map((c: unknown) => JSON.parse((c as unknown[])[1] as string));
      const byBody = (b: string) => payloads.find((p: { body: string }) => p.body === b);
      expect(byBody('english please').title).toBe('Reminder');
      expect(byBody('한국어로').title).toBe('리마인더');
      expect(byBody('no header').title).toBe('리마인더');
    });
  });

  describe('socket sync', () => {
    it('emits reminder:updated and reminder:removed to every tab of the owner only', async () => {
      const tabA = await connect(alice);
      const tabB = await connect(alice);
      const other = await connect(bob);
      const updatedA = collect(tabA, 'reminder:updated');
      const updatedB = collect(tabB, 'reminder:updated');
      const removedB = collect(tabB, 'reminder:removed');
      const otherEvents = collect(other, 'reminder:updated');

      const r = await create(alice, { text: 'sync me', remindAt: inMinutes(5) });
      await patch(alice, r.body.id, { remindAt: inMinutes(15) });
      await patch(alice, r.body.id, { completed: true });
      await remove(alice, r.body.id);
      await pause(500);

      expect(updatedA).toHaveLength(3);
      expect(updatedB).toHaveLength(3);
      expect(updatedB[2].reminder.completedAt).not.toBeNull();
      expect(removedB).toEqual([{ id: r.body.id }]);
      expect(otherEvents).toHaveLength(0);
    });
  });
});
