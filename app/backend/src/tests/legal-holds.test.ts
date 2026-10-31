import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { purgeExpiredMessages } from '../services/retentionService.js';

// 법적 보존(E6): 보존 건 CRUD, User.legalHold 동기화, 데이터 보존 정리와의 연동, 권한
describe('Legal holds', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let adminToken: string;
  let adminId: number;
  let memberToken: string;
  let memberId: number;
  let aliceId: number;
  let bobId: number;

  async function reset() {
    await prisma.legalHold.deleteMany();
    await prisma.workspaceSetting.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.activity.deleteMany();
    await prisma.bookmark.deleteMany();
    await prisma.reaction.deleteMany();
    await prisma.dMReaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.directMessage.deleteMany();
    await prisma.dMGroup.deleteMany();
    await prisma.user.deleteMany();
  }

  async function register(email: string, name: string) {
    const r = await request(app).post('/auth/register').send({ email, password: TEST_PASSWORD, name });
    return { id: r.body.user.id as number, token: r.body.token as string };
  }

  beforeEach(async () => {
    await reset();
    adminId = (await register('lh-admin@example.com', 'LH Admin')).id;
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });
    adminToken = (await request(app).post('/auth/login').send({ email: 'lh-admin@example.com', password: TEST_PASSWORD })).body.token;
    const m = await register('lh-member@example.com', 'LH Member');
    memberId = m.id;
    memberToken = m.token;
    aliceId = (await register('lh-alice@example.com', 'LH Alice')).id;
    bobId = (await register('lh-bob@example.com', 'LH Bob')).id;
    await prisma.auditLog.deleteMany();
  });
  afterAll(async () => {
    await reset();
  });

  const flag = async (id: number) => (await prisma.user.findUniqueOrThrow({ where: { id } })).legalHold;
  const create = (body: Record<string, unknown>) => request(app).post('/admin/legal-holds').set(auth(adminToken)).send(body);

  it('creates, reads, updates, adds and removes custodians, releases, and logs every step', async () => {
    // Create
    const created = await create({ name: 'Case A', description: 'Litigation 2026', userIds: [aliceId] }).expect(201);
    const id = created.body.id as number;
    expect(created.body).toMatchObject({ name: 'Case A', description: 'Litigation 2026', releasedAt: null, custodianCount: 1, creator: { id: adminId } });
    expect(created.body.custodians.map((c: { id: number }) => c.id)).toEqual([aliceId]);
    expect(await flag(aliceId)).toBe(true);

    // Read: list and detail
    const list = await request(app).get('/admin/legal-holds').set(auth(adminToken)).expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id, custodianCount: 1 });
    expect(list.body.nextCursor).toBeNull();
    await request(app).get(`/admin/legal-holds/${id}`).set(auth(adminToken)).expect(200);

    // Update
    const patched = await request(app).patch(`/admin/legal-holds/${id}`).set(auth(adminToken)).send({ name: 'Case A (renamed)', description: '' }).expect(200);
    expect(patched.body).toMatchObject({ name: 'Case A (renamed)', description: null });

    // Add custodians (alice again is skipped)
    const added = await request(app).post(`/admin/legal-holds/${id}/custodians`).set(auth(adminToken)).send({ userIds: [aliceId, bobId] }).expect(200);
    expect(added.body.custodians.map((c: { id: number }) => c.id).sort()).toEqual([aliceId, bobId].sort());
    expect(await flag(bobId)).toBe(true);

    // Remove one custodian
    const removed = await request(app).delete(`/admin/legal-holds/${id}/custodians/${bobId}`).set(auth(adminToken)).expect(200);
    expect(removed.body.custodianCount).toBe(1);
    expect(await flag(bobId)).toBe(false);
    await request(app).delete(`/admin/legal-holds/${id}/custodians/${bobId}`).set(auth(adminToken)).expect(404);

    // Release ("delete"): the record stays, the flag goes, further changes are refused
    const released = await request(app).post(`/admin/legal-holds/${id}/release`).set(auth(adminToken)).expect(200);
    expect(released.body.releasedAt).not.toBeNull();
    expect(released.body.releaser).toMatchObject({ id: adminId });
    expect(released.body.custodians).toHaveLength(1);
    expect(await flag(aliceId)).toBe(false);
    for (const r of [
      request(app).post(`/admin/legal-holds/${id}/release`).set(auth(adminToken)),
      request(app).patch(`/admin/legal-holds/${id}`).set(auth(adminToken)).send({ name: 'x' }),
      request(app).post(`/admin/legal-holds/${id}/custodians`).set(auth(adminToken)).send({ userIds: [bobId] }),
      request(app).delete(`/admin/legal-holds/${id}/custodians/${aliceId}`).set(auth(adminToken)),
    ]) {
      const res = await r.expect(409);
      expect(res.body.code).toBe('LEGAL_HOLD_RELEASED');
    }

    // Read after release: active list is empty, released list has it
    expect((await request(app).get('/admin/legal-holds').set(auth(adminToken)).expect(200)).body.items).toHaveLength(0);
    expect((await request(app).get('/admin/legal-holds?status=released').set(auth(adminToken)).expect(200)).body.items).toHaveLength(1);
    expect((await request(app).get('/admin/legal-holds?status=all').set(auth(adminToken)).expect(200)).body.items).toHaveLength(1);

    const logs = await prisma.auditLog.findMany({ orderBy: { id: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual([
      'legal_hold.created',
      'legal_hold.custodian_added',
      'legal_hold.updated',
      'legal_hold.custodian_added',
      'legal_hold.custodian_removed',
      'legal_hold.released',
    ]);
    expect(logs[0]).toMatchObject({ actorId: adminId, targetType: 'legal_hold', targetId: id, targetName: 'Case A', details: 'custodians=1' });
    expect(logs[1]).toMatchObject({ targetType: 'user', targetId: aliceId, details: `holdId=${id}` });
    expect(logs[2].details).toBe('changed=name,description');
    expect(logs[3]).toMatchObject({ targetId: bobId });
    expect(logs[4]).toMatchObject({ targetId: bobId, details: `holdId=${id}; stillHeld=false` });
    expect(logs[5].details).toBe('custodians=1; freed=1');
  });

  it('keeps a user held while any active hold still names them', async () => {
    const a = (await create({ name: 'A', userIds: [aliceId] }).expect(201)).body.id;
    const b = (await create({ name: 'B', userIds: [aliceId, bobId] }).expect(201)).body.id;

    await request(app).post(`/admin/legal-holds/${a}/release`).set(auth(adminToken)).expect(200);
    expect(await flag(aliceId)).toBe(true); // B still holds alice
    const log = await prisma.auditLog.findFirst({ where: { action: 'legal_hold.released' } });
    expect(log?.details).toBe('custodians=1; freed=0');

    const r = await request(app).delete(`/admin/legal-holds/${b}/custodians/${aliceId}`).set(auth(adminToken)).expect(200);
    expect(r.body.custodianCount).toBe(1);
    expect(await flag(aliceId)).toBe(false);
    expect(await flag(bobId)).toBe(true);
  });

  it('stays consistent when changes to the same user race', async () => {
    const a = (await create({ name: 'A', userIds: [aliceId] }).expect(201)).body.id;
    const b = (await create({ name: 'B', userIds: [aliceId] }).expect(201)).body.id;
    await Promise.all([
      request(app).post(`/admin/legal-holds/${a}/release`).set(auth(adminToken)).expect(200),
      request(app).delete(`/admin/legal-holds/${b}/custodians/${aliceId}`).set(auth(adminToken)).expect(200),
    ]);
    expect(await flag(aliceId)).toBe(false);
  });

  it('keeps custodian data through retention cleanup, and lets it go after removal and release', async () => {
    await prisma.workspaceSetting.create({ data: { id: 1, messageRetentionDays: 30 } });
    const ch = await prisma.channel.create({ data: { name: 'lh-ret', createdBy: adminId } });
    await prisma.channelMember.createMany({ data: [aliceId, memberId].map((userId) => ({ userId, channelId: ch.id })) });
    const msg = await prisma.message.create({ data: { content: 'old alice', userId: aliceId, channelId: ch.id, createdAt: ago(100) } });
    const other = await prisma.message.create({ data: { content: 'old member', userId: memberId, channelId: ch.id, createdAt: ago(100) } });
    const dm = await prisma.directMessage.create({ data: { content: 'old dm', fromUserId: memberId, toUserId: aliceId, createdAt: ago(100) } });
    const unrelated = await prisma.directMessage.create({ data: { content: 'unrelated', fromUserId: memberId, toUserId: bobId, createdAt: ago(100) } });

    const hold = (await create({ name: 'Retention case', userIds: [aliceId] }).expect(201)).body.id;
    await purgeExpiredMessages();
    expect(await prisma.message.findUnique({ where: { id: msg.id } })).not.toBeNull();
    expect(await prisma.message.findUnique({ where: { id: other.id } })).not.toBeNull(); // 보존 대상이 멤버인 채널은 통째로 제외
    expect(await prisma.directMessage.findUnique({ where: { id: dm.id } })).not.toBeNull();
    expect(await prisma.directMessage.findUnique({ where: { id: unrelated.id } })).toBeNull();

    // 대상에서 빼면 다음 정리에서 지워진다
    await request(app).delete(`/admin/legal-holds/${hold}/custodians/${aliceId}`).set(auth(adminToken)).expect(200);
    await purgeExpiredMessages();
    expect(await prisma.message.findUnique({ where: { id: msg.id } })).toBeNull();
    expect(await prisma.directMessage.findUnique({ where: { id: dm.id } })).toBeNull();

    // 해제 경로도 같다
    const m2 = await prisma.message.create({ data: { content: 'old alice 2', userId: aliceId, channelId: ch.id, createdAt: ago(100) } });
    const hold2 = (await create({ name: 'Second case', userIds: [aliceId] }).expect(201)).body.id;
    await purgeExpiredMessages();
    expect(await prisma.message.findUnique({ where: { id: m2.id } })).not.toBeNull();
    await request(app).post(`/admin/legal-holds/${hold2}/release`).set(auth(adminToken)).expect(200);
    await purgeExpiredMessages();
    expect(await prisma.message.findUnique({ where: { id: m2.id } })).toBeNull();
  });

  it('retention reads the active hold relation itself, not only the cached flag', async () => {
    await prisma.workspaceSetting.create({ data: { id: 1, messageRetentionDays: 30 } });
    const ch = await prisma.channel.create({ data: { name: 'lh-rel', createdBy: adminId } });
    const msg = await prisma.message.create({ data: { content: 'old alice', userId: aliceId, channelId: ch.id, createdAt: ago(100) } });
    const dm = await prisma.directMessage.create({ data: { content: 'old dm', fromUserId: memberId, toUserId: aliceId, createdAt: ago(100) } });
    const filename = `lh-rel-${Date.now()}.txt`;
    const file = await prisma.file.create({ data: { filename, originalName: 'f.txt', mimetype: 'text/plain', size: 1, url: '/files/x', userId: aliceId, createdAt: ago(100) } });

    // 캐시가 어긋난 상태: 활성 보존 관계는 있는데 플래그는 꺼져 있다
    const hold = await prisma.legalHold.create({ data: { name: 'raw', custodians: { create: { userId: aliceId } } } });
    expect(await flag(aliceId)).toBe(false);
    await purgeExpiredMessages();
    expect(await prisma.message.findUnique({ where: { id: msg.id } })).not.toBeNull();
    expect(await prisma.directMessage.findUnique({ where: { id: dm.id } })).not.toBeNull();
    expect(await prisma.file.findUnique({ where: { id: file.id } })).not.toBeNull();

    // 해제된 보존 건의 관계는 보존하지 않는다
    await prisma.legalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date() } });
    await purgeExpiredMessages();
    expect(await prisma.message.findUnique({ where: { id: msg.id } })).toBeNull();
    expect(await prisma.directMessage.findUnique({ where: { id: dm.id } })).toBeNull();
  });

  it('does not delete data whose owner is put on hold after the purge selected it', async () => {
    await prisma.workspaceSetting.create({ data: { id: 1, messageRetentionDays: 30 } });
    const ch = await prisma.channel.create({ data: { name: 'lh-race', createdBy: adminId } });
    const leaf = await prisma.message.create({ data: { content: 'leaf', userId: aliceId, channelId: ch.id, createdAt: ago(100) } });
    const parent = await prisma.message.create({ data: { content: 'parent', userId: aliceId, channelId: ch.id, createdAt: ago(100) } });
    await prisma.message.create({ data: { content: 'fresh reply', userId: memberId, channelId: ch.id, threadId: parent.id } });
    await prisma.reaction.create({ data: { emoji: 'ok', userId: memberId, messageId: parent.id } });
    const dm = await prisma.directMessage.create({ data: { content: 'dm', fromUserId: aliceId, toUserId: bobId, createdAt: ago(100) } });
    const free = await prisma.directMessage.create({ data: { content: 'free', fromUserId: memberId, toUserId: bobId, createdAt: ago(100) } });

    // 정리가 배치를 고른 직후에 보존을 건다(관계만 생기고 플래그 동기화 전인 순간까지 포함)
    let placed = false;
    await purgeExpiredMessages(new Date(), {
      afterSelect: async () => {
        if (placed) return;
        placed = true;
        await prisma.legalHold.create({ data: { name: 'late', custodians: { create: { userId: aliceId } } } });
      },
    });
    expect(placed).toBe(true);
    expect(await prisma.message.findUnique({ where: { id: leaf.id } })).not.toBeNull();
    const p = await prisma.message.findUniqueOrThrow({ where: { id: parent.id } });
    expect(p).toMatchObject({ content: 'parent', deletedAt: null });
    expect(await prisma.reaction.count({ where: { messageId: parent.id } })).toBe(1);
    expect(await prisma.directMessage.findUnique({ where: { id: dm.id } })).not.toBeNull();
    expect(await prisma.directMessage.findUnique({ where: { id: free.id } })).toBeNull();

    // DM 배치도 같다: 고른 뒤에 bob에게 보존이 걸리면 bob의 DM은 남는다
    const dm2 = await prisma.directMessage.create({ data: { content: 'dm2', fromUserId: bobId, toUserId: memberId, createdAt: ago(100) } });
    let calls = 0;
    await purgeExpiredMessages(new Date(), {
      afterSelect: async () => {
        if (calls++ === 0) await prisma.legalHold.create({ data: { name: 'late bob', custodians: { create: { userId: bobId } } } });
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(await prisma.directMessage.findUnique({ where: { id: dm2.id } })).not.toBeNull();
  });

  it('validates input and reports unknown holds and users', async () => {
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'ok', userIds: 'nope' }, { name: 'ok', extra: 1 }, { name: 'ok', description: 'd'.repeat(1001) }]) {
      await create(body).expect(400);
    }
    const unknown = await create({ name: 'ok', userIds: [999999] }).expect(400);
    expect(unknown.body.code).toBe('LEGAL_HOLD_INVALID_USERS');
    expect(await prisma.legalHold.count()).toBe(0);

    const id = (await create({ name: 'ok' }).expect(201)).body.id;
    await request(app).patch(`/admin/legal-holds/${id}`).set(auth(adminToken)).send({}).expect(400);
    await request(app).post(`/admin/legal-holds/${id}/custodians`).set(auth(adminToken)).send({ userIds: [] }).expect(400);
    const badUser = await request(app).post(`/admin/legal-holds/${id}/custodians`).set(auth(adminToken)).send({ userIds: [aliceId, 999999] }).expect(400);
    expect(badUser.body.code).toBe('LEGAL_HOLD_INVALID_USERS');
    expect(await flag(aliceId)).toBe(false);

    const missing = await request(app).get('/admin/legal-holds/999999').set(auth(adminToken)).expect(404);
    expect(missing.body.code).toBe('LEGAL_HOLD_NOT_FOUND');
    await request(app).post('/admin/legal-holds/999999/release').set(auth(adminToken)).expect(404);
    await request(app).get('/admin/legal-holds/abc').set(auth(adminToken)).expect(400);
    await request(app).get('/admin/legal-holds?status=bogus').set(auth(adminToken)).expect(400);
  });

  it('accepts deactivated users as custodians', async () => {
    await prisma.user.update({ where: { id: bobId }, data: { deactivatedAt: new Date() } });
    const r = await create({ name: 'Departed', userIds: [bobId] }).expect(201);
    expect(r.body.custodians[0]).toMatchObject({ id: bobId, deactivatedAt: expect.any(String) });
    expect(await flag(bobId)).toBe(true);
  });

  it('is admin-only', async () => {
    const id = (await create({ name: 'Secret', userIds: [aliceId] }).expect(201)).body.id;
    const m = auth(memberToken);
    const tries = [
      request(app).get('/admin/legal-holds').set(m),
      request(app).get(`/admin/legal-holds/${id}`).set(m),
      request(app).post('/admin/legal-holds').set(m).send({ name: 'x' }),
      request(app).patch(`/admin/legal-holds/${id}`).set(m).send({ name: 'x' }),
      request(app).post(`/admin/legal-holds/${id}/custodians`).set(m).send({ userIds: [memberId] }),
      request(app).delete(`/admin/legal-holds/${id}/custodians/${aliceId}`).set(m),
      request(app).post(`/admin/legal-holds/${id}/release`).set(m),
    ];
    for (const t of tries) expect((await t.expect(403)).body.code).toBe('ADMIN_REQUIRED');
    await request(app).get('/admin/legal-holds').expect(401);
    expect(await flag(aliceId)).toBe(true);
    expect(await prisma.legalHold.count()).toBe(1);
  });

  it('paginates the hold list newest first', async () => {
    for (let i = 0; i < 3; i++) await create({ name: `H${i}` }).expect(201);
    const p1 = await request(app).get('/admin/legal-holds?limit=2').set(auth(adminToken)).expect(200);
    expect(p1.body.items.map((h: { name: string }) => h.name)).toEqual(['H2', 'H1']);
    const p2 = await request(app).get(`/admin/legal-holds?limit=2&cursor=${p1.body.nextCursor}`).set(auth(adminToken)).expect(200);
    expect(p2.body.items.map((h: { name: string }) => h.name)).toEqual(['H0']);
    expect(p2.body.nextCursor).toBeNull();
  });
});
