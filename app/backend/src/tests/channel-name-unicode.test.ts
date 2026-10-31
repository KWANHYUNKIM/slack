import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { normalizeChannelName, validateChannelName } from '../utils/channelName.js';

describe('Channel names (unicode)', () => {
  let token: string;
  let adminToken: string;

  const create = (name: unknown) =>
    request(app).post('/channels').set('Authorization', `Bearer ${token}`).send({ name });
  const adminEdit = (id: number, name: string) =>
    request(app).patch(`/admin/channels/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ name });

  beforeEach(async () => {
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    const res = await request(app).post('/auth/register')
      .send({ email: 'cn-user@example.com', password: TEST_PASSWORD, name: 'CN User' });
    token = res.body.token;

    const adminRes = await request(app).post('/auth/register')
      .send({ email: 'cn-admin@example.com', password: TEST_PASSWORD, name: 'CN Admin' });
    await prisma.user.update({ where: { id: adminRes.body.user.id }, data: { role: 'ADMIN' } });
    const login = await request(app).post('/auth/login')
      .send({ email: 'cn-admin@example.com', password: TEST_PASSWORD });
    adminToken = login.body.token;
  });

  describe('normalize / validate (unit)', () => {
    it('trims, NFC-normalizes and lowercases without locale', () => {
      expect(normalizeChannelName('  Dev-Team ')).toBe('dev-team');
      expect(normalizeChannelName('가')).toBe('가'); // 가 (NFD -> NFC)
      // 터키어 로캘 영향 없음: I -> i
      expect(normalizeChannelName('INFO')).toBe('info');
    });

    it('counts length in code points', () => {
      expect(validateChannelName('\u{20BB7}'.repeat(25)).ok).toBe(true); // 𠮷 x25 (UTF-16 길이 50)
      expect(validateChannelName('\u{20BB7}'.repeat(26)).ok).toBe(false);
    });
  });

  describe('CRUD with unicode names', () => {
    const names = ['개발팀', '프로젝트_a', '日本語', 'قناة'];

    it.each(names)('creates, reads, searches, renames and deletes %s (repeated)', async (name) => {
      for (let round = 0; round < 2; round++) {
        // Create
        const created = await create(name);
        expect(created.status).toBe(201);
        expect(created.body.name).toBe(name);
        const id = created.body.id;

        // Read: list + detail
        const list = await request(app).get('/channels').set('Authorization', `Bearer ${token}`);
        expect(list.status).toBe(200);
        const items = Array.isArray(list.body) ? list.body : list.body.items;
        expect(items.map((c: { name: string }) => c.name)).toContain(name);

        // Read: search by channel name (via a message in the channel)
        const msg = await request(app).post(`/channels/${id}/messages`)
          .set('Authorization', `Bearer ${token}`).send({ content: 'hello' });
        expect(msg.status).toBe(201);
        const search = await request(app).get('/search').query({ q: name })
          .set('Authorization', `Bearer ${token}`);
        expect(search.status).toBe(200);
        expect(JSON.stringify(search.body)).toContain(name);

        // Update (admin rename)
        const renamed = await adminEdit(id, `${name}_2`);
        expect(renamed.status).toBe(200);
        expect(renamed.body.name).toBe(`${name}_2`);

        // Delete (permanent, admin) then read fails
        const del = await request(app).delete(`/admin/channels/${id}`)
          .set('Authorization', `Bearer ${adminToken}`);
        expect(del.status).toBeLessThan(300);
        const after = await request(app).get('/channels').set('Authorization', `Bearer ${token}`);
        const afterItems = Array.isArray(after.body) ? after.body : after.body.items;
        expect(afterItems.map((c: { name: string }) => c.name)).not.toContain(`${name}_2`);
      }
    });

    it('normalizes uppercase and surrounding spaces', async () => {
      const res = await create('  Project_A ');
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('project_a');
    });
  });

  describe('rejections', () => {
    const bad: [string, string][] = [
      ['bidi override U+202E', 'abc‮def'],
      ['bidi isolate U+2066', 'abc⁦def'],
      ['zero-width space U+200B', 'ab​cd'],
      ['zero-width joiner U+200D', 'ab‍cd'],
      ['emoji', 'party-\u{1F389}'],
      ['inner space', 'two words'],
      ['control char', 'ab\u0007cd'],
      ['leading hyphen', '-abc'],
      ['leading underscore', '_abc'],
      ['symbol', 'a#b'],
      ['empty', '   '],
    ];

    it.each(bad)('rejects %s on create with CHANNEL_NAME_INVALID', async (_label, name) => {
      const res = await create(name);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CHANNEL_NAME_INVALID');
      expect(typeof res.body.error).toBe('string');
    });

    it('rejects non-string name', async () => {
      const res = await create(123);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CHANNEL_NAME_INVALID');
    });

    it('rejects over 25 code points but accepts 25 Hangul syllables', async () => {
      expect((await create('가'.repeat(26))).status).toBe(400);
      expect((await create('가'.repeat(25))).status).toBe(201);
    });

    it('rejects the same name arriving as NFD as a duplicate', async () => {
      const nfc = '한글팀';
      expect((await create(nfc)).status).toBe(201);
      const dup = await create(nfc.normalize('NFD'));
      expect(dup.status).toBe(400);
      expect(dup.body.error).toMatch(/already exists/);
    });

    it('applies the same rules on admin rename', async () => {
      const created = await create('rename-me');
      const id = created.body.id;
      for (const name of ['abc‮def', 'ab​cd', 'x \u{1F389}', 'two words']) {
        const res = await adminEdit(id, name);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CHANNEL_NAME_INVALID');
      }
      const ok = await adminEdit(id, '개발팀');
      expect(ok.status).toBe(200);
      // NFD rename onto an existing name is a conflict
      await create('日本語');
      const dup = await adminEdit(id, '日本語');
      expect(dup.status).toBe(400);
    });
  });
});
