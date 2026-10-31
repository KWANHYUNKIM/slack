import { TEST_PASSWORD } from './test-constants.js';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { purgeExpiredMessages, setWorkspaceRetentionDays } from '../services/retentionService.js';

// 삭제로 분리된 첨부: DM·그룹 DM도 채널처럼 분리하고, 분리된 파일은 다시 붙일 수 없다
describe('Detached attachments on soft delete', () => {
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let aliceToken: string;
  let aliceId: number;
  let bobToken: string;
  let bobId: number;
  let carolId: number;
  let adminToken: string;

  async function reset() {
    await prisma.legalHold.deleteMany();
    await prisma.workspaceSetting.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.activity.deleteMany();
    await prisma.dMReaction.deleteMany();
    await prisma.reaction.deleteMany();
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

  const mkFile = (userId: number, name: string, createdAt?: Date) =>
    prisma.file.create({ data: { mimetype: 'text/plain', size: 1, url: `/files/${name}`, filename: name, originalName: `${name}.txt`, userId, ...(createdAt && { createdAt }) } });

  beforeAll(async () => {
    await reset();
    const admin = await register('fd-admin@example.com', 'FD Admin');
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    adminToken = (await request(app).post('/auth/login').send({ email: 'fd-admin@example.com', password: TEST_PASSWORD })).body.token;
    const a = await register('fd-alice@example.com', 'FD Alice');
    aliceId = a.id;
    aliceToken = a.token;
    const b = await register('fd-bob@example.com', 'FD Bob');
    bobId = b.id;
    bobToken = b.token;
    carolId = (await register('fd-carol@example.com', 'FD Carol')).id;
  });
  afterAll(async () => {
    await reset();
  });

  it('detaches a 1:1 DM attachment on delete and refuses reattaching it (create -> read -> delete -> reattach, repeated)', async () => {
    for (let round = 0; round < 2; round++) {
      const file = await mkFile(aliceId, `dm-${round}`);
      const sent = await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'with file', fileIds: [file.id] }).expect(201);
      expect(sent.body.files).toEqual([expect.objectContaining({ id: file.id })]);
      // 받는 사람은 내려받을 수 있다
      await request(app).get(`/files/${file.id}`).set(auth(bobToken)).expect(200);

      await request(app).delete(`/dms/messages/${sent.body.id}`).set(auth(aliceToken)).expect(200);
      expect(await prisma.file.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ dmId: null, messageId: null, detachedFromDmId: sent.body.id, detachedFromMessageId: null });
      // 삭제된 DM의 파일은 받는 사람에게 접근 불가(기존 동작). 올린 사람은 채널과 같이 미첨부 파일로 본인만 본다
      await request(app).get(`/files/${file.id}`).set(auth(bobToken)).expect(404);

      // 같은 fileId를 새 DM에 붙이려 하면 거부
      const again = await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'reuse', fileIds: [file.id] });
      expect(again.status).toBe(400);
      expect(await prisma.file.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ dmId: null, detachedFromDmId: sent.body.id });
    }
  });

  it('detaches a group DM attachment and refuses reattaching to DM, group DM, channel and thread reply', async () => {
    const group = await request(app).post('/dms/groups').set(auth(aliceToken)).send({ userIds: [bobId, carolId] }).expect(201);
    const gid = group.body.id ?? group.body.group?.id;
    const file = await mkFile(aliceId, 'grp');
    const sent = await request(app).post(`/dms/groups/${gid}/messages`).set(auth(aliceToken)).send({ content: 'group file', fileIds: [file.id] }).expect(201);
    await request(app).delete(`/dms/messages/${sent.body.id}`).set(auth(aliceToken)).expect(200);
    expect(await prisma.file.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ dmId: null, detachedFromDmId: sent.body.id });

    expect((await request(app).post(`/dms/groups/${gid}/messages`).set(auth(aliceToken)).send({ content: 'reuse', fileIds: [file.id] })).status).toBe(400);
    expect((await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'reuse', fileIds: [file.id] })).status).toBe(400);
    const parent = await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'parent' }).expect(201);
    expect((await request(app).post(`/dms/messages/${parent.body.id}/reply`).set(auth(aliceToken)).send({ content: 'reuse', fileIds: [file.id] })).status).toBe(400);

    const ch = await prisma.channel.create({ data: { name: 'fd-chan', createdBy: aliceId } });
    await prisma.channelMember.create({ data: { userId: aliceId, channelId: ch.id } });
    expect((await request(app).post(`/channels/${ch.id}/messages`).set(auth(aliceToken)).send({ content: 'reuse', fileIds: [file.id] })).status).toBe(400);
    const chParent = await request(app).post(`/channels/${ch.id}/messages`).set(auth(aliceToken)).send({ content: 'p' }).expect(201);
    expect((await request(app).post(`/messages/${chParent.body.id}/reply`).set(auth(aliceToken)).send({ content: 'reuse', fileIds: [file.id] })).status).toBe(400);
  });

  it('refuses reattaching a file detached from a channel message, and still attaches fresh files', async () => {
    const ch = await prisma.channel.create({ data: { name: 'fd-chan2', createdBy: aliceId } });
    await prisma.channelMember.create({ data: { userId: aliceId, channelId: ch.id } });
    const file = await mkFile(aliceId, 'chan');
    const sent = await request(app).post(`/channels/${ch.id}/messages`).set(auth(aliceToken)).send({ content: 'f', fileIds: [file.id] }).expect(201);
    await request(app).delete(`/messages/${sent.body.id}`).set(auth(aliceToken)).expect(200);
    expect(await prisma.file.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({ messageId: null, detachedFromMessageId: sent.body.id });
    expect((await request(app).post(`/channels/${ch.id}/messages`).set(auth(aliceToken)).send({ content: 'reuse', fileIds: [file.id] })).status).toBe(400);
    expect((await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'reuse', fileIds: [file.id] })).status).toBe(400);

    const fresh = await mkFile(aliceId, 'fresh');
    await request(app).post(`/channels/${ch.id}/messages`).set(auth(aliceToken)).send({ content: 'ok', fileIds: [fresh.id] }).expect(201);
  });

  it('keeps detached DM files visible to eDiscovery and purges them by retention', async () => {
    const file = await mkFile(aliceId, 'ed-dm', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000));
    const sent = await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'ed secret', fileIds: [file.id] }).expect(201);
    await request(app).delete(`/dms/messages/${sent.body.id}`).set(auth(aliceToken)).expect(200);

    const hold = await request(app).post('/admin/legal-holds').set(auth(adminToken)).send({ name: 'Case', userIds: [aliceId] }).expect(201);
    const files = await request(app).get(`/admin/ediscovery/search?holdId=${hold.body.id}&kind=file`).set(auth(adminToken)).expect(200);
    expect(files.body.items.find((i: { id: number }) => i.id === file.id)).toMatchObject({ attachedToDeleted: true, detachedFromDmId: sent.body.id, dmId: null });
    const dms = await request(app).get(`/admin/ediscovery/search?holdId=${hold.body.id}&kind=dm`).set(auth(adminToken)).expect(200);
    const rec = dms.body.items.find((i: { id: number }) => i.id === sent.body.id);
    expect(rec).toMatchObject({ deleted: true });
    expect(rec.files).toEqual([expect.objectContaining({ id: file.id })]);

    // 보존 건 대상자의 파일은 정리에서 제외된다
    await setWorkspaceRetentionDays(30);
    await purgeExpiredMessages();
    expect(await prisma.file.findUnique({ where: { id: file.id } })).not.toBeNull();

    // 보존이 풀리면 분리된 파일이 정리된다
    await request(app).delete(`/admin/legal-holds/${hold.body.id}`).set(auth(adminToken));
    await prisma.legalHold.deleteMany();
    await prisma.user.updateMany({ data: { legalHold: false } });
    const r = await purgeExpiredMessages();
    expect(r.files).toBeGreaterThanOrEqual(1);
    expect(await prisma.file.findUnique({ where: { id: file.id } })).toBeNull();
    await setWorkspaceRetentionDays(null);
  });
  const OLD = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  it('attaches a file even when its id is sent twice', async () => {
    const file = await mkFile(aliceId, 'dup');
    const sent = await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'dup', fileIds: [file.id, file.id] }).expect(201);
    expect(sent.body.files).toHaveLength(1);
    const f2 = await mkFile(aliceId, 'dup2');
    await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'dup', fileIds: [f2.id, f2.id, 999999] }).expect(400);
  });

  it('hides detached files from GET /files and refuses deleting them (even for the uploader)', async () => {
    const file = await mkFile(aliceId, 'list');
    const sent = await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'list', fileIds: [file.id] }).expect(201);
    await request(app).delete(`/dms/messages/${sent.body.id}`).set(auth(aliceToken)).expect(200);
    expect((await request(app).get('/files').set(auth(aliceToken)).expect(200)).body.some((x: { id: number }) => x.id === file.id)).toBe(false);

    // 보존 대상자가 DM을 지운 뒤 파일을 지우려 해도 거부되고 파일이 남는다
    await prisma.user.update({ where: { id: aliceId }, data: { legalHold: true } });
    const del = await request(app).delete(`/files/${file.id}`).set(auth(aliceToken));
    await prisma.user.update({ where: { id: aliceId }, data: { legalHold: false } });
    expect(del.status).toBe(400);
    expect(del.body.code).toBe('FILE_ATTACHED_TO_DELETED');
    expect(await prisma.file.findUnique({ where: { id: file.id } })).not.toBeNull();
    // 일반 미첨부 파일은 여전히 지울 수 있다
    const plain = await mkFile(aliceId, 'plain');
    await request(app).delete(`/files/${plain.id}`).set(auth(aliceToken)).expect(200);
  });

  it('keeps detached files whose original DM recipient or channel is under legal hold, and purges them after release', async () => {
    await setWorkspaceRetentionDays(30);
    const dmFile = await mkFile(aliceId, 'hold-dm', OLD);
    const dm = await request(app).post('/dms').set(auth(aliceToken)).send({ toUserId: bobId, content: 'x', fileIds: [dmFile.id] }).expect(201);
    await request(app).delete(`/dms/messages/${dm.body.id}`).set(auth(aliceToken)).expect(200);
    const ch = await prisma.channel.create({ data: { name: 'fd-hold-chan', createdBy: aliceId, legalHold: true } });
    await prisma.channelMember.create({ data: { userId: aliceId, channelId: ch.id } });
    const chFile = await mkFile(aliceId, 'hold-ch', OLD);
    const msg = await request(app).post(`/channels/${ch.id}/messages`).set(auth(aliceToken)).send({ content: 'x', fileIds: [chFile.id] }).expect(201);
    await request(app).delete(`/messages/${msg.body.id}`).set(auth(aliceToken)).expect(200);
    const freeFile = await mkFile(aliceId, 'free-orphan', OLD);

    await prisma.user.update({ where: { id: bobId }, data: { legalHold: true } });
    await purgeExpiredMessages();
    expect(await prisma.file.findUnique({ where: { id: dmFile.id } })).not.toBeNull();
    expect(await prisma.file.findUnique({ where: { id: chFile.id } })).not.toBeNull();
    expect(await prisma.file.findUnique({ where: { id: freeFile.id } })).toBeNull();

    // 받는 사람만 풀어도 채널 보존이 남아 있으면 채널 파일은 남는다
    await prisma.user.update({ where: { id: bobId }, data: { legalHold: false } });
    await purgeExpiredMessages();
    expect(await prisma.file.findUnique({ where: { id: dmFile.id } })).toBeNull();
    expect(await prisma.file.findUnique({ where: { id: chFile.id } })).not.toBeNull();
    await prisma.channel.update({ where: { id: ch.id }, data: { legalHold: false } });
    await purgeExpiredMessages();
    expect(await prisma.file.findUnique({ where: { id: chFile.id } })).toBeNull();
    await setWorkspaceRetentionDays(null);
  });

  it('backfill migration detaches files of already soft-deleted DMs only', async () => {
    const deletedDm = await prisma.directMessage.create({ data: { content: 'old gone', fromUserId: aliceId, toUserId: bobId, deletedAt: new Date() } });
    const liveDm = await prisma.directMessage.create({ data: { content: 'live', fromUserId: aliceId, toUserId: bobId } });
    const a = await mkFile(aliceId, 'bf-gone');
    const b = await mkFile(aliceId, 'bf-live');
    await prisma.file.update({ where: { id: a.id }, data: { dmId: deletedDm.id } });
    await prisma.file.update({ where: { id: b.id }, data: { dmId: liveDm.id } });

    const sql = fs.readFileSync(path.resolve('prisma/migrations/20261101100000_backfill_detached_dm_files/migration.sql'), 'utf8');
    await prisma.$executeRawUnsafe(sql);
    expect(await prisma.file.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ dmId: null, detachedFromDmId: deletedDm.id });
    expect(await prisma.file.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ dmId: liveDm.id, detachedFromDmId: null });
    // 다시 실행해도 같다
    await prisma.$executeRawUnsafe(sql);
    expect(await prisma.file.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ dmId: null, detachedFromDmId: deletedDm.id });
  });
});
