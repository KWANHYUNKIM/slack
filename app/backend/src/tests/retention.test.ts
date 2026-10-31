import { TEST_PASSWORD } from './test-constants.js';
import { jest } from '@jest/globals';
import { createServer } from 'http';
import { io as Client } from 'socket.io-client';
import { initializeWebSocket } from '../websocket/index.js';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { listenOnLoopback } from './listenLoopback.js';
import app from '../app.js';
import prisma from '../db.js';
import { uploadDir } from '../services/fileStorage.js';
import { Prisma } from '@prisma/client';
import { purgeExpiredMessages, MAX_STORAGE_DELETE_ATTEMPTS, effectiveDays, HELD_CTE, HELD_USER, NOT_HELD_USER } from '../services/retentionService.js';
import { utcTimestamp } from '../db/sqlTime.js';
import { purgeRetentionIfDue, resetRetentionSchedule } from '../scheduler.js';

// 데이터 보존 정책(E5): 정책 CRUD, 정리 범위, 덮어쓰기, 법적 보존 제외, 무기한, 권한
describe('Data retention', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  let adminToken: string;
  let adminId: number;
  let memberToken: string;
  let memberId: number;
  let heldId: number;
  let otherId: number;

  async function reset() {
    await prisma.workspaceSetting.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.activity.deleteMany();
    await prisma.reminder.deleteMany();
    await prisma.bookmark.deleteMany();
    await prisma.reaction.deleteMany();
    await prisma.dMReaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.storageDeletionRetry.deleteMany();
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

  async function seed() {
    const a = await register('ret-admin@example.com', 'Ret Admin');
    adminId = a.id;
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });
    adminToken = (await request(app).post('/auth/login').send({ email: 'ret-admin@example.com', password: TEST_PASSWORD })).body.token;
    const m = await register('ret-member@example.com', 'Ret Member');
    memberId = m.id;
    memberToken = m.token;
    heldId = (await register('ret-held@example.com', 'Ret Held')).id;
    otherId = (await register('ret-other@example.com', 'Ret Other')).id;
    await prisma.auditLog.deleteMany();
  }

  const mkChannel = (name: string, extra: Record<string, unknown> = {}) =>
    prisma.channel.create({ data: { name, createdBy: adminId, ...extra } });
  const mkMsg = (channelId: number, ageDays: number, extra: Record<string, unknown> = {}) =>
    prisma.message.create({ data: { content: `m-${ageDays}d`, userId: memberId, channelId, createdAt: ago(ageDays), ...extra } });
  const exists = async (id: number) => (await prisma.message.findUnique({ where: { id } })) !== null;
  const dmExists = async (id: number) => (await prisma.directMessage.findUnique({ where: { id } })) !== null;
  const setWorkspace = (days: number | null) => prisma.workspaceSetting.upsert({ where: { id: 1 }, create: { id: 1, messageRetentionDays: days }, update: { messageRetentionDays: days } });

  beforeEach(async () => {
    await reset();
    await seed();
  });
  afterAll(async () => {
    await reset();
  });

  describe('policy API', () => {
    it('sets, reads, changes and clears the workspace and channel policy, and logs every change', async () => {
      const ch = await mkChannel('ret-api');

      const first = await request(app).get('/admin/retention').set(auth(adminToken)).expect(200);
      expect(first.body.workspace.days).toBeNull();
      expect(first.body.channels.find((c: { id: number }) => c.id === ch.id)).toMatchObject({ override: null, effectiveDays: null, legalHold: false });

      // Create / Update workspace
      await request(app).put('/admin/retention/workspace').set(auth(adminToken)).send({ days: 30 }).expect(200);
      await request(app).put('/admin/retention/workspace').set(auth(adminToken)).send({ days: 60 }).expect(200);
      expect((await request(app).get('/admin/retention').set(auth(adminToken)).expect(200)).body.workspace.days).toBe(60);

      // Channel override: 7 days, then "this channel only keeps forever", then back to inherit (delete)
      const put7 = await request(app).put(`/admin/retention/channels/${ch.id}`).set(auth(adminToken)).send({ days: 7 }).expect(200);
      expect(put7.body).toMatchObject({ override: { days: 7 }, effectiveDays: 7 });
      const forever = await request(app).put(`/admin/retention/channels/${ch.id}`).set(auth(adminToken)).send({ days: null }).expect(200);
      expect(forever.body).toMatchObject({ override: { days: null }, effectiveDays: null });
      const del = await request(app).delete(`/admin/retention/channels/${ch.id}`).set(auth(adminToken)).expect(200);
      expect(del.body).toMatchObject({ override: null, effectiveDays: 60 });

      // Delete workspace policy (back to indefinite)
      await request(app).put('/admin/retention/workspace').set(auth(adminToken)).send({ days: null }).expect(200);
      expect((await request(app).get('/admin/retention').set(auth(adminToken)).expect(200)).body.workspace.days).toBeNull();

      const actions = (await prisma.auditLog.findMany({ orderBy: { id: 'asc' } })).map((l) => l.action);
      expect(actions).toEqual([
        'retention.workspace_updated',
        'retention.workspace_updated',
        'retention.channel_updated',
        'retention.channel_updated',
        'retention.channel_cleared',
        'retention.workspace_updated',
      ]);
      const log = await prisma.auditLog.findFirst({ where: { action: 'retention.workspace_updated' }, orderBy: { id: 'asc' } });
      expect(log).toMatchObject({ actorId: adminId, targetType: 'workspace', details: 'days=none -> 30' });
    });

    it('rejects values below the minimum, non-integers and bad input; unknown channel is 404', async () => {
      const ch = await mkChannel('ret-bad');
      for (const days of [0, -5, 1.5, '30', 99999, undefined]) {
        await request(app).put('/admin/retention/workspace').set(auth(adminToken)).send({ days }).expect(400);
        await request(app).put(`/admin/retention/channels/${ch.id}`).set(auth(adminToken)).send({ days }).expect(400);
      }
      await request(app).put('/admin/retention/workspace').set(auth(adminToken)).send({ days: 1 }).expect(200);
      await request(app).put('/admin/retention/channels/abc').set(auth(adminToken)).send({ days: 5 }).expect(400);
      await request(app).put('/admin/retention/channels/999999').set(auth(adminToken)).send({ days: 5 }).expect(404);
      await request(app).delete('/admin/retention/channels/999999').set(auth(adminToken)).expect(404);
      expect((await prisma.channel.findUnique({ where: { id: ch.id } }))?.retentionDays).toBeNull();
    });

    it('rejects non-admins and anonymous requests', async () => {
      const ch = await mkChannel('ret-denied');
      await request(app).get('/admin/retention').expect(401);
      await request(app).get('/admin/retention').set(auth(memberToken)).expect(403);
      await request(app).put('/admin/retention/workspace').set(auth(memberToken)).send({ days: 5 }).expect(403);
      await request(app).put(`/admin/retention/channels/${ch.id}`).set(auth(memberToken)).send({ days: 5 }).expect(403);
      await request(app).delete(`/admin/retention/channels/${ch.id}`).set(auth(memberToken)).expect(403);
      expect(await prisma.workspaceSetting.count()).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: { startsWith: 'retention.' } } })).toBe(0);
    });

    it('resolves the effective days: override wins, 0 means forever, null inherits', () => {
      expect(effectiveDays(null, 30)).toBe(30);
      expect(effectiveDays(7, 30)).toBe(7);
      expect(effectiveDays(7, null)).toBe(7);
      expect(effectiveDays(0, 30)).toBeNull();
      expect(effectiveDays(null, null)).toBeNull();
    });
  });

  describe('purge', () => {
    it('removes expired messages with their files, reactions, bookmarks and activities, keeps reminders, and keeps the rest', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-main');
      const other = await mkChannel('ret-other');
      const old = await mkMsg(ch.id, 40, { isPinned: true });
      const fresh = await mkMsg(ch.id, 10);
      const otherFresh = await mkMsg(other.id, 5);

      const filename = `ret-test-${Date.now()}.txt`;
      fs.writeFileSync(path.join(uploadDir, filename), 'old file');
      const oldFile = await prisma.file.create({ data: { filename, originalName: 'a.txt', mimetype: 'text/plain', size: 8, url: `/files/${filename}`, userId: memberId, messageId: old.id } });
      const freshFilename = `ret-test-fresh-${Date.now()}.txt`;
      fs.writeFileSync(path.join(uploadDir, freshFilename), 'fresh file');
      const freshFile = await prisma.file.create({ data: { filename: freshFilename, originalName: 'b.txt', mimetype: 'text/plain', size: 10, url: `/files/${freshFilename}`, userId: memberId, messageId: fresh.id } });

      await prisma.reaction.create({ data: { emoji: 'thumbsup', userId: adminId, messageId: old.id } });
      await prisma.reaction.create({ data: { emoji: 'thumbsup', userId: adminId, messageId: fresh.id } });
      await prisma.bookmark.create({ data: { userId: adminId, messageId: old.id } });
      await prisma.reminder.create({ data: { userId: adminId, messageId: old.id, channelId: ch.id, remindAt: ago(-1) } });
      await prisma.activity.create({ data: { userId: adminId, actorId: memberId, type: 'REACTION', messageId: old.id, channelId: ch.id, emoji: 'thumbsup' } });
      await prisma.activity.create({ data: { userId: adminId, actorId: memberId, type: 'MENTION', messageId: fresh.id, channelId: ch.id } });

      const result = await purgeExpiredMessages();
      expect(result).toMatchObject({ messages: 1, files: 1, placeholders: 0 });

      expect(await exists(old.id)).toBe(false);
      expect(fs.existsSync(path.join(uploadDir, filename))).toBe(false);
      expect(await prisma.file.findUnique({ where: { id: oldFile.id } })).toBeNull();
      expect(await prisma.reaction.count({ where: { messageId: old.id } })).toBe(0);
      expect(await prisma.bookmark.count({ where: { messageId: old.id } })).toBe(0);
      // 리마인더는 FK 없이 남아 "삭제된 메시지"로 보인다(스키마 규칙)
      expect(await prisma.reminder.count({ where: { messageId: old.id } })).toBe(1);
      expect(await prisma.activity.count({ where: { messageId: old.id } })).toBe(0);

      // 기간 안의 메시지와 다른 채널 메시지, 그 부속물은 그대로다
      expect(await exists(fresh.id)).toBe(true);
      expect(await exists(otherFresh.id)).toBe(true);
      expect(fs.existsSync(path.join(uploadDir, freshFilename))).toBe(true);
      expect(await prisma.file.findUnique({ where: { id: freshFile.id } })).not.toBeNull();
      expect(await prisma.reaction.count({ where: { messageId: fresh.id } })).toBe(1);
      expect(await prisma.activity.count({ where: { messageId: fresh.id } })).toBe(1);

      // 진행은 채널별로 감사 로그에 남는다
      const logs = await prisma.auditLog.findMany({ where: { action: 'retention.purged' } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ actorId: null, targetType: 'channel', targetId: ch.id, targetName: 'ret-main', details: 'days=30; messages=1; files=1; placeholders=0' });

      // 두 번째 실행은 할 일이 없고 로그도 늘지 않는다
      expect(await purgeExpiredMessages()).toMatchObject({ messages: 0, files: 0, placeholders: 0 });
      expect(await prisma.auditLog.count({ where: { action: 'retention.purged' } })).toBe(1);
      fs.rmSync(path.join(uploadDir, freshFilename), { force: true });
    });

    it('lets a channel override beat the workspace default in both directions', async () => {
      await setWorkspace(30);
      const shorter = await mkChannel('ret-short', { retentionDays: 7 });
      const longer = await mkChannel('ret-long', { retentionDays: 90 });
      const forever = await mkChannel('ret-forever', { retentionDays: 0 });
      const inherit = await mkChannel('ret-inherit');
      const s10 = await mkMsg(shorter.id, 10); // 7일 정책이라 삭제
      const l40 = await mkMsg(longer.id, 40); // 90일 정책이라 유지
      const l100 = await mkMsg(longer.id, 100); // 삭제
      const f400 = await mkMsg(forever.id, 400); // 무기한이라 유지
      const i40 = await mkMsg(inherit.id, 40); // 기본 30일이라 삭제
      const i10 = await mkMsg(inherit.id, 10);

      await purgeExpiredMessages();
      expect(await exists(s10.id)).toBe(false);
      expect(await exists(l40.id)).toBe(true);
      expect(await exists(l100.id)).toBe(false);
      expect(await exists(f400.id)).toBe(true);
      expect(await exists(i40.id)).toBe(false);
      expect(await exists(i10.id)).toBe(true);
    });

    it('deletes nothing when the policy is indefinite (null)', async () => {
      const ch = await mkChannel('ret-null');
      const m = await mkMsg(ch.id, 4000);
      const dm = await prisma.directMessage.create({ data: { content: 'old dm', fromUserId: memberId, toUserId: otherId, createdAt: ago(4000) } });

      expect(await purgeExpiredMessages()).toMatchObject({ messages: 0 });
      await setWorkspace(null);
      expect(await purgeExpiredMessages()).toMatchObject({ messages: 0 });
      expect(await exists(m.id)).toBe(true);
      expect(await dmExists(dm.id)).toBe(true);
      expect(await prisma.auditLog.count({ where: { action: 'retention.purged' } })).toBe(0);
    });

    it('does not touch anything outside the policy scope (channel-only override leaves other channels and DMs alone)', async () => {
      // 워크스페이스는 무기한, 한 채널만 7일
      const scoped = await mkChannel('ret-scoped', { retentionDays: 7 });
      const outside = await mkChannel('ret-outside');
      const inScope = await mkMsg(scoped.id, 20);
      const outOld = await mkMsg(outside.id, 500);
      const dm = await prisma.directMessage.create({ data: { content: 'old dm', fromUserId: memberId, toUserId: otherId, createdAt: ago(500) } });
      const file = await prisma.file.create({ data: { filename: 'ret-keep.txt', originalName: 'k.txt', mimetype: 'text/plain', size: 1, url: '/files/ret-keep.txt', userId: memberId, messageId: outOld.id } });

      await purgeExpiredMessages();
      expect(await exists(inScope.id)).toBe(false);
      expect(await exists(outOld.id)).toBe(true);
      expect(await dmExists(dm.id)).toBe(true);
      expect(await prisma.file.findUnique({ where: { id: file.id } })).not.toBeNull();
      expect(await prisma.message.count()).toBe(1);
    });

    it('purges DMs and group DMs by the workspace policy, and ignores channel overrides for them', async () => {
      await setWorkspace(30);
      const dmOld = await prisma.directMessage.create({ data: { content: 'old', fromUserId: memberId, toUserId: otherId, createdAt: ago(40) } });
      const dmNew = await prisma.directMessage.create({ data: { content: 'new', fromUserId: memberId, toUserId: otherId, createdAt: ago(5) } });
      await prisma.dMReaction.create({ data: { emoji: 'x', userId: otherId, dmId: dmOld.id } });
      const group = await prisma.dMGroup.create({ data: { memberKey: `${memberId}-${otherId}-${adminId}`, createdBy: memberId } });
      await prisma.dMGroupMember.createMany({ data: [memberId, otherId, adminId].map((userId) => ({ groupId: group.id, userId })) });
      const gOld = await prisma.directMessage.create({ data: { content: 'g-old', fromUserId: memberId, groupId: group.id, createdAt: ago(40) } });
      const gNew = await prisma.directMessage.create({ data: { content: 'g-new', fromUserId: memberId, groupId: group.id, createdAt: ago(1) } });
      await prisma.channel.create({ data: { name: 'ret-ov', createdBy: adminId, retentionDays: 1 } });

      await purgeExpiredMessages();
      expect(await dmExists(dmOld.id)).toBe(false);
      expect(await dmExists(gOld.id)).toBe(false);
      expect(await dmExists(dmNew.id)).toBe(true);
      expect(await dmExists(gNew.id)).toBe(true);
      expect(await prisma.dMReaction.count({ where: { dmId: dmOld.id } })).toBe(0);
      const log = await prisma.auditLog.findFirst({ where: { action: 'retention.purged', targetType: 'direct_message' } });
      expect(log?.details).toBe('days=30; messages=2; files=0; placeholders=0');
    });

    it('turns a thread parent with surviving replies into a placeholder and removes it after the replies expire', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-thread');
      const parent = await mkMsg(ch.id, 40, { isPinned: true });
      const oldReply = await mkMsg(ch.id, 35, { threadId: parent.id });
      const freshReply = await mkMsg(ch.id, 2, { threadId: parent.id });
      await prisma.reaction.create({ data: { emoji: 'x', userId: adminId, messageId: parent.id } });
      await prisma.bookmark.create({ data: { userId: adminId, messageId: parent.id } });

      const r1 = await purgeExpiredMessages();
      expect(r1).toMatchObject({ messages: 1, placeholders: 1, partial: false });
      expect(await exists(oldReply.id)).toBe(false);
      expect(await exists(freshReply.id)).toBe(true);
      const blank = await prisma.message.findUniqueOrThrow({ where: { id: parent.id } });
      expect(blank).toMatchObject({ content: '', isPinned: false });
      expect(blank.deletedAt).not.toBeNull();
      expect(await prisma.reaction.count({ where: { messageId: parent.id } })).toBe(0);
      expect(await prisma.bookmark.count({ where: { messageId: parent.id } })).toBe(0);
      // 답글의 threadId가 끊어지지 않았다
      expect((await prisma.message.findUniqueOrThrow({ where: { id: freshReply.id } })).threadId).toBe(parent.id);

      // 채널 타임라인은 삭제된 부모를 자리표시자로 그대로 보여 준다(04 규칙)
      const timeline = await request(app).get(`/channels/${ch.id}/messages`).set(auth(adminToken)).expect(200);
      const shown = timeline.body.messages.find((m: { id: number }) => m.id === parent.id);
      expect(shown).toMatchObject({ content: '', deletedAt: expect.any(String) });

      // 다시 돌려도 자리표시자는 그대로(멱등)
      expect(await purgeExpiredMessages()).toMatchObject({ messages: 0, placeholders: 0 });

      // 답글이 만료되면 부모까지 같은 실행에서 지워진다
      const later = new Date(Date.now() + 40 * DAY);
      const r2 = await purgeExpiredMessages(later);
      expect(r2.messages).toBe(2);
      expect(await exists(parent.id)).toBe(false);
      expect(await exists(freshReply.id)).toBe(false);
    });

    it('excludes legal-hold users, channels and DMs involving a held user', async () => {
      await setWorkspace(30);
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: true } });
      const ch = await mkChannel('ret-hold');
      const heldCh = await mkChannel('ret-hold-channel', { legalHold: true });
      const heldMsg = await prisma.message.create({ data: { content: 'held', userId: heldId, channelId: ch.id, createdAt: ago(100) } });
      const normalMsg = await mkMsg(ch.id, 100);
      const inHeldChannel = await mkMsg(heldCh.id, 100);
      const dmFromHeld = await prisma.directMessage.create({ data: { content: 'a', fromUserId: heldId, toUserId: otherId, createdAt: ago(100) } });
      const dmToHeld = await prisma.directMessage.create({ data: { content: 'b', fromUserId: otherId, toUserId: heldId, createdAt: ago(100) } });
      const dmOther = await prisma.directMessage.create({ data: { content: 'c', fromUserId: memberId, toUserId: otherId, createdAt: ago(100) } });
      const group = await prisma.dMGroup.create({ data: { memberKey: `g-${heldId}`, createdBy: memberId } });
      await prisma.dMGroupMember.createMany({ data: [memberId, otherId, heldId].map((userId) => ({ groupId: group.id, userId })) });
      await prisma.dMGroupMembership.createMany({ data: [memberId, otherId, heldId].map((userId) => ({ groupId: group.id, userId, joinedAt: ago(200) })) });
      const groupMsg = await prisma.directMessage.create({ data: { content: 'g', fromUserId: memberId, groupId: group.id, createdAt: ago(100) } });

      await purgeExpiredMessages();
      expect(await exists(heldMsg.id)).toBe(true);
      expect(await exists(inHeldChannel.id)).toBe(true);
      expect(await dmExists(dmFromHeld.id)).toBe(true);
      expect(await dmExists(dmToHeld.id)).toBe(true);
      expect(await dmExists(groupMsg.id)).toBe(true);
      expect(await exists(normalMsg.id)).toBe(false);
      expect(await dmExists(dmOther.id)).toBe(false);
    });

    it('protects group DMs a held user could see (up to their last leave), even after they left', async () => {
      await setWorkspace(30);
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: true } });
      const group = await prisma.dMGroup.create({ data: { memberKey: `g-hist-${heldId}`, createdBy: memberId, createdAt: ago(400) } });
      await prisma.dMGroupMember.createMany({ data: [memberId, otherId].map((userId) => ({ groupId: group.id, userId })) });
      // held: 300일 전에 추가돼 200일 전에 나감 → 100일 전 재가입 → 50일 전에 마지막으로 나감
      const lastLeft = ago(50);
      await prisma.dMGroupMembership.createMany({
        data: [
          ...[memberId, otherId].map((userId) => ({ groupId: group.id, userId, joinedAt: ago(400) })),
          { groupId: group.id, userId: heldId, joinedAt: ago(300), leftAt: ago(200) },
          { groupId: group.id, userId: heldId, joinedAt: ago(100), leftAt: lastLeft },
        ],
      });
      const mk = (days: number) => prisma.directMessage.create({ data: { content: `g-${days}`, fromUserId: memberId, groupId: group.id, createdAt: ago(days) } });
      const beforeJoin = await mk(350); // 가입 전 기록도 가입 뒤 볼 수 있었다
      const inFirst = await mk(250);
      const between = await mk(150); // 나가 있던 사이: 재가입 뒤 볼 수 있었다
      const inSecond = await mk(75);
      const afterLeave = await mk(40);
      // 경계: 마지막으로 나간 시각에 쓴 메시지는 보존 쪽으로 본다(leftAt 이하)
      const atLeave = await prisma.directMessage.create({ data: { content: 'edge', fromUserId: memberId, groupId: group.id, createdAt: lastLeft } });
      // 자리표시자 경로: 범위 안 부모에 새 답글이 달려 있어도 부모는 그대로 남는다
      const parentInSpan = await mk(80);
      await prisma.directMessage.create({ data: { content: 'fresh', fromUserId: otherId, groupId: group.id, threadId: parentInSpan.id } });
      // 다른 그룹에서는 지금 구성원인 보존 대상자가 늦게 들어왔어도 그룹 전체가 보호된다
      const current = await prisma.dMGroup.create({ data: { memberKey: `g-cur-${heldId}`, createdBy: memberId, createdAt: ago(400) } });
      await prisma.dMGroupMembership.createMany({
        data: [{ groupId: current.id, userId: memberId, joinedAt: ago(400) }, { groupId: current.id, userId: heldId, joinedAt: ago(10) }],
      });
      const oldInCurrent = await prisma.directMessage.create({ data: { content: 'old', fromUserId: memberId, groupId: current.id, createdAt: ago(300) } });

      await purgeExpiredMessages();
      for (const m of [beforeJoin, inFirst, between, inSecond, atLeave, oldInCurrent]) expect(await dmExists(m.id)).toBe(true);
      expect(await prisma.directMessage.findUniqueOrThrow({ where: { id: parentInSpan.id } })).toMatchObject({ content: 'g-80', deletedAt: null });
      expect(await dmExists(afterLeave.id)).toBe(false);

      // 보존이 풀리면 범위 안 메시지도 정리된다
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: false } });
      await purgeExpiredMessages();
      for (const m of [beforeJoin, inFirst, between, inSecond, atLeave, oldInCurrent]) expect(await dmExists(m.id)).toBe(false);
    });

    it('keeps group DMs of a current member that has no history row (safety net)', async () => {
      await setWorkspace(30);
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: true } });
      const group = await prisma.dMGroup.create({ data: { memberKey: `g-nohist-${heldId}`, createdBy: memberId } });
      await prisma.dMGroupMember.createMany({ data: [memberId, otherId, heldId].map((userId) => ({ groupId: group.id, userId })) });
      const msg = await prisma.directMessage.create({ data: { content: 'g', fromUserId: memberId, groupId: group.id, createdAt: ago(100) } });
      await purgeExpiredMessages();
      expect(await dmExists(msg.id)).toBe(true);
    });

    it('still purges when a held user has thousands of group histories', async () => {
      await setWorkspace(30);
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: true } });
      const N = 3000;
      await prisma.dMGroup.createMany({ data: Array.from({ length: N }, (_, i) => ({ memberKey: `bulk-${i}`, createdBy: memberId, createdAt: ago(400) })) });
      const groups = await prisma.dMGroup.findMany({ where: { memberKey: { startsWith: 'bulk-' } }, select: { id: true }, orderBy: { id: 'asc' } });
      expect(groups).toHaveLength(N);
      await prisma.dMGroupMembership.createMany({ data: groups.map((g) => ({ groupId: g.id, userId: heldId, joinedAt: ago(400), leftAt: ago(200) })) });
      const kept = await prisma.directMessage.create({ data: { content: 'seen', fromUserId: memberId, groupId: groups[N - 1].id, createdAt: ago(300) } });
      const gone = await prisma.directMessage.create({ data: { content: 'after', fromUserId: memberId, groupId: groups[0].id, createdAt: ago(100) } });
      const free = await prisma.directMessage.create({ data: { content: 'free', fromUserId: memberId, toUserId: otherId, createdAt: ago(100) } });

      const r = await purgeExpiredMessages();
      expect(r.messages).toBe(2);
      expect(await dmExists(kept.id)).toBe(true);
      expect(await dmExists(gone.id)).toBe(false);
      expect(await dmExists(free.id)).toBe(false);
    });

    it('does not purge a group DM when a member of that time is put on hold after the batch was selected', async () => {
      await setWorkspace(30);
      const group = await prisma.dMGroup.create({ data: { memberKey: `g-race-${heldId}`, createdBy: memberId, createdAt: ago(300) } });
      await prisma.dMGroupMember.createMany({ data: [memberId, otherId].map((userId) => ({ groupId: group.id, userId })) });
      await prisma.dMGroupMembership.createMany({
        data: [
          ...[memberId, otherId].map((userId) => ({ groupId: group.id, userId, joinedAt: ago(300) })),
          { groupId: group.id, userId: heldId, joinedAt: ago(300), leftAt: ago(50) },
        ],
      });
      const msg = await prisma.directMessage.create({ data: { content: 'g', fromUserId: memberId, groupId: group.id, createdAt: ago(100) } });
      const free = await prisma.directMessage.create({ data: { content: 'free', fromUserId: memberId, toUserId: otherId, createdAt: ago(100) } });
      let calls = 0;
      await purgeExpiredMessages(new Date(), {
        afterSelect: async () => {
          if (calls++ === 0) await prisma.legalHold.create({ data: { name: 'late group', custodians: { create: { userId: heldId } } } });
        },
      });
      expect(calls).toBeGreaterThan(0);
      expect(await dmExists(msg.id)).toBe(true);
      expect(await dmExists(free.id)).toBe(false);
      await prisma.legalHold.deleteMany();
    });

    it('keeps a held user\'s reply and blanks (not deletes) the expired parent', async () => {
      await setWorkspace(30);
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: true } });
      const ch = await mkChannel('ret-hold-thread');
      const parent = await mkMsg(ch.id, 100);
      const reply = await prisma.message.create({ data: { content: 'held reply', userId: heldId, channelId: ch.id, threadId: parent.id, createdAt: ago(90) } });

      await purgeExpiredMessages();
      expect(await exists(reply.id)).toBe(true);
      expect((await prisma.message.findUniqueOrThrow({ where: { id: parent.id } })).content).toBe('');
    });

    // 저장소 삭제 실패 주입: 같은 이름의 비어 있지 않은 폴더는 rm이 실패한다. 폴더를 파일로 바꾸면 다음 실행에서 지워진다.
    const failBlob = (name: string) => {
      const filename = `ret-fail-${name}-${Date.now()}`;
      fs.mkdirSync(path.join(uploadDir, filename));
      fs.writeFileSync(path.join(uploadDir, filename, 'x'), 'x');
      return filename;
    };
    const healBlob = (filename: string) => {
      fs.rmSync(path.join(uploadDir, filename), { recursive: true, force: true });
      fs.writeFileSync(path.join(uploadDir, filename), 'x');
    };
    const mkBlobFile = (filename: string, messageId: number) =>
      prisma.file.create({ data: { filename, originalName: 'o.txt', mimetype: 'text/plain', size: 1, url: `/files/${filename}`, userId: memberId, messageId } });

    it('deletes the row first, queues a failed blob delete in the retry table, and removes it on the next run', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-file-fail');
      const old = await mkMsg(ch.id, 40);
      const filename = failBlob('leaf');
      const file = await mkBlobFile(filename, old.id);

      // 정리: 메시지와 파일 행은 지워지고, 본체 삭제 실패는 재시도 표에 남는다
      expect(await purgeExpiredMessages()).toMatchObject({ messages: 1, files: 1 });
      expect(await exists(old.id)).toBe(false);
      expect(await prisma.file.findUnique({ where: { id: file.id } })).toBeNull();
      const queued = await prisma.storageDeletionRetry.findMany();
      expect(queued).toHaveLength(1);
      expect(queued[0].filename).toBe(filename);

      // 다음 실행도 실패하면 시도 횟수만 오른다
      await purgeExpiredMessages();
      expect((await prisma.storageDeletionRetry.findMany())[0].attempts).toBe(2);

      // 저장소가 회복되면 다음 실행에서 본체를 지우고 표에서 뺀다
      healBlob(filename);
      await purgeExpiredMessages();
      expect(fs.existsSync(path.join(uploadDir, filename))).toBe(false);
      expect(await prisma.storageDeletionRetry.count()).toBe(0);
    });

    it('records the real failure cause in lastError without the upload path', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-file-cause');
      const old = await mkMsg(ch.id, 40);
      const filename = failBlob('cause');
      await mkBlobFile(filename, old.id);
      await purgeExpiredMessages();
      const row = (await prisma.storageDeletionRetry.findMany())[0];
      expect(row.attempts).toBe(1);
      expect(row.lastError).toMatch(/EISDIR|ERR_FS_EISDIR|directory/i);
      expect(row.lastError).not.toContain(uploadDir);
      expect(row.lastTriedAt).not.toBeNull();
      fs.rmSync(path.join(uploadDir, filename), { recursive: true, force: true });
    });

    it('drops a permanent failure (path outside the upload directory) at once instead of retrying', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-file-permanent');
      const old = await mkMsg(ch.id, 40);
      const file = await mkBlobFile('../outside.txt', old.id);
      expect(await purgeExpiredMessages()).toMatchObject({ messages: 1, files: 1 });
      expect(await prisma.file.findUnique({ where: { id: file.id } })).toBeNull();
      expect(await prisma.storageDeletionRetry.count()).toBe(0);
    });

    it('still removes the blob on the next run when the process stops after commit and before the storage delete', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-file-crash');
      const old = await mkMsg(ch.id, 40);
      const filename = `ret-crash-${Date.now()}.txt`;
      fs.writeFileSync(path.join(uploadDir, filename), 'x');
      const file = await mkBlobFile(filename, old.id);

      // 커밋 뒤 본체 삭제 전에 중단: DB 행은 지워졌고 본체는 남았으며 아웃박스 행이 있다
      await expect(
        purgeExpiredMessages(new Date(), {
          beforeBlobDelete: async () => {
            throw new Error('crash');
          },
        }),
      ).rejects.toThrow();
      expect(await exists(old.id)).toBe(false);
      expect(await prisma.file.findUnique({ where: { id: file.id } })).toBeNull();
      expect(fs.existsSync(path.join(uploadDir, filename))).toBe(true);
      expect((await prisma.storageDeletionRetry.findMany()).map((r) => r.filename)).toEqual([filename]);

      // 다음 실행이 본체를 지우고 아웃박스를 비운다
      await purgeExpiredMessages();
      expect(fs.existsSync(path.join(uploadDir, filename))).toBe(false);
      expect(await prisma.storageDeletionRetry.count()).toBe(0);
    });

    it('processes every leftover outbox row in batches and counts them against the budget', async () => {
      await prisma.storageDeletionRetry.createMany({ data: Array.from({ length: 2500 }, (_, i) => ({ filename: `ret-none-${i}.txt` })) });
      await purgeExpiredMessages();
      expect(await prisma.storageDeletionRetry.count()).toBe(0);

      // 예산(maxRows)이 모자라면 남은 만큼은 다음 실행으로 넘기고 partial로 알린다
      await prisma.storageDeletionRetry.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ filename: `ret-none-b${i}.txt` })) });
      const r = await purgeExpiredMessages(new Date(), { maxRows: 20 });
      expect(r.partial).toBe(true);
      expect(await prisma.storageDeletionRetry.count()).toBe(10);
      await purgeExpiredMessages();
      expect(await prisma.storageDeletionRetry.count()).toBe(0);
    });

    it('retries rows with fewer attempts first', async () => {
      const fresh = await prisma.storageDeletionRetry.create({ data: { filename: 'ret-order-fresh.txt', attempts: 0 } });
      const worn = await prisma.storageDeletionRetry.create({ data: { filename: 'ret-order-worn.txt', attempts: 3 } });
      await purgeExpiredMessages(new Date(), { maxRows: 1 });
      expect(await prisma.storageDeletionRetry.findUnique({ where: { id: fresh.id } })).toBeNull();
      expect(await prisma.storageDeletionRetry.findUnique({ where: { id: worn.id } })).not.toBeNull();
    });

    it('gives up after the maximum attempts and drops the retry row', async () => {
      const filename = failBlob('giveup');
      await prisma.storageDeletionRetry.create({ data: { filename, attempts: MAX_STORAGE_DELETE_ATTEMPTS - 1 } });
      await purgeExpiredMessages();
      expect(await prisma.storageDeletionRetry.count()).toBe(0);
      fs.rmSync(path.join(uploadDir, filename), { recursive: true, force: true });
    });

    it('removes the blob of a blanked parent after commit and queues it when the delete fails', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-file-parent');
      const parent = await mkMsg(ch.id, 100);
      await prisma.message.create({ data: { content: 'recent reply', userId: memberId, channelId: ch.id, threadId: parent.id, createdAt: ago(1) } });
      const ok = `ret-ok-${Date.now()}.txt`;
      fs.writeFileSync(path.join(uploadDir, ok), 'x');
      const bad = failBlob('parent');
      await mkBlobFile(ok, parent.id);
      await mkBlobFile(bad, parent.id);

      expect(await purgeExpiredMessages()).toMatchObject({ placeholders: 1, files: 2 });
      expect(await prisma.file.count({ where: { messageId: parent.id } })).toBe(0);
      expect(fs.existsSync(path.join(uploadDir, ok))).toBe(false);
      expect((await prisma.storageDeletionRetry.findMany()).map((r) => r.filename)).toEqual([bad]);
      fs.rmSync(path.join(uploadDir, bad), { recursive: true, force: true });
    });

    it('keeps the blob and the file row when a hold lands after the channel batch was selected', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-file-race');
      const old = await mkMsg(ch.id, 40);
      const parent = await mkMsg(ch.id, 100);
      await prisma.message.create({ data: { content: 'recent reply', userId: memberId, channelId: ch.id, threadId: parent.id, createdAt: ago(1) } });
      const leafName = `ret-race-leaf-${Date.now()}.txt`;
      const parentName = `ret-race-parent-${Date.now()}.txt`;
      for (const n of [leafName, parentName]) fs.writeFileSync(path.join(uploadDir, n), 'x');
      const leafFile = await mkBlobFile(leafName, old.id);
      const parentFile = await mkBlobFile(parentName, parent.id);

      let calls = 0;
      await purgeExpiredMessages(new Date(), {
        afterSelect: async () => {
          if (calls++ === 0) await prisma.legalHold.create({ data: { name: 'late channel hold', custodians: { create: { userId: memberId } } } });
        },
      });
      expect(calls).toBeGreaterThan(0);
      expect(await exists(old.id)).toBe(true);
      expect(await prisma.file.findUnique({ where: { id: leafFile.id } })).not.toBeNull();
      expect(await prisma.file.findUnique({ where: { id: parentFile.id } })).not.toBeNull();
      for (const n of [leafName, parentName]) {
        expect(fs.existsSync(path.join(uploadDir, n))).toBe(true);
        fs.rmSync(path.join(uploadDir, n), { force: true });
      }
      expect(await prisma.storageDeletionRetry.count()).toBe(0);
      await prisma.legalHold.deleteMany();
    });

    it('excludes a whole channel when a legal-hold user is a member', async () => {
      await setWorkspace(30);
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: true } });
      const heldMemberCh = await mkChannel('ret-hold-member');
      const plainCh = await mkChannel('ret-hold-plain');
      await prisma.channelMember.create({ data: { userId: heldId, channelId: heldMemberCh.id } });
      const kept = await mkMsg(heldMemberCh.id, 100); // 작성자는 hold가 아니지만 채널에 hold 멤버가 있다
      const dropped = await mkMsg(plainCh.id, 100);

      await purgeExpiredMessages();
      expect(await exists(kept.id)).toBe(true);
      expect(await exists(dropped.id)).toBe(false);
    });

    it('purges detached files (soft-deleted messages) by the workspace default, except legal-hold uploaders', async () => {
      const mk = async (name: string, ageDays: number, userId = memberId) => {
        const filename = `ret-orphan-${name}-${Date.now()}.txt`;
        fs.writeFileSync(path.join(uploadDir, filename), 'x');
        const row = await prisma.file.create({ data: { filename, originalName: `${name}.txt`, mimetype: 'text/plain', size: 1, url: `/files/${filename}`, userId, createdAt: ago(ageDays) } });
        return { filename, id: row.id };
      };
      const oldF = await mk('old', 40);
      const newF = await mk('new', 5);
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: true } });
      const heldF = await mk('held', 40, heldId);

      // 워크스페이스 기본이 무기한이면 건드리지 않는다
      await purgeExpiredMessages();
      expect(await prisma.file.count()).toBe(3);

      await setWorkspace(30);
      const r = await purgeExpiredMessages();
      expect(r.files).toBe(1);
      expect(await prisma.file.findUnique({ where: { id: oldF.id } })).toBeNull();
      expect(fs.existsSync(path.join(uploadDir, oldF.filename))).toBe(false);
      expect(await prisma.file.findUnique({ where: { id: newF.id } })).not.toBeNull();
      expect(await prisma.file.findUnique({ where: { id: heldF.id } })).not.toBeNull();
      const log = await prisma.auditLog.findFirst({ where: { action: 'retention.purged', targetType: 'file' } });
      expect(log?.details).toBe('days=30; files=1');
      for (const f of [newF, heldF]) fs.rmSync(path.join(uploadDir, f.filename), { force: true });
    });

    it('keeps a file detached from a group DM that a held user could see, until the hold is released', async () => {
      await setWorkspace(30);
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: true } });
      // held는 예전 구성원(이력만), member·other는 지금 구성원
      const group = await prisma.dMGroup.create({ data: { memberKey: `g-file-${heldId}`, createdBy: memberId, createdAt: ago(300) } });
      await prisma.dMGroupMember.createMany({ data: [memberId, otherId].map((userId) => ({ groupId: group.id, userId })) });
      await prisma.dMGroupMembership.createMany({
        data: [
          ...[memberId, otherId].map((userId) => ({ groupId: group.id, userId, joinedAt: ago(300) })),
          { groupId: group.id, userId: heldId, joinedAt: ago(300), leftAt: ago(50) },
        ],
      });
      const mkFile = async (name: string, dmId: number) => {
        const filename = `ret-gfile-${name}-${Date.now()}.txt`;
        fs.writeFileSync(path.join(uploadDir, filename), 'x');
        return prisma.file.create({ data: { filename, originalName: `${name}.txt`, mimetype: 'text/plain', size: 1, url: `/files/${filename}`, userId: memberId, dmId, createdAt: ago(100) } });
      };
      // 보존 아닌 member가 첨부를 올리고(Create) 메시지를 지운다(Delete) → 첨부가 분리된다
      const seen = await prisma.directMessage.create({ data: { content: 'seen', fromUserId: memberId, groupId: group.id, createdAt: ago(100) } });
      const unseen = await prisma.directMessage.create({ data: { content: 'unseen', fromUserId: memberId, groupId: group.id, createdAt: ago(40) } });
      const seenFile = await mkFile('seen', seen.id);
      const unseenFile = await mkFile('unseen', unseen.id);
      for (const dm of [seen, unseen]) await request(app).delete(`/dms/messages/${dm.id}`).set(auth(memberToken)).expect(200);
      expect(await prisma.file.findUniqueOrThrow({ where: { id: seenFile.id } })).toMatchObject({ dmId: null, detachedFromDmId: seen.id });

      await purgeExpiredMessages();
      expect(await prisma.file.findUnique({ where: { id: seenFile.id } })).not.toBeNull();
      expect(fs.existsSync(path.join(uploadDir, seenFile.filename))).toBe(true);
      expect(await prisma.file.findUnique({ where: { id: unseenFile.id } })).toBeNull();
      expect(fs.existsSync(path.join(uploadDir, unseenFile.filename))).toBe(false);

      // 보존을 풀면 정리된다(DM은 같은 실행에서 먼저 지워지고, 분리된 파일도 함께)
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: false } });
      await purgeExpiredMessages();
      expect(await prisma.file.findUnique({ where: { id: seenFile.id } })).toBeNull();
      expect(fs.existsSync(path.join(uploadDir, seenFile.filename))).toBe(false);
    });

    it('selects the same held users in SQL (HELD_CTE) and in Prisma (HELD_USER / NOT_HELD_USER)', async () => {
      // heldId: 플래그만, otherId: 활성 보존만, memberId: 해제된 보존만, adminId: 둘 다 없음
      await prisma.user.update({ where: { id: heldId }, data: { legalHold: true } });
      await prisma.legalHold.create({ data: { name: 'active', custodians: { create: { userId: otherId } } } });
      await prisma.legalHold.create({ data: { name: 'released', releasedAt: new Date(), custodians: { create: { userId: memberId } } } });
      const ids = [heldId, otherId, memberId, adminId];
      const sqlHeld = (await prisma.$queryRaw<Array<{ id: number }>>`WITH ${HELD_CTE} SELECT id FROM held WHERE id = ANY(${ids}::int[])`).map((r) => r.id).sort();
      const prismaHeld = (await prisma.user.findMany({ where: { id: { in: ids }, ...HELD_USER }, select: { id: true } })).map((r) => r.id).sort();
      const prismaFree = (await prisma.user.findMany({ where: { id: { in: ids }, ...NOT_HELD_USER }, select: { id: true } })).map((r) => r.id).sort();
      expect(sqlHeld).toEqual([heldId, otherId].sort());
      expect(prismaHeld).toEqual(sqlHeld);
      expect(prismaFree).toEqual([memberId, adminId].sort());
      await prisma.legalHold.deleteMany();
    });

    it('compares raw SQL times in UTC regardless of the session time zone', async () => {
      const t = new Date(Date.now() - 3 * DAY);
      const dm = await prisma.directMessage.create({ data: { content: 'tz', fromUserId: memberId, toUserId: otherId, createdAt: t } });
      const plus = (ms: number) => new Date(t.getTime() + ms);
      const deletedAt = new Date(Date.now() - DAY);
      const r = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Seoul'`;
        const count = async (cond: Prisma.Sql) =>
          (await tx.$queryRaw<Array<{ n: number }>>`SELECT COUNT(*)::int AS n FROM "DirectMessage" dm WHERE dm.id = ${dm.id} AND ${cond}`)[0].n;
        // 정리 cutoff(<), eDiscovery 기간(>=, <=)
        const cutoffAfter = await count(Prisma.sql`dm."createdAt" < ${utcTimestamp(plus(1))}`);
        const cutoffAt = await count(Prisma.sql`dm."createdAt" < ${utcTimestamp(t)}`);
        const inRange = await count(Prisma.sql`dm."createdAt" >= ${utcTimestamp(t)} AND dm."createdAt" <= ${utcTimestamp(t)}`);
        // 자리표시자 전환의 deletedAt 기록
        await tx.$executeRaw`UPDATE "DirectMessage" dm SET "deletedAt" = ${utcTimestamp(deletedAt)} WHERE dm.id = ${dm.id}`;
        return { cutoffAfter, cutoffAt, inRange };
      });
      expect(r).toEqual({ cutoffAfter: 1, cutoffAt: 0, inRange: 1 });
      expect((await prisma.directMessage.findUniqueOrThrow({ where: { id: dm.id } })).deletedAt?.getTime()).toBe(deletedAt.getTime());
    });

    it('shares one row budget: channels cannot starve DMs, and leftover work is flagged partial', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-budget');
      await prisma.message.createMany({ data: Array.from({ length: 6 }, (_, i) => ({ content: `c${i}`, userId: memberId, channelId: ch.id, createdAt: ago(60) })) });
      await prisma.directMessage.createMany({ data: Array.from({ length: 3 }, (_, i) => ({ content: `d${i}`, fromUserId: memberId, toUserId: otherId, createdAt: ago(60) })) });

      // 예산 4: 채널 2, DM 2
      const r = await purgeExpiredMessages(new Date(), { maxRows: 4 });
      expect(r.partial).toBe(true);
      expect(await prisma.message.count({ where: { channelId: ch.id } })).toBe(4);
      expect(await prisma.directMessage.count()).toBe(1);
      const chLog = await prisma.auditLog.findFirst({ where: { action: 'retention.purged', targetType: 'channel' } });
      expect(chLog?.details).toBe('days=30; messages=2; files=0; placeholders=0; partial=true');
      const dmLog = await prisma.auditLog.findFirst({ where: { action: 'retention.purged', targetType: 'direct_message' } });
      expect(dmLog?.details).toBe('days=30; messages=2; files=0; placeholders=0; partial=true');

      // 다음 실행이 이어서 끝낸다
      const r2 = await purgeExpiredMessages();
      expect(r2.partial).toBe(false);
      expect(await prisma.message.count({ where: { channelId: ch.id } })).toBe(0);
      expect(await prisma.directMessage.count()).toBe(0);
    });

    it('counts placeholder conversions against the budget', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-budget-blank');
      const parents = [];
      for (let i = 0; i < 3; i++) {
        const p = await mkMsg(ch.id, 60);
        await mkMsg(ch.id, 1, { threadId: p.id });
        parents.push(p);
      }
      const r = await purgeExpiredMessages(new Date(), { maxRows: 4 }); // 채널 몫 2
      expect(r.placeholders).toBeLessThanOrEqual(2);
      expect(r.partial).toBe(true);
      await purgeExpiredMessages();
      for (const p of parents) expect((await prisma.message.findUniqueOrThrow({ where: { id: p.id } })).content).toBe('');
    });

    it('processes more than one batch in a single run', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-bulk');
      await prisma.message.createMany({ data: Array.from({ length: 1200 }, (_, i) => ({ content: `b${i}`, userId: memberId, channelId: ch.id, createdAt: ago(60) })) });
      const keep = await mkMsg(ch.id, 1);

      expect(await purgeExpiredMessages()).toMatchObject({ messages: 1200 });
      expect(await prisma.message.count({ where: { channelId: ch.id } })).toBe(1);
      expect(await exists(keep.id)).toBe(true);
    });
  });

  describe('socket events', () => {
    let httpServer: ReturnType<typeof createServer>;
    let io: ReturnType<typeof initializeWebSocket>;
    let port: number;

    beforeAll(async () => {
      httpServer = createServer(app);
      io = initializeWebSocket(httpServer);
      port = await listenOnLoopback(httpServer);
    });
    afterAll(() => {
      io.close();
      httpServer.close();
    });

    const waitEvents = async (socket: ReturnType<typeof Client>, names: string[], ms = 1500) => {
      const got: Record<string, unknown[]> = Object.fromEntries(names.map((n) => [n, []]));
      for (const n of names) socket.on(n, (p: unknown) => got[n].push(p));
      await new Promise((r) => setTimeout(r, ms));
      return got;
    };

    it('sends the same events as the user delete path for replies, placeholder parents and DMs', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-events');
      await prisma.channelMember.createMany({ data: [{ userId: memberId, channelId: ch.id }, { userId: otherId, channelId: ch.id }] });
      const parent = await mkMsg(ch.id, 60);
      const oldReply = await mkMsg(ch.id, 50, { threadId: parent.id, userId: otherId });
      const freshReply = await mkMsg(ch.id, 1, { threadId: parent.id });
      const dm = await prisma.directMessage.create({ data: { content: 'old', fromUserId: memberId, toUserId: otherId, createdAt: ago(60) } });

      const socket = Client(`http://127.0.0.1:${port}`, { auth: { token: memberToken } });
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });
      await new Promise<boolean>((resolve) => socket.emit('join:channel', ch.id, resolve));

      const pending = waitEvents(socket, ['message:deleted', 'thread:updated', 'dm:deleted']);
      await purgeExpiredMessages();
      const got = await pending;
      socket.disconnect();

      // 답글 삭제: 실제 threadId가 실린다
      expect(got['message:deleted']).toEqual(expect.arrayContaining([
        { messageId: oldReply.id, threadId: parent.id, channelId: ch.id },
        // 자리표시자로 바뀐 부모
        { messageId: parent.id, threadId: null, channelId: ch.id },
      ]));
      // 부모별로 한 번씩, 남은 답글 수가 갱신된다
      const updates = (got['thread:updated'] as { parentId: number; replyCount: number }[]).filter((u) => u.parentId === parent.id);
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates.some((u) => u.replyCount === 1)).toBe(true);
      expect(got['dm:deleted']).toEqual([{ dmId: dm.id, fromUserId: memberId, toUserId: otherId, groupId: null, threadId: null }]);
      expect(await exists(freshReply.id)).toBe(true);
    });
  });

  describe('scheduler', () => {
    it('runs at most once a day and backs off one hour after a failure', async () => {
      await setWorkspace(30);
      const ch = await mkChannel('ret-sched');
      const old = await mkMsg(ch.id, 40);
      resetRetentionSchedule();
      const t0 = Date.now();

      const first = await purgeRetentionIfDue(t0);
      expect(first).toMatchObject({ messages: 1 });
      expect(await exists(old.id)).toBe(false);
      expect(await purgeRetentionIfDue(t0 + 60_000)).toBeNull(); // 하루 안에는 다시 돌지 않는다

      // 실패하면 1시간 뒤에 다시 시도한다
      resetRetentionSchedule();
      const spy = jest.spyOn(prisma.channel, 'findMany').mockRejectedValueOnce(new Error('db down'));
      await expect(purgeRetentionIfDue(t0)).rejects.toThrow('db down');
      spy.mockRestore();
      expect(await purgeRetentionIfDue(t0 + 30 * 60_000)).toBeNull();
      expect(await purgeRetentionIfDue(t0 + 61 * 60_000)).not.toBeNull();
      resetRetentionSchedule();
    });
  });
});
