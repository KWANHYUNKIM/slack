import { TEST_PASSWORD } from './test-constants.js';
import { jest } from '@jest/globals';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { EventEmitter } from 'events';
import { csvCell, EXPORT_MAX_ROWS, issueExportToken, consumeExportToken, writeWithBackpressure, iterateAuditRows, EXPORT_TOKEN_TTL_MS } from '../services/auditLogService.js';
import { purgeOldAuditLogs, hashEmailForAudit, throttleUnknownLogin, resetUnknownLoginThrottle } from '../utils/auditLog.js';
import { purgeAuditLogsIfDue } from '../scheduler.js';

// 감사 로그 기록 범위, 조회·내보내기, 보존 정리 (E4)
describe('Audit logs', () => {
  const NEW_PASSWORD = `${TEST_PASSWORD}-changed-9`;
  let adminToken: string;
  let adminId: number;
  let memberToken: string;
  let memberId: number;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  // 기록은 응답을 기다리지 않는 경우가 있어 잠깐 폴링한다
  async function waitFor(where: Record<string, unknown>) {
    for (let i = 0; i < 40; i++) {
      const row = await prisma.auditLog.findFirst({ where, orderBy: { id: 'desc' } });
      if (row) return row;
      await new Promise((r) => setTimeout(r, 25));
    }
    return null;
  }

  // 내보내기: 토큰을 받고(POST) 그 토큰으로 파일을 받는다(GET, 인증 헤더 없음)
  async function exportFile(query: string, body: Record<string, unknown> = {}) {
    const t = await request(app).post('/admin/audit-logs/export-token').set(auth(adminToken)).send(body).expect(201);
    return request(app).get(`/admin/audit-logs/export?${query}&token=${t.body.token}`).expect(200);
  }

  async function reset() {
    await prisma.inviteLink.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.webhook.deleteMany();
    await prisma.personalAccessToken.deleteMany();
    await prisma.bookmark.deleteMany();
    await prisma.scheduledMessage.deleteMany();
    await prisma.reaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.directMessage.deleteMany();
    await prisma.user.deleteMany();
  }

  async function seedUsers() {
    const a = await request(app).post('/auth/register').send({ email: 'audit-admin@example.com', password: TEST_PASSWORD, name: 'Audit Admin' });
    adminId = a.body.user.id;
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });
    adminToken = (await request(app).post('/auth/login').send({ email: 'audit-admin@example.com', password: TEST_PASSWORD })).body.token;
    const m = await request(app).post('/auth/register').send({ email: 'audit-member@example.com', password: TEST_PASSWORD, name: 'Audit Member' });
    memberToken = m.body.token;
    memberId = m.body.user.id;
    await prisma.auditLog.deleteMany(); // 시드 중 생긴 로그인 기록은 지운다
  }

  beforeEach(async () => {
    resetUnknownLoginThrottle();
    await reset();
    await seedUsers();
  });

  describe('recording', () => {
    it('records login success and failures without the email address', async () => {
      await request(app).post('/auth/login').send({ email: 'audit-member@example.com', password: TEST_PASSWORD }).expect(200);
      expect(await waitFor({ action: 'auth.login', actorId: memberId })).not.toBeNull();

      await request(app).post('/auth/login').send({ email: 'audit-member@example.com', password: 'wrong-password-1' }).expect(401);
      const bad = await waitFor({ action: 'auth.login_failed', actorId: memberId });
      expect(bad?.details).toBe('reason=bad_password');

      await request(app).post('/auth/login').send({ email: 'ghost@example.com', password: 'wrong-password-1' }).expect(401);
      const ghost = await waitFor({ action: 'auth.login_failed', actorId: null });
      expect(ghost?.details).toContain(`emailHash=${hashEmailForAudit('ghost@example.com')}`);
      expect(JSON.stringify(ghost)).not.toContain('ghost@example.com');
    });

    it('keeps the error code on a failed login and logs it together', async () => {
      const res = await request(app).post('/auth/login').send({ email: 'audit-member@example.com', password: 'wrong-password-1' }).expect(401);
      expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(await waitFor({ action: 'auth.login_failed', actorId: memberId })).not.toBeNull();
    });

    it('logs the start of an account lockout exactly once', async () => {
      const email = 'audit-lock@example.com';
      for (let i = 0; i < 10; i++) {
        await request(app).post('/auth/login').send({ email, password: 'wrong-password-1' }).expect(401);
      }
      for (let i = 0; i < 3; i++) {
        const res = await request(app).post('/auth/login').send({ email, password: 'wrong-password-1' }).expect(429);
        expect(res.body.code).toBe('AUTH_ACCOUNT_LOCKED');
      }
      expect(await waitFor({ action: 'auth.login_locked' })).not.toBeNull();
      await new Promise((r) => setTimeout(r, 100));
      const locked = await prisma.auditLog.findMany({ where: { action: 'auth.login_locked' } });
      expect(locked).toHaveLength(1);
      expect(locked[0].details).toBe(`emailHash=${hashEmailForAudit(email)}`);
      expect(JSON.stringify(locked)).not.toContain(email);
    });

    it('collapses unknown-email failures to one record per emailHash per 15 minutes with a count', async () => {
      const email = 'nobody-here@example.com';
      for (let i = 0; i < 5; i++) {
        await request(app).post('/auth/login').send({ email, password: 'wrong-password-1' }).expect(401);
      }
      await new Promise((r) => setTimeout(r, 100));
      const rows = await prisma.auditLog.findMany({ where: { action: 'auth.login_failed' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].details).toContain('count=1');
      // 15분이 지나면 그 사이 시도(4건 + 이번 1건)가 합쳐져 다음 기록의 count가 된다
      expect(throttleUnknownLogin(hashEmailForAudit(email), Date.now() + 16 * 60 * 1000)).toBe(5);
      // 존재하는 사용자의 실패는 그대로 매번 기록된다
      for (let i = 0; i < 3; i++) {
        await request(app).post('/auth/login').send({ email: 'audit-member@example.com', password: 'wrong-password-1' }).expect(401);
      }
      await new Promise((r) => setTimeout(r, 100));
      expect(await prisma.auditLog.count({ where: { action: 'auth.login_failed', actorId: memberId } })).toBe(3);
    });

    it('targets the user when a known account gets locked', async () => {
      const reg = await request(app).post('/auth/register').send({ email: 'audit-lock2@example.com', password: TEST_PASSWORD, name: 'Lock Two' });
      for (let i = 0; i < 10; i++) {
        await request(app).post('/auth/login').send({ email: 'audit-lock2@example.com', password: 'wrong-password-1' }).expect(401);
      }
      const row = await waitFor({ action: 'auth.login_locked' });
      expect(row).toMatchObject({ actorId: null, targetType: 'user', targetId: reg.body.user.id });
    });

    it('keeps log rows when the actor is deleted (actorId becomes null)', async () => {
      await prisma.auditLog.create({ data: { action: 'channel.edited', actorId: memberId, targetType: 'channel', targetId: 1 } });
      await prisma.channelMember.deleteMany({ where: { userId: memberId } }); // 채널 멤버십은 사용자 삭제 전에 정리해야 한다
      await prisma.user.delete({ where: { id: memberId } });
      const rows = await prisma.auditLog.findMany({ where: { action: 'channel.edited' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBeNull();
      const list = await request(app).get('/admin/audit-logs?action=channel.edited').set(auth(adminToken)).expect(200);
      expect(list.body.items[0].actor).toBeNull();
    });

    it('records member add/remove through the regular channel routes', async () => {
      const ch = await request(app).post('/channels').set(auth(adminToken)).send({ name: 'member-room' }).expect(201);
      await request(app).post(`/channels/${ch.body.id}/members`).set(auth(adminToken)).send({ userId: memberId }).expect(200);
      const added = await waitFor({ action: 'channel.member_added', targetId: ch.body.id });
      expect(added?.actorId).toBe(adminId);
      await request(app).delete(`/channels/${ch.body.id}/members/${memberId}`).set(auth(adminToken)).expect(200);
      expect(await waitFor({ action: 'channel.member_removed', targetId: ch.body.id })).not.toBeNull();
    });

    it('records logout, password change and forced logout', async () => {
      await request(app).post('/auth/logout').set(auth(memberToken)).expect(200);
      expect(await waitFor({ action: 'auth.logout', actorId: memberId })).not.toBeNull();

      await request(app).post('/admin/users/' + memberId + '/force-logout').set(auth(adminToken)).expect(200);
      const forced = await waitFor({ action: 'user.force_logout', actorId: adminId });
      expect(forced?.targetId).toBe(memberId);
      // 세션이 끊겼으니 이전 토큰은 거절된다
      await request(app).get('/users/me').set(auth(memberToken)).expect(401);

      const relog = await request(app).post('/auth/login').send({ email: 'audit-member@example.com', password: TEST_PASSWORD });
      await request(app)
        .post('/auth/change-password')
        .set(auth(relog.body.token))
        .send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD })
        .expect(200);
      expect(await waitFor({ action: 'auth.password_changed', actorId: memberId })).not.toBeNull();
    });

    it('records role, activation, channel, invite, webhook and token lifecycle', async () => {
      await request(app).patch(`/admin/users/${memberId}`).set(auth(adminToken)).send({ role: 'GUEST' }).expect(200);
      expect(await waitFor({ action: 'user.role_changed', targetId: memberId })).not.toBeNull();
      await request(app).post(`/admin/users/${memberId}/deactivate`).set(auth(adminToken)).expect(200);
      expect(await waitFor({ action: 'user.deactivated', targetId: memberId })).not.toBeNull();
      await request(app).post(`/admin/users/${memberId}/reactivate`).set(auth(adminToken)).expect(200);
      expect(await waitFor({ action: 'user.reactivated', targetId: memberId })).not.toBeNull();

      const ch = await request(app).post('/channels').set(auth(adminToken)).send({ name: 'audit-room' }).expect(201);
      expect(await waitFor({ action: 'channel.created', targetId: ch.body.id })).toMatchObject({ targetName: 'audit-room', details: 'public' });
      await request(app).patch(`/channels/${ch.body.id}`).set(auth(adminToken)).send({ name: 'audit-room-2' }).expect(200);
      expect(await waitFor({ action: 'channel.edited', targetId: ch.body.id })).not.toBeNull();
      await request(app).post(`/admin/channels/${ch.body.id}/archive`).set(auth(adminToken)).expect(200);
      expect(await waitFor({ action: 'channel.archived', targetId: ch.body.id })).not.toBeNull();
      await request(app).delete(`/admin/channels/${ch.body.id}`).set(auth(adminToken)).expect(200);
      expect(await waitFor({ action: 'channel.deleted', targetId: ch.body.id })).not.toBeNull();

      const inv = await request(app).post('/admin/invites').set(auth(adminToken)).send({ role: 'MEMBER' }).expect(201);
      expect(await waitFor({ action: 'invite.created' })).not.toBeNull();
      await request(app).delete(`/admin/invites/${inv.body.id}`).set(auth(adminToken)).expect(200);
      expect(await waitFor({ action: 'invite.deleted' })).not.toBeNull();

      const ch2 = await request(app).post('/channels').set(auth(adminToken)).send({ name: 'hook-room' }).expect(201);
      const hook = await request(app).post('/webhooks').set(auth(adminToken)).send({ name: 'hook', channelId: ch2.body.id }).expect(201);
      expect(await waitFor({ action: 'webhook.created' })).not.toBeNull();
      await request(app).delete(`/webhooks/${hook.body.id}`).set(auth(adminToken)).expect(200);
      expect(await waitFor({ action: 'webhook.deleted' })).not.toBeNull();

      const tok = await request(app).post('/tokens').set(auth(adminToken)).send({ name: 'ci' }).expect(201);
      expect(await waitFor({ action: 'token.create' })).not.toBeNull();
      await request(app).delete(`/tokens/${tok.body.id}`).set(auth(adminToken)).expect(200);
      expect(await waitFor({ action: 'token.revoke' })).not.toBeNull();
    });

    it('never stores passwords, tokens or message bodies', async () => {
      await request(app).post('/auth/login').send({ email: 'audit-member@example.com', password: 'wrong-password-1' });
      await request(app).post('/auth/login').send({ email: 'audit-member@example.com', password: TEST_PASSWORD });
      const tok = await request(app).post('/tokens').set(auth(adminToken)).send({ name: 'ci' }).expect(201);
      await request(app).post('/auth/change-password').set(auth(memberToken)).send({ currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      await exportFile('format=json', { format: 'json' });
      await waitFor({ action: 'auth.password_changed' });

      const dump = JSON.stringify(await prisma.auditLog.findMany());
      for (const secret of [TEST_PASSWORD, NEW_PASSWORD, 'wrong-password-1', tok.body.token, adminToken, 'audit-member@example.com']) {
        expect(dump).not.toContain(secret);
      }
    });
  });

  describe('GET /admin/audit-logs', () => {
    beforeEach(async () => {
      const rows = [];
      for (let i = 1; i <= 12; i++) {
        rows.push({
          action: i % 3 === 0 ? 'channel.deleted' : i % 3 === 1 ? 'user.role_changed' : 'channel.edited',
          actorId: i <= 6 ? adminId : memberId,
          targetType: i % 3 === 1 ? 'user' : 'channel',
          targetId: i,
          createdAt: new Date(Date.UTC(2026, 0, i, 12)),
        });
      }
      await prisma.auditLog.createMany({ data: rows });
    });

    it('paginates newest first with a cursor and no overlap', async () => {
      const p1 = await request(app).get('/admin/audit-logs?limit=5').set(auth(adminToken)).expect(200);
      expect(p1.body.items).toHaveLength(5);
      expect(p1.body.items[0].targetId).toBe(12);
      const p2 = await request(app).get(`/admin/audit-logs?limit=5&cursor=${p1.body.nextCursor}`).set(auth(adminToken)).expect(200);
      const p3 = await request(app).get(`/admin/audit-logs?limit=5&cursor=${p2.body.nextCursor}`).set(auth(adminToken)).expect(200);
      expect(p3.body.items).toHaveLength(2);
      expect(p3.body.nextCursor).toBeNull();
      const ids = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((r: { id: number }) => r.id);
      expect(new Set(ids).size).toBe(12);
      expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    });

    it('filters by action (repeated and comma forms), actor, target and UTC range', async () => {
      const multi = await request(app).get('/admin/audit-logs?action=channel.deleted&action=channel.edited&limit=100').set(auth(adminToken)).expect(200);
      expect(multi.body.items).toHaveLength(8);
      const comma = await request(app).get('/admin/audit-logs?action=channel.deleted,channel.edited&limit=100').set(auth(adminToken)).expect(200);
      expect(comma.body.items).toHaveLength(8);

      const actor = await request(app).get(`/admin/audit-logs?actorId=${memberId}&limit=100`).set(auth(adminToken)).expect(200);
      expect(actor.body.items).toHaveLength(6);

      const target = await request(app).get('/admin/audit-logs?targetType=channel&targetId=5').set(auth(adminToken)).expect(200);
      expect(target.body.items.map((r: { targetId: number }) => r.targetId)).toEqual([5]);

      // 날짜만 쓰면 UTC 자정, 시간대 표기가 없는 날짜시간도 UTC
      const range = await request(app).get('/admin/audit-logs?from=2026-01-03&to=2026-01-05T12:00:00Z&limit=100').set(auth(adminToken)).expect(200);
      expect(range.body.items.map((r: { targetId: number }) => r.targetId)).toEqual([5, 4, 3]);
      const naive = await request(app).get('/admin/audit-logs?from=2026-01-03T12:00:00&to=2026-01-03T12:00:00').set(auth(adminToken)).expect(200);
      expect(naive.body.items).toHaveLength(1);

      // to에 날짜만 주면 그 날 전체(다음 날 00:00 미만)를 포함한다
      const dayEnd = await request(app).get('/admin/audit-logs?from=2026-01-03&to=2026-01-05&limit=100').set(auth(adminToken)).expect(200);
      expect(dayEnd.body.items.map((r: { targetId: number }) => r.targetId)).toEqual([5, 4, 3]);
      const dayCut = await request(app).get('/admin/audit-logs?to=2026-01-05T11:59:59Z&limit=100').set(auth(adminToken)).expect(200);
      expect(dayCut.body.items[0].targetId).toBe(4);

      await request(app).get('/admin/audit-logs?from=not-a-date').set(auth(adminToken)).expect(400);
      await request(app).get('/admin/audit-logs?actorId=abc').set(auth(adminToken)).expect(400);
    });

    it('rejects non-admins and anonymous callers', async () => {
      await request(app).get('/admin/audit-logs').set(auth(memberToken)).expect(403);
      await request(app).post('/admin/audit-logs/export-token').set(auth(memberToken)).send({ format: 'csv' }).expect(403);
      await request(app).get('/admin/audit-logs/export?format=csv').expect(403);
      await request(app).get('/admin/audit-logs').expect(401);
      // 거절된 내보내기는 감사 기록을 남기지 않는다
      expect(await prisma.auditLog.count({ where: { action: 'audit.exported' } })).toBe(0);
    });
  });

  describe('GET /admin/audit-logs/export', () => {
    it('streams CSV with formula-injection escaping and records audit.exported', async () => {
      await prisma.auditLog.create({
        data: { action: 'channel.edited', actorId: adminId, targetType: 'channel', targetId: 1, targetName: '=HYPERLINK("x")', details: '+1,"quoted"\nline' },
      });
      const res = await exportFile('format=csv&action=channel.edited', { format: 'csv', action: ['channel.edited'] });
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      const text = res.text;
      expect(text).toContain('id,createdAt,action');
      expect(text).toContain(`"'=HYPERLINK(""x"")"`);
      expect(text).toContain(`"'+1,""quoted""\nline"`);
      expect(text).not.toMatch(/,=HYPERLINK/);

      const rec = await prisma.auditLog.findFirst({ where: { action: 'audit.exported' } });
      expect(rec?.actorId).toBe(adminId);
      expect(rec?.details).toContain('format=csv');
      expect(rec?.details).toContain('channel.edited');
    });

    it('streams a valid JSON array with the same filters', async () => {
      await prisma.auditLog.createMany({
        data: [
          { action: 'a.one', actorId: adminId, targetType: 't' },
          { action: 'a.two', actorId: adminId, targetType: 't' },
        ],
      });
      const res = await exportFile('format=json&action=a.one', { format: 'json', action: ['a.one'] });
      const parsed = JSON.parse(res.text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ action: 'a.one', actorName: 'Audit Admin' });
      const all = JSON.parse((await exportFile('format=json', { format: 'json' })).text);
      expect(all.length).toBeGreaterThanOrEqual(2);
      await request(app).post('/admin/audit-logs/export-token').set(auth(adminToken)).send({ format: 'xml' }).expect(400);
    });

    it('issues a single-use token bound to the filter', async () => {
      const issue = (body: Record<string, unknown>) => request(app).post('/admin/audit-logs/export-token').set(auth(adminToken)).send(body).expect(201);
      // 사용 후 재사용 거부
      const t1 = (await issue({ format: 'csv', action: ['a.one'] })).body.token;
      await request(app).get(`/admin/audit-logs/export?format=csv&action=a.one&token=${t1}`).expect(200);
      await request(app).get(`/admin/audit-logs/export?format=csv&action=a.one&token=${t1}`).expect(403);
      // 필터를 바꾸면 거부되고 토큰도 소진된다
      const t2 = (await issue({ format: 'csv', action: ['a.one'] })).body.token;
      await request(app).get(`/admin/audit-logs/export?format=csv&action=a.two&token=${t2}`).expect(403);
      await request(app).get(`/admin/audit-logs/export?format=csv&action=a.one&token=${t2}`).expect(403);
      // 형식이 다르면 거부
      const t3 = (await issue({ format: 'csv' })).body.token;
      await request(app).get(`/admin/audit-logs/export?format=json&token=${t3}`).expect(403);
      // 토큰 없음, 엉터리 토큰
      await request(app).get('/admin/audit-logs/export?format=csv').expect(403);
      await request(app).get('/admin/audit-logs/export?format=csv&token=nope').expect(403);
      // 감사 로그에 토큰이 남지 않는다
      expect(JSON.stringify(await prisma.auditLog.findMany())).not.toMatch(new RegExp(`${t1}|${t2}|${t3}`));
    });

    it('rejects expired tokens and tokens whose owner lost admin rights', async () => {
      const now = Date.now();
      const { token } = issueExportToken(adminId, 'b', now)!;
      expect(consumeExportToken(token, 'b', now + EXPORT_TOKEN_TTL_MS + 1)).toBeNull();
      expect(consumeExportToken(token, 'b', now)).toBeNull(); // 이미 소진
      const ok = issueExportToken(adminId, 'b', now)!;
      expect(consumeExportToken(ok.token, 'b', now + EXPORT_TOKEN_TTL_MS - 1)).toBe(adminId);

      const t = await request(app).post('/admin/audit-logs/export-token').set(auth(adminToken)).send({ format: 'csv' }).expect(201);
      await prisma.user.update({ where: { id: adminId }, data: { role: 'MEMBER' } });
      await request(app).get(`/admin/audit-logs/export?format=csv&token=${t.body.token}`).expect(403);
    });

    it('stops writing and reading when the client disconnects', async () => {
      // 버퍼가 찬 상태에서 close가 오면 drain을 영원히 기다리지 않는다
      const fake = Object.assign(new EventEmitter(), { destroyed: false, write: () => false }) as unknown as Parameters<typeof writeWithBackpressure>[0];
      const pending = writeWithBackpressure(fake, 'x');
      (fake as unknown as EventEmitter).emit('close');
      (fake as { destroyed: boolean }).destroyed = true;
      expect(await pending).toBe(false);
      expect((fake as unknown as EventEmitter).listenerCount('drain')).toBe(0);
      // drain이 오면 계속 쓴다
      const open = Object.assign(new EventEmitter(), { destroyed: false, write: () => false }) as unknown as Parameters<typeof writeWithBackpressure>[0];
      const p2 = writeWithBackpressure(open, 'x');
      (open as unknown as EventEmitter).emit('drain');
      expect(await p2).toBe(true);

      // 소비자가 멈추면 generator는 더 읽지 않는다(배치 1회)
      await prisma.auditLog.createMany({ data: Array.from({ length: 2500 }, () => ({ action: 'bulk', actorId: adminId, targetType: 't' })) });
      const spy = jest.spyOn(prisma.auditLog, 'findMany');
      try {
        for await (const row of iterateAuditRows({ action: ['bulk'] })) {
          expect(row.action).toBe('bulk');
          break;
        }
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('escapes every formula trigger character', () => {
      for (const v of ['=1+1', '+1', '-1', '@sum', '\tx', '\rx']) {
        expect(csvCell(v).replace(/^"/, '')).toMatch(/^'/);
      }
      expect(csvCell('plain')).toBe('plain');
      expect(csvCell(null)).toBe('');
    });

    it('caps the number of exported rows', () => {
      expect(EXPORT_MAX_ROWS).toBe(100_000);
    });
  });

  describe('retention', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('deletes only rows older than the cutoff, in batches', async () => {
      const now = new Date('2026-06-01T00:00:00Z');
      const old = new Date(now.getTime() - 31 * DAY);
      const edge = new Date(now.getTime() - 29 * DAY);
      await prisma.auditLog.createMany({
        data: [
          ...Array.from({ length: 1500 }, () => ({ action: 'old', actorId: adminId, targetType: 't', createdAt: old })),
          { action: 'recent', actorId: adminId, targetType: 't', createdAt: edge },
          { action: 'now', actorId: adminId, targetType: 't', createdAt: now },
        ],
      });
      expect(await purgeOldAuditLogs(30, now)).toBe(1500);
      const left = await prisma.auditLog.findMany({ select: { action: true } });
      expect(left.map((r) => r.action).sort()).toEqual(['now', 'recent']);
    });

    it('keeps everything when retention is unset or zero', async () => {
      await prisma.auditLog.create({ data: { action: 'ancient', actorId: adminId, targetType: 't', createdAt: new Date('2000-01-01') } });
      expect(await purgeOldAuditLogs(0)).toBe(0);
      delete process.env.AUDIT_LOG_RETENTION_DAYS;
      expect(await purgeAuditLogsIfDue(Date.now() + 10 * DAY)).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: 'ancient' } })).toBe(1);
    });

    it('retries a failed scheduler purge after one hour, not on the next tick', async () => {
      process.env.AUDIT_LOG_RETENTION_DAYS = '30';
      const spy = jest.spyOn(prisma.auditLog, 'findMany').mockRejectedValueOnce(new Error('db down'));
      try {
        const t = Date.now() + 300 * DAY;
        await expect(purgeAuditLogsIfDue(t)).rejects.toThrow('db down');
        expect(await purgeAuditLogsIfDue(t + 60_000)).toBe(0); // 백오프 중이라 건너뜀
        expect(spy).toHaveBeenCalledTimes(1);
        await prisma.auditLog.create({ data: { action: 'ancient', actorId: adminId, targetType: 't', createdAt: new Date('2000-01-01') } });
        expect(await purgeAuditLogsIfDue(t + 60 * 60 * 1000 + 1)).toBe(1); // 1시간 뒤 재시도 성공
      } finally {
        spy.mockRestore();
        delete process.env.AUDIT_LOG_RETENTION_DAYS;
      }
    });

    it('scheduler purge runs at most once a day', async () => {
      process.env.AUDIT_LOG_RETENTION_DAYS = '30';
      try {
        await prisma.auditLog.create({ data: { action: 'ancient', actorId: adminId, targetType: 't', createdAt: new Date('2000-01-01') } });
        const t0 = Date.now() + 400 * DAY; // 이전 테스트가 잡은 마지막 실행 시각보다 뒤
        expect(await purgeAuditLogsIfDue(t0)).toBe(1);
        await prisma.auditLog.create({ data: { action: 'ancient2', actorId: adminId, targetType: 't', createdAt: new Date('2000-01-01') } });
        expect(await purgeAuditLogsIfDue(t0 + 60_000)).toBe(0); // 같은 날: 건너뜀
        expect(await purgeAuditLogsIfDue(t0 + DAY + 1)).toBe(1);
      } finally {
        delete process.env.AUDIT_LOG_RETENTION_DAYS;
      }
    });
  });
});
