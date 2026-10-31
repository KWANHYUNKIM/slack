import { jest } from '@jest/globals';
import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import type { Server } from 'socket.io';
import request from 'supertest';
import webpush from 'web-push';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { settleBackgroundWork as settle } from '../services/mentionService.js';
import { canonicalLocale, canonicalTimeZone } from '../utils/userPrefs.js';
import { pickLocale, pushT, resolvePushLocale } from '../i18n/pushMessages.js';

// i18n-3: 오류 code, User.locale·timeZone, 푸시 문구 번역, 검색 tz 기본값

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-i18n@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

describe('i18n backend', () => {
  let alice: TestUser, kim: TestUser, lee: TestUser;
  let channelId: number;
  let pushSpy: ReturnType<typeof jest.spyOn>;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;

  const patchMe = (u: TestUser, body: object) => request(app).patch('/users/me').set(auth(u)).send(body);
  const getMe = (u: TestUser) => request(app).get('/users/me').set(auth(u));
  const payloadsTo = (endpoint: string) =>
    pushSpy.mock.calls
      .filter((c: unknown) => ((c as unknown[])[0] as { endpoint: string }).endpoint === endpoint)
      .map((c: unknown) => JSON.parse((c as unknown[])[1] as string) as { title: string; body: string; url: string });
  // 푸시는 응답 뒤에 비동기로 나가므로 조건에 맞는 푸시가 올 때까지 잠깐 기다린다
  type Pushed = { title: string; body: string; url: string };
  const pushWhere = async (endpoint: string, match: (p: Pushed) => boolean): Promise<Pushed> => {
    for (let i = 0; i < 60; i++) {
      const found = payloadsTo(endpoint).find(match);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no push to ${endpoint}: ${JSON.stringify(payloadsTo(endpoint))}`);
  };
  // 다른 사람에게 보낸 멘션도 일반 채널 푸시로 같이 오므로, 멘션 푸시만 고른다
  const mentionPushTo = (endpoint: string) => pushWhere(endpoint, (p) => /mention|멘션/.test(p.title));

  beforeAll(async () => {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    pushSpy = jest.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} } as never);

    [alice, kim, lee] = [await register('Alice'), await register('Kim'), await register('Lee')];
    channelId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'i18n-room' })).body.id;
    for (const u of [kim, lee]) await request(app).post(`/channels/${channelId}/join`).set(auth(u));
    // DM 푸시는 소켓 서버가 떠 있어야 나간다(수신자는 연결하지 않아 오프라인)
    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    // 오프라인 수신자의 푸시 구독은 DB에 직접 넣는다
    for (const [u, endpoint] of [[kim, 'http://push.invalid/kim'], [lee, 'http://push.invalid/lee']] as const) {
      await prisma.pushSubscription.create({ data: { userId: u.id, endpoint, p256dh: 'p256dh-key', auth: 'auth-key' } });
    }
  });

  afterAll(async () => {
    pushSpy.mockRestore();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    io.close();
    httpServer.close();
  });

  afterEach(async () => {
    await settle();
    await new Promise((r) => setTimeout(r, 300)); // 늦게 나가는 푸시가 다음 테스트로 새지 않게
    pushSpy.mockClear();
  });

  describe('User.locale and timeZone (CRUD)', () => {
    it('is empty at first, then set, read, changed, and cleared', async () => {
      // Read: 처음엔 비어 있다
      const initial = await getMe(alice);
      expect(initial.body.locale).toBeNull();
      expect(initial.body.timeZone).toBeNull();

      // Create
      const set = await patchMe(alice, { locale: 'ko', timeZone: 'Asia/Seoul' });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ locale: 'ko', timeZone: 'Asia/Seoul' });

      // Read
      const read = await getMe(alice);
      expect(read.body).toMatchObject({ locale: 'ko', timeZone: 'Asia/Seoul' });

      // Update: 정규형으로 저장한다
      const changed = await patchMe(alice, { locale: 'en-us', timeZone: 'america/new_york' });
      expect(changed.body).toMatchObject({ locale: 'en-US', timeZone: 'America/New_York' });
      expect((await getMe(alice)).body).toMatchObject({ locale: 'en-US', timeZone: 'America/New_York' });

      // 한쪽만 바꿔도 다른 쪽은 그대로
      await patchMe(alice, { locale: 'ja' });
      expect((await getMe(alice)).body).toMatchObject({ locale: 'ja', timeZone: 'America/New_York' });

      // Delete: null이면 설정을 지운다
      const cleared = await patchMe(alice, { locale: null, timeZone: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.locale).toBeNull();
      expect((await getMe(alice)).body).toMatchObject({ locale: null, timeZone: null });
    });

    it('rejects invalid values with a stable code and keeps the old value', async () => {
      await patchMe(alice, { locale: 'ko', timeZone: 'Asia/Seoul' });

      for (const locale of ['', 'not a locale', 'ko_KR', 'x'.repeat(36), 123, 'und']) {
        const res = await patchMe(alice, { locale });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe(locale === 123 ? 'VALIDATION_FAILED' : 'INVALID_LOCALE');
      }
      for (const timeZone of ['', 'Mars/Olympus', '+09:00', 'Asia/Seoul; DROP', 'x'.repeat(65)]) {
        const res = await patchMe(alice, { timeZone });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_TIME_ZONE');
      }
      expect((await getMe(alice)).body).toMatchObject({ locale: 'ko', timeZone: 'Asia/Seoul' });
    });

    it('requires authentication and only changes the caller', async () => {
      expect((await request(app).patch('/users/me').send({ locale: 'ko' })).status).toBe(401);
      await patchMe(kim, { locale: 'ko' });
      expect((await getMe(lee)).body.locale).toBeNull();
      await patchMe(kim, { locale: null });
    });

    it('login returns the saved settings', async () => {
      await patchMe(alice, { locale: 'ko', timeZone: 'Asia/Seoul' });
      const res = await request(app).post('/auth/login').send({ email: 'alice-i18n@example.com', password: TEST_PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ locale: 'ko', timeZone: 'Asia/Seoul' });
    });

    it('canonicalizes with Intl', () => {
      expect(canonicalLocale('zh-hant-tw')).toBe('zh-Hant-TW');
      expect(canonicalLocale('ar')).toBe('ar');
      expect(canonicalLocale('en_US')).toBeNull();
      expect(canonicalTimeZone('UTC')).toBe('UTC');
      expect(canonicalTimeZone('Europe/London')).toBe('Europe/London');
      expect(canonicalTimeZone('GMT+9')).toBeNull();
    });
  });

  describe('push text follows the recipient locale', () => {
    const mention = (to: TestUser, content: string) =>
      request(app).post(`/channels/${channelId}/messages`).set(auth(alice)).send({ content: `<@${to.id}|${to.name}> ${content}` });

    it('sends the same mention in Korean to a ko user and in English to an en user', async () => {
      await patchMe(kim, { locale: 'ko-KR' });
      await patchMe(lee, { locale: 'en' });

      expect((await mention(kim, 'please look')).status).toBe(201);
      expect((await mention(lee, 'please look')).status).toBe(201);
      await settle();

      const ko = await mentionPushTo('http://push.invalid/kim');
      const en = await mentionPushTo('http://push.invalid/lee');
      expect(ko.title).toBe('#i18n-room 멘션');
      expect(en.title).toBe('#i18n-room mention');
      expect(ko.body).toBe('Alice: <@' + kim.id + '|Kim> please look');
      expect(en.body).toBe('Alice: <@' + lee.id + '|Lee> please look');
      expect(ko.url).toBe(`/c/${channelId}`);
    });

    it('follows a locale change and falls back to Korean when no locale is saved', async () => {
      await patchMe(kim, { locale: 'en' });
      await mention(kim, 'one');
      await settle();
      expect((await mentionPushTo('http://push.invalid/kim')).title).toBe('#i18n-room mention');
      pushSpy.mockClear();

      await patchMe(kim, { locale: null });
      await mention(kim, 'two');
      await settle();
      expect((await mentionPushTo('http://push.invalid/kim')).title).toBe('#i18n-room 멘션');
    });

    it('translates DM pushes (title is the sender, attachment text is localized)', async () => {
      await patchMe(kim, { locale: 'ko' });
      await patchMe(lee, { locale: 'en' });
      const send = (to: TestUser, content: string) => request(app).post('/dms').set(auth(alice)).send({ toUserId: to.id, content });
      expect((await send(kim, 'hi kim')).status).toBe(201);
      expect((await send(lee, 'hi lee')).status).toBe(201);
      await settle();
      expect(await pushWhere('http://push.invalid/kim', (p) => p.title === 'Alice')).toMatchObject({ body: 'hi kim' });
      expect(await pushWhere('http://push.invalid/lee', (p) => p.title === 'Alice')).toMatchObject({ body: 'hi lee' });
    });

    it('resolves the locale: User.locale wins, then the stored value, then ko', () => {
      expect(resolvePushLocale('en', 'ko')).toBe('en');
      expect(resolvePushLocale('ko-KR', 'en')).toBe('ko');
      expect(resolvePushLocale(null, 'en')).toBe('en');
      expect(resolvePushLocale('ja', 'en')).toBe('en'); // 서버에 번역이 없는 언어는 건너뛴다
      expect(resolvePushLocale(null, null)).toBe('ko');
      expect(pickLocale('fr,en;q=0.5')).toBe('en');
      expect(pushT('en', 'channelMention', { channel: 'x' })).toBe('#x mention');
      // 값 안의 {braces}는 다시 치환하지 않는다
      expect(pushT('en', 'body', { sender: 'a', content: '{sender}' })).toBe('a: {sender}');
    });

    it('prefers User.locale over the Reminder.locale saved at creation', async () => {
      await patchMe(kim, { locale: 'en' });
      const { processDueReminders } = await import('../services/reminderService.js');
      const created = await request(app).post('/reminders').set(auth(kim)).set({ 'Accept-Language': 'ko-KR' })
        .send({ text: 'call mom', remindAt: new Date(Date.now() + 5 * 60_000).toISOString() });
      expect(created.status).toBe(201);
      await prisma.reminder.update({ where: { id: created.body.id }, data: { remindAt: new Date(Date.now() - 1000) } });
      await processDueReminders();
      await settle();
      expect(await pushWhere('http://push.invalid/kim', (p) => p.body === 'call mom')).toMatchObject({ title: 'Reminder' });

      // User.locale이 없으면 만들 때 저장한 값(ko)을 쓴다
      pushSpy.mockClear();
      await patchMe(kim, { locale: null });
      const second = await request(app).post('/reminders').set(auth(kim)).set({ 'Accept-Language': 'en-US' })
        .send({ text: 'fallback', remindAt: new Date(Date.now() + 5 * 60_000).toISOString() });
      await prisma.reminder.update({ where: { id: second.body.id }, data: { remindAt: new Date(Date.now() - 1000) } });
      await processDueReminders();
      await settle();
      expect((await pushWhere('http://push.invalid/kim', (p) => p.body === 'fallback')).title).toBe('Reminder');
    });
  });

  describe('error codes', () => {
    it('login failures return AUTH_INVALID_CREDENTIALS and keep the English error', async () => {
      const wrongPassword = await request(app).post('/auth/login').send({ email: 'alice-i18n@example.com', password: 'wrong-password' });
      expect(wrongPassword.status).toBe(401);
      expect(wrongPassword.body).toEqual({ error: 'Invalid credentials', code: 'AUTH_INVALID_CREDENTIALS' });

      const unknown = await request(app).post('/auth/login').send({ email: 'nobody-i18n@example.com', password: 'whatever1' });
      expect(unknown.status).toBe(401);
      expect(unknown.body.code).toBe('AUTH_INVALID_CREDENTIALS');

      const badEmail = await request(app).post('/auth/login').send({ email: 'not-an-email', password: 'x' });
      expect(badEmail.status).toBe(400);
      expect(badEmail.body.code).toBe('VALIDATION_FAILED');
    });

    it('locks the account with AUTH_ACCOUNT_LOCKED after repeated failures', async () => {
      let last;
      for (let i = 0; i < 11; i++) {
        last = await request(app).post('/auth/login').send({ email: 'locked-i18n@example.com', password: 'wrong-password' });
      }
      expect(last!.status).toBe(429);
      expect(last!.body.code).toBe('AUTH_ACCOUNT_LOCKED');
    });

    it('register: existing email, invalid / expired / exhausted invites', async () => {
      const dup = await request(app).post('/auth/register').send({ email: 'alice-i18n@example.com', password: TEST_PASSWORD, name: 'Dup' });
      expect(dup.status).toBe(400);
      expect(dup.body.code).toBe('AUTH_REGISTRATION_FAILED');

      const reg = (email: string, inviteCode: string) =>
        request(app).post('/auth/register').send({ email, password: TEST_PASSWORD, name: 'New', inviteCode });

      const invalid = await reg('inv1-i18n@example.com', 'no-such-code');
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('INVITE_INVALID');

      await prisma.inviteLink.create({ data: { code: 'i18n-expired', createdBy: alice.id, expiresAt: new Date(Date.now() - 60_000) } });
      const expired = await reg('inv2-i18n@example.com', 'i18n-expired');
      expect(expired.body.code).toBe('INVITE_EXPIRED');

      await prisma.inviteLink.create({ data: { code: 'i18n-used', createdBy: alice.id, maxUses: 1, useCount: 1 } });
      const exhausted = await reg('inv3-i18n@example.com', 'i18n-used');
      expect(exhausted.body.code).toBe('INVITE_EXHAUSTED');

      // 유효한 초대는 성공하고 사용 횟수가 오른다
      await prisma.inviteLink.create({ data: { code: 'i18n-ok', createdBy: alice.id, maxUses: 1 } });
      expect((await reg('inv4-i18n@example.com', 'i18n-ok')).status).toBe(201);
      const again = await reg('inv5-i18n@example.com', 'i18n-ok');
      expect(again.status).toBe(400);
      expect(again.body.code).toBe('INVITE_EXHAUSTED');
    });

    it('GET /auth/invite/:code returns INVITE_* codes', async () => {
      const missing = await request(app).get('/auth/invite/missing-code');
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: 'Invite not found', code: 'INVITE_NOT_FOUND' });
      expect((await request(app).get('/auth/invite/i18n-expired')).body.code).toBe('INVITE_EXPIRED');
      expect((await request(app).get('/auth/invite/i18n-used')).body.code).toBe('INVITE_EXHAUSTED');
      await prisma.inviteLink.create({ data: { code: 'i18n-valid', createdBy: alice.id } });
      const ok = await request(app).get('/auth/invite/i18n-valid');
      expect(ok.status).toBe(200);
      expect(ok.body.valid).toBe(true);
      expect((await request(app).get(`/auth/invite/${'x'.repeat(65)}`)).body.code).toBe('INVITE_INVALID');
    });

    it('common 400 / 401 / 403 / 404 responses carry a code', async () => {
      // 401: 토큰 없음, 잘못된 토큰
      expect((await request(app).get('/users/me')).body.code).toBe('AUTH_NO_TOKEN');
      expect((await request(app).get('/users/me').set({ Authorization: 'Bearer garbage' })).body.code).toBe('AUTH_INVALID_TOKEN');
      // 400: JSON 형식 오류, 검증 오류
      const badJson = await request(app).post('/auth/login').set('Content-Type', 'application/json').send('{bad');
      expect(badJson.status).toBe(400);
      expect(badJson.body.code).toBe('INVALID_JSON');
      expect((await patchMe(alice, { name: '' })).body.code).toBe('VALIDATION_FAILED');
      // 403 / 404: 채널 접근
      const priv = await request(app).post('/channels').set(auth(alice)).send({ name: 'i18n-priv', isPrivate: true });
      const forbidden = await request(app).get(`/channels/${priv.body.id}/messages`).set(auth(lee));
      expect(forbidden.status).toBe(403);
      expect(typeof forbidden.body.code).toBe('string');
      const missing = await request(app).get('/channels/99999999/messages').set(auth(alice));
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('CHANNEL_NOT_FOUND');
      expect((await request(app).get('/channels/abc/messages').set(auth(alice))).body.code).toBe('INVALID_CHANNEL_ID');
      // 기존 code는 이름 그대로 유지된다
      const dupChannel = await request(app).post('/channels').set(auth(alice)).send({ name: 'i18n-room' });
      expect(dupChannel.body.code).toBe('CHANNEL_NAME_TAKEN');
    });

    it('does not leak internals in error responses', async () => {
      const res = await request(app).get('/channels/99999999/messages').set(auth(alice));
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/prisma|stack|at .*\.ts|node_modules/i);
    });
  });

  describe('search defaults to the saved time zone', () => {
    it('uses User.timeZone when the tz param is absent, and the param wins when given', async () => {
      // 2026-01-01 00:30 KST(= 2025-12-31 15:30 UTC)에 쓴 메시지를 `on:2026-01-01`로 찾는다
      const msg = await prisma.message.create({
        data: { content: 'zonedtoken alpha', userId: alice.id, channelId, createdAt: new Date('2025-12-31T15:30:00Z') },
      });
      const search = (qs = '') => request(app).get(`/search?q=${encodeURIComponent('zonedtoken on:2026-01-01')}${qs}`).set(auth(alice));
      const ids = (res: request.Response) => (res.body.results as Array<{ id: number }>).map((m) => m.id);

      await patchMe(alice, { timeZone: null });
      expect(ids(await search())).not.toContain(msg.id); // UTC로는 12월 31일
      await patchMe(alice, { timeZone: 'Asia/Seoul' });
      expect(ids(await search())).toContain(msg.id); // 저장한 시간대(KST)로는 1월 1일
      expect(ids(await search('&tz=UTC'))).not.toContain(msg.id); // 파라미터가 우선
    });
  });
});
