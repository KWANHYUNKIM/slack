import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { resetSearchMemo } from '../services/ediscoveryService.js';

// eDiscovery(E6): 보존 건 대상자 기준 검색·내보내기, 소프트 삭제·수정 표시, 감사 로그, 권한
describe('eDiscovery', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let adminToken: string;
  let adminId: number;
  let memberToken: string;
  let memberId: number;
  let aliceToken: string;
  let aliceId: number;
  let bobId: number;
  let bobToken: string;
  let holdId: number;

  async function reset() {
    await prisma.legalHold.deleteMany();
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

  const searchQ = (q: string) => request(app).get(`/admin/ediscovery/search?${q}`).set(auth(adminToken));
  const lines = (text: string) => text.trim().split('\n').map((l) => JSON.parse(l));

  async function exportFile(body: Record<string, unknown>, query: string) {
    const t = await request(app).post('/admin/ediscovery/export-token').set(auth(adminToken)).send(body).expect(201);
    return request(app)
      .get(`/admin/ediscovery/export?${query}&token=${t.body.token}`)
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => cb(null, data));
      })
      .expect(200);
  }

  beforeEach(async () => {
    resetSearchMemo();
    await reset();
    adminId = (await register('ed-admin@example.com', 'ED Admin')).id;
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });
    adminToken = (await request(app).post('/auth/login').send({ email: 'ed-admin@example.com', password: TEST_PASSWORD })).body.token;
    const m = await register('ed-member@example.com', 'ED Member');
    memberId = m.id;
    memberToken = m.token;
    const a = await register('ed-alice@example.com', 'ED Alice');
    aliceId = a.id;
    aliceToken = a.token;
    const b = await register('ed-bob@example.com', 'ED Bob');
    bobId = b.id;
    bobToken = b.token;
    holdId = (await request(app).post('/admin/legal-holds').set(auth(adminToken)).send({ name: 'Case', userIds: [aliceId] }).expect(201)).body.id;
    await prisma.auditLog.deleteMany();
  });
  afterAll(async () => {
    await reset();
  });

  /** 대상자 alice의 데이터와, 걸리면 안 되는 남의 데이터를 만든다 */
  async function seed() {
    // 비공개 채널: 관리자는 멤버가 아니다
    const priv = await prisma.channel.create({ data: { name: 'ed-private', isPrivate: true, createdBy: aliceId } });
    await prisma.channelMember.createMany({ data: [aliceId, memberId].map((userId) => ({ userId, channelId: priv.id })) });

    // 앱 API로 만들고 고치고 지운다(Create → Update → Delete)
    const sent = await request(app).post(`/channels/${priv.id}/messages`).set(auth(aliceToken)).send({ content: 'contract draft v1' }).expect(201);
    await request(app).patch(`/messages/${sent.body.id}`).set(auth(aliceToken)).send({ content: 'contract draft v2' }).expect(200);
    const gone = await request(app).post(`/channels/${priv.id}/messages`).set(auth(aliceToken)).send({ content: 'delete me secret' }).expect(201);
    // 첨부가 있는 메시지를 지우면 첨부는 분리되지만(messageId=null) 원래 메시지 id가 남는다
    const goneFile = await prisma.file.create({ data: { mimetype: 'application/pdf', size: 5, url: '/files/g', filename: 'g.pdf', originalName: 'secret.pdf', userId: aliceId, messageId: gone.body.id } });
    await request(app).delete(`/messages/${gone.body.id}`).set(auth(aliceToken)).expect(200);
    expect(await prisma.file.findUniqueOrThrow({ where: { id: goneFile.id } })).toMatchObject({ messageId: null, detachedFromMessageId: gone.body.id });
    const reply = await prisma.message.create({ data: { content: 'thread reply by alice', userId: aliceId, channelId: priv.id, threadId: sent.body.id } });
    const notAlice = await prisma.message.create({ data: { content: 'contract by member', userId: memberId, channelId: priv.id } });

    // DM: alice가 보낸 것, 받은 것, 그룹 DM(alice가 구성원), 무관한 것
    const dmOut = await prisma.directMessage.create({ data: { content: 'hello bob contract', fromUserId: aliceId, toUserId: bobId } });
    const dmIn = await prisma.directMessage.create({ data: { content: 'reply to alice', fromUserId: bobId, toUserId: aliceId, deletedAt: new Date() } });
    // 그룹은 앱 API로 만든다(구성원 이력이 함께 생긴다)
    const group = (await request(app).post('/dms/groups').set(auth(memberToken)).send({ userIds: [aliceId, bobId] }).expect(201)).body.group;
    const groupMsg = await prisma.directMessage.create({ data: { content: 'group note', fromUserId: memberId, groupId: group.id } });
    const unrelatedDm = await prisma.directMessage.create({ data: { content: 'contract unrelated', fromUserId: memberId, toUserId: bobId } });

    // 파일: alice가 올린 것(채널 메시지), DM에 붙은 남의 파일, 무관한 파일
    const fileMeta = { mimetype: 'application/pdf', size: 10, url: '/files/x' };
    const aliceFile = await prisma.file.create({ data: { ...fileMeta, filename: 'a.pdf', originalName: 'contract.pdf', userId: aliceId, messageId: sent.body.id } });
    const dmFile = await prisma.file.create({ data: { ...fileMeta, filename: 'b.pdf', originalName: 'invoice.pdf', userId: bobId, dmId: dmIn.id } });
    const otherFile = await prisma.file.create({ data: { ...fileMeta, filename: 'c.pdf', originalName: 'contract-other.pdf', userId: memberId } });

    return { priv, sent: sent.body.id as number, gone: gone.body.id as number, goneFile, reply, notAlice, dmOut, dmIn, groupMsg, unrelatedDm, aliceFile, dmFile, otherFile };
  }

  it('finds custodian channel messages (private, edited, deleted), DMs, group DMs and files, and nothing else', async () => {
    const s = await seed();
    await prisma.auditLog.deleteMany();

    const ch = await searchQ(`holdId=${holdId}&kind=channel`).expect(200);
    expect(ch.body.counts).toEqual({ channel: 3, dm: 3, file: 3 });
    expect(ch.body.items.map((i: { id: number }) => i.id)).toEqual([s.reply.id, s.gone, s.sent]);
    const edited = ch.body.items.find((i: { id: number }) => i.id === s.sent);
    expect(edited).toMatchObject({ kind: 'channel', content: 'contract draft v2', editedAt: expect.any(String), deleted: false, channel: { id: s.priv.id, isPrivate: true }, author: { id: aliceId } });
    expect(edited.files).toEqual([expect.objectContaining({ id: s.aliceFile.id, originalName: 'contract.pdf' })]);
    // 삭제된 메시지는 분리된 첨부도 함께 보인다
    const deleted = ch.body.items.find((i: { id: number }) => i.id === s.gone);
    expect(deleted).toMatchObject({ deleted: true, deletedAt: expect.any(String), content: 'delete me secret' });
    expect(deleted.files).toEqual([expect.objectContaining({ id: s.goneFile.id, originalName: 'secret.pdf' })]);

    // 같은 필터로 탭만 바꾸면 건수를 다시 세지 않고 감사 로그도 남기지 않는다
    const dm = await searchQ(`holdId=${holdId}&kind=dm`).expect(200);
    expect(dm.body.counts).toBeUndefined();
    expect(dm.body.items.map((i: { id: number }) => i.id)).toEqual([s.groupMsg.id, s.dmIn.id, s.dmOut.id]);
    expect(dm.body.items.find((i: { id: number }) => i.id === s.dmIn.id)).toMatchObject({ deleted: true, from: { id: bobId }, to: { id: aliceId } });
    expect(dm.body.items.find((i: { id: number }) => i.id === s.groupMsg.id)).toMatchObject({ to: null, group: { id: expect.any(Number) } });

    const files = await searchQ(`holdId=${holdId}&kind=file`).expect(200);
    expect(files.body.items.map((i: { id: number }) => i.id).sort()).toEqual([s.aliceFile.id, s.dmFile.id, s.goneFile.id].sort());
    expect(files.body.items.find((i: { id: number }) => i.id === s.dmFile.id)).toMatchObject({ attachedToDeleted: true, uploader: { id: bobId } });
    expect(files.body.items.find((i: { id: number }) => i.id === s.goneFile.id)).toMatchObject({
      attachedToDeleted: true,
      messageId: null,
      detachedFromMessageId: s.gone,
      channel: { id: s.priv.id, isPrivate: true },
    });
    expect(files.body.items.find((i: { id: number }) => i.id === s.aliceFile.id)).toMatchObject({ attachedToDeleted: false });

    // 건수를 잃은 화면은 counts=1로 건수만 다시 받는다(감사 로그는 늘지 않는다)
    const again = await searchQ(`holdId=${holdId}&kind=channel&counts=1`).expect(200);
    expect(again.body.counts).toEqual({ channel: 3, dm: 3, file: 3 });

    // 필터가 바뀌면 다시 세고 남긴다. 검색어 원문은 남지 않는다
    const kw = await searchQ(`holdId=${holdId}&kind=channel&q=CONTRACT`).expect(200);
    expect(kw.body.items.map((i: { id: number }) => i.id)).toEqual([s.sent]);
    expect(kw.body.counts).toEqual({ channel: 1, dm: 1, file: 1 });
    const logs = await prisma.auditLog.findMany({ where: { action: 'ediscovery.searched' }, orderBy: { id: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(logs[0].details).toContain('query=no');
    expect(logs[1]).toMatchObject({ actorId: adminId, targetType: 'legal_hold', targetId: holdId });
    expect(logs[1].details).toContain('query=yes');
    expect(logs.some((l) => l.details?.toLowerCase().includes('contract'))).toBe(false);
  });

  it('filters by date range and pages with a cursor', async () => {
    const ch = await prisma.channel.create({ data: { name: 'ed-dates', createdBy: aliceId } });
    const at = (iso: string, content: string) => prisma.message.create({ data: { content, userId: aliceId, channelId: ch.id, createdAt: new Date(iso) } });
    await at('2026-01-10T10:00:00Z', 'jan');
    const feb = await at('2026-02-10T10:00:00Z', 'feb');
    const feb2 = await at('2026-02-28T23:00:00Z', 'feb end');
    await at('2026-03-10T10:00:00Z', 'mar');

    const r = await searchQ(`holdId=${holdId}&kind=channel&from=2026-02-01&to=2026-02-28`).expect(200);
    expect(r.body.items.map((i: { id: number }) => i.id)).toEqual([feb2.id, feb.id]); // to가 날짜만이면 그 날 끝까지
    expect(r.body.counts.channel).toBe(2);

    const p1 = await searchQ(`holdId=${holdId}&kind=channel&limit=3`).expect(200);
    expect(p1.body.items).toHaveLength(3);
    const p2 = await searchQ(`holdId=${holdId}&kind=channel&limit=3&cursor=${p1.body.nextCursor}`).expect(200);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.counts).toBeUndefined();
    expect(p2.body.nextCursor).toBeNull();
    // 다음 페이지는 감사 로그를 다시 남기지 않는다
    expect(await prisma.auditLog.count({ where: { action: 'ediscovery.searched' } })).toBe(2);
  });

  it('searches only the hold\'s current custodians', async () => {
    const s = await seed();
    await request(app).delete(`/admin/legal-holds/${holdId}/custodians/${aliceId}`).set(auth(adminToken)).expect(200);
    const r = await searchQ(`holdId=${holdId}&kind=dm`).expect(200);
    expect(r.body).toMatchObject({ items: [], counts: { channel: 0, dm: 0, file: 0 } });
    await request(app).post(`/admin/legal-holds/${holdId}/custodians`).set(auth(adminToken)).send({ userIds: [bobId] }).expect(200);
    const bob = await searchQ(`holdId=${holdId}&kind=dm`).expect(200);
    expect(bob.body.items.map((i: { id: number }) => i.id).sort()).toEqual([s.dmOut.id, s.dmIn.id, s.groupMsg.id, s.unrelatedDm.id].sort());
  });

  it('covers group DMs the custodian could see: up to their last leave, including history before joining and between rejoins', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 15)); // 메시지 시각과 가입·나가기 시각이 같은 ms에 겹치지 않게
    const send = (token: string, groupId: number, content: string) =>
      request(app).post(`/dms/groups/${groupId}/messages`).set(auth(token)).send({ content }).expect(201).then((r) => r.body.id as number);
    const dmIdsOf = async () => (await searchQ(`holdId=${holdId}&kind=dm&counts=1`).expect(200)).body;

    // Create: member가 alice·bob과 그룹을 만들고 메시지를 주고받는다
    const groupId = (await request(app).post('/dms/groups').set(auth(memberToken)).send({ userIds: [aliceId, bobId] }).expect(201)).body.group.id as number;
    const before = await send(memberToken, groupId, 'first period note');
    const aliceSaid = await send(aliceToken, groupId, 'alice says bye');
    // Update: 범위 안 메시지는 고쳐도 잡힌다
    await request(app).patch(`/dms/messages/${before}`).set(auth(memberToken)).send({ content: 'first period note (edited)' }).expect(200);
    await tick();

    // alice가 나간다 → 지금은 나간 뒤 메시지가 빠진다
    await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(aliceToken)).expect(200);
    await tick();
    const away = await send(memberToken, groupId, 'said while alice was away');
    await tick();
    expect((await dmIdsOf()).items.map((i: { id: number }) => i.id)).toEqual([aliceSaid, before]);

    // 다시 들어온다 → 재가입하면 나가 있던 사이의 기록도 볼 수 있으므로 잡힌다
    await request(app).post(`/dms/groups/${groupId}/members`).set(auth(memberToken)).send({ userIds: [aliceId] }).expect(200);
    await tick();
    const after = await send(bobToken, groupId, 'welcome back');
    // Delete: 소프트 삭제된 메시지도 표시와 함께 남는다
    await request(app).delete(`/dms/messages/${after}`).set(auth(bobToken)).expect(200);

    const spans = await prisma.dMGroupMembership.findMany({ where: { groupId, userId: aliceId }, orderBy: { id: 'asc' } });
    expect(spans).toHaveLength(2);
    expect(spans[0].leftAt).not.toBeNull();
    expect(spans[1].leftAt).toBeNull();

    // 나중에 추가된 그룹: 가입 전 기록은 잡히고, 마지막으로 나간 뒤의 메시지는 빠진다
    const late = (await request(app).post('/dms/groups').set(auth(memberToken)).send({ userIds: [bobId, adminId] }).expect(201)).body.group.id as number;
    const preJoin = await send(adminToken, late, 'before alice joined');
    await tick();
    await request(app).post(`/dms/groups/${late}/members`).set(auth(memberToken)).send({ userIds: [aliceId] }).expect(200);
    await tick();
    await request(app).delete(`/dms/groups/${late}/members/me`).set(auth(aliceToken)).expect(200);
    await tick();
    const postLeave = await send(adminToken, late, 'after alice left for good');

    // 같은 필터를 이미 검색했으므로 건수는 counts=1로 다시 받는다
    const r = await searchQ(`holdId=${holdId}&kind=dm&counts=1`).expect(200);
    expect(r.body.items.map((i: { id: number }) => i.id)).toEqual([preJoin, after, away, aliceSaid, before]);
    expect(r.body.counts.dm).toBe(5);
    expect(r.body.items.find((i: { id: number }) => i.id === after)).toMatchObject({ deleted: true, group: { id: groupId } });
    expect(r.body.items.find((i: { id: number }) => i.id === before)).toMatchObject({ content: 'first period note (edited)', editedAt: expect.any(String) });

    const res = await exportFile({ holdId }, `holdId=${holdId}`);
    const dmIds = lines(res.body as string).filter((x) => x.kind === 'dm').map((x) => x.id);
    expect(dmIds).toEqual([before, aliceSaid, away, after, preJoin]);
    expect(dmIds).not.toContain(postLeave);

    // alice가 첫 그룹에서도 마지막으로 나가면 그 뒤 메시지는 빠지고, 그 전 것은 그대로다
    await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(aliceToken)).expect(200);
    await tick();
    const lastOut = await send(memberToken, groupId, 'after second leave');
    const again = await dmIdsOf();
    expect(again.counts.dm).toBe(5);
    expect(again.items.map((i: { id: number }) => i.id)).not.toContain(lastOut);
  });

  it('exports JSONL with a meta line, records and a summary, and logs request and download with counts', async () => {
    const s = await seed();
    await prisma.auditLog.deleteMany();

    const res = await exportFile({ holdId }, `holdId=${holdId}`);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="ediscovery-hold-\d+-\d{4}-\d{2}-\d{2}\.jsonl"/);
    const rows = lines(res.body as string);
    expect(rows[0]).toMatchObject({ type: 'meta', exportedBy: adminId, hold: { id: holdId, name: 'Case' }, custodians: [{ id: aliceId, email: 'ed-alice@example.com' }] });
    const summary = rows[rows.length - 1];
    expect(summary).toEqual({ type: 'summary', counts: { channel: 3, dm: 3, file: 3 } });
    expect(rows[0].filter).toMatchObject({ q: null, from: null, to: null, toDateOnly: null, applied: { createdAtGte: null, createdAtLt: null, createdAtLte: null } });
    const records = rows.slice(1, -1);
    expect(records).toHaveLength(9);
    expect(records.find((r) => r.kind === 'channel' && r.id === s.gone).files).toEqual([expect.objectContaining({ id: s.goneFile.id })]);
    // 종류별로 오래된 것부터
    expect(records.filter((r) => r.kind === 'channel').map((r) => r.id)).toEqual([s.sent, s.gone, s.reply.id]);
    expect(records.find((r) => r.id === s.gone && r.kind === 'channel')).toMatchObject({ type: 'record', deleted: true });
    expect(records.some((r) => r.kind === 'dm' && r.id === s.unrelatedDm.id)).toBe(false);

    const logs = await prisma.auditLog.findMany({ orderBy: { id: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['ediscovery.export_requested', 'ediscovery.exported']);
    expect(logs[0]).toMatchObject({ actorId: adminId, targetType: 'legal_hold', targetId: holdId });
    expect(logs[0].details).toContain('custodians=1');
    expect(logs[1].details).toBe('channel=3; dm=3; file=3; complete=true');

    // 키워드·기간 필터가 같은 규칙으로 적용된다
    const kw = lines((await exportFile({ holdId, q: 'contract' }, `holdId=${holdId}&q=contract`)).body as string);
    expect(kw[kw.length - 1].counts).toEqual({ channel: 1, dm: 1, file: 1 });
    expect(kw[0].filter.q).toBe('contract');

    // to가 날짜만이면 그 날 끝까지 적용했다는 것을 meta에 남긴다
    const dated = lines((await exportFile({ holdId, from: '2026-01-01', to: '2026-01-31' }, `holdId=${holdId}&from=2026-01-01&to=2026-01-31`)).body as string);
    expect(dated[0].filter).toMatchObject({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-31T00:00:00.000Z',
      toDateOnly: true,
      applied: { createdAtGte: '2026-01-01T00:00:00.000Z', createdAtLt: '2026-02-01T00:00:00.000Z', createdAtLte: null },
    });
    const timed = lines((await exportFile({ holdId, to: '2026-01-31T12:00:00Z' }, `holdId=${holdId}&to=2026-01-31T12:00:00Z`)).body as string);
    expect(timed[0].filter).toMatchObject({ toDateOnly: false, applied: { createdAtLte: '2026-01-31T12:00:00.000Z', createdAtLt: null } });
  });

  it('streams large exports across batches', async () => {
    const ch = await prisma.channel.create({ data: { name: 'ed-bulk', createdBy: aliceId } });
    await prisma.message.createMany({ data: Array.from({ length: 1201 }, (_, i) => ({ content: `bulk ${i}`, userId: aliceId, channelId: ch.id })) });
    const rows = lines((await exportFile({ holdId }, `holdId=${holdId}`)).body as string);
    expect(rows[rows.length - 1].counts.channel).toBe(1201);
    const ids = rows.filter((r) => r.type === 'record').map((r) => r.id);
    expect(new Set(ids).size).toBe(1201);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('refuses reused, mismatched or missing export tokens', async () => {
    await seed();
    const t = await request(app).post('/admin/ediscovery/export-token').set(auth(adminToken)).send({ holdId }).expect(201);
    await request(app).get(`/admin/ediscovery/export?holdId=${holdId}&token=${t.body.token}`).expect(200);
    await request(app).get(`/admin/ediscovery/export?holdId=${holdId}&token=${t.body.token}`).expect(403);

    // 필터가 발급 때와 다르면 거부(그리고 소진)
    const t2 = await request(app).post('/admin/ediscovery/export-token').set(auth(adminToken)).send({ holdId, q: 'a' }).expect(201);
    await request(app).get(`/admin/ediscovery/export?holdId=${holdId}&q=b&token=${t2.body.token}`).expect(403);
    await request(app).get(`/admin/ediscovery/export?holdId=${holdId}&q=a&token=${t2.body.token}`).expect(403);
    await request(app).get(`/admin/ediscovery/export?holdId=${holdId}`).expect(403);

    // 감사 로그 내보내기 토큰으로는 eDiscovery를 받을 수 없다
    const auditToken = await request(app).post('/admin/audit-logs/export-token').set(auth(adminToken)).send({}).expect(201);
    await request(app).get(`/admin/ediscovery/export?holdId=${holdId}&token=${auditToken.body.token}`).expect(403);

    // 발급 뒤에 관리자 권한을 잃으면 거부
    const t3 = await request(app).post('/admin/ediscovery/export-token').set(auth(adminToken)).send({ holdId }).expect(201);
    await prisma.user.update({ where: { id: adminId }, data: { role: 'MEMBER' } });
    await request(app).get(`/admin/ediscovery/export?holdId=${holdId}&token=${t3.body.token}`).expect(403);

    expect(await prisma.auditLog.count({ where: { action: 'ediscovery.exported' } })).toBe(1);
  });

  it('validates input and is admin-only', async () => {
    await searchQ('kind=channel').expect(400);
    await searchQ(`holdId=${holdId}&kind=bogus`).expect(400);
    await searchQ(`holdId=${holdId}&from=yesterday`).expect(400);
    await searchQ(`holdId=${holdId}&q=${'x'.repeat(201)}`).expect(400);
    expect((await searchQ('holdId=999999').expect(404)).body.code).toBe('LEGAL_HOLD_NOT_FOUND');
    await request(app).post('/admin/ediscovery/export-token').set(auth(adminToken)).send({ holdId: 999999 }).expect(404);

    for (const t of [
      request(app).get(`/admin/ediscovery/search?holdId=${holdId}`).set(auth(memberToken)),
      request(app).post('/admin/ediscovery/export-token').set(auth(memberToken)).send({ holdId }),
    ]) {
      expect((await t.expect(403)).body.code).toBe('ADMIN_REQUIRED');
    }
    await request(app).get(`/admin/ediscovery/search?holdId=${holdId}`).expect(401);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: 'ediscovery.' } } })).toBe(0);
  });

  it('keeps working on a released hold (data already preserved can still be exported)', async () => {
    await seed();
    await request(app).post(`/admin/legal-holds/${holdId}/release`).set(auth(adminToken)).expect(200);
    const r = await searchQ(`holdId=${holdId}&kind=channel`).expect(200);
    expect(r.body.counts.channel).toBe(3);
    const rows = lines((await exportFile({ holdId }, `holdId=${holdId}`)).body as string);
    expect(rows[0].hold.releasedAt).not.toBeNull();
  });
});
