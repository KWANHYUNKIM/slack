import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { listenOnLoopback } from './listenLoopback.js';
import { DEFAULT_WORKSPACE_ID, channelNameKey, setUserRole } from '../services/workspaceService.js';
import { joinDefaultChannels } from '../services/defaultChannelService.js';
import { FixtureUser, WorkspaceFixture, createFixtureUser, createWorkspaceFixture } from './helpers/workspaces.js';

// E1c 누출 매트릭스 1차(docs/specs/E1-multi-workspace.md 5.3, 5.4, 5.6): 채널·메시지·파일·사용자·관리·소켓.
// 워크스페이스 A 사용자가 B의 리소스를 목록에서 보지 못하고, id로 접근하면 404이며, B의 채널 이벤트를 받지 않는지 본다.
// 같은 워크스페이스 안의 비공개 채널 비멤버는 기존대로 403이다(D7). DM·검색·활동·MCP는 E1d.

async function resetDb(): Promise<void> {
  await prisma.auditLog.deleteMany();
  await prisma.inviteLink.deleteMany();
  await prisma.webhook.deleteMany();
  await prisma.reaction.deleteMany();
  await prisma.file.deleteMany();
  await prisma.message.deleteMany();
  await prisma.directMessage.deleteMany();
  await prisma.channelMember.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany({ where: { id: { not: DEFAULT_WORKSPACE_ID } } });
  await prisma.workspace.update({ where: { id: DEFAULT_WORKSPACE_ID }, data: { archivedAt: null, discoverability: 'INVITE_ONLY' } });
  await prisma.organization.update({ where: { id: 1 }, data: { primaryOwnerId: null, name: '' } });
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const inWs = (token: string, workspaceId: number) => ({ ...auth(token), 'X-Workspace-Id': String(workspaceId) });

/** 기본 워크스페이스 관리자(/admin 범위의 주인) */
async function defaultAdmin(email: string): Promise<FixtureUser> {
  const u = await createFixtureUser(email, 'Default Admin');
  await setUserRole(prisma, u.id, 'ADMIN');
  return u;
}

async function channelMessage(channelId: number, userId: number, content: string) {
  return prisma.message.create({ data: { channelId, userId, content }, select: { id: true } });
}

describe('Workspace isolation (E1c)', () => {
  let fx: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fx = await createWorkspaceFixture('iso');
  });

  // ─── 같은 이름 채널과 채널 CRUD ─────────────────────────────────

  describe('channel names are unique per workspace', () => {
    it('lets A and B both have general and shows the right one for the header', async () => {
      const inA = await request(app).get('/channels').set(inWs(fx.users.ab.token, fx.workspaceA)).expect(200);
      const inB = await request(app).get('/channels').set(inWs(fx.users.ab.token, fx.workspaceB)).expect(200);
      const generalA = inA.body.filter((c: { name: string }) => c.name === 'general');
      const generalB = inB.body.filter((c: { name: string }) => c.name === 'general');
      expect(generalA.map((c: { id: number }) => c.id)).toEqual([fx.channels.aGeneral]);
      expect(generalB.map((c: { id: number }) => c.id)).toEqual([fx.channels.bGeneral]);
      expect(generalA[0]).toMatchObject({ workspaceIds: [fx.workspaceA], isShared: false, isMember: true });

      const idsA = inA.body.map((c: { id: number }) => c.id);
      expect(idsA).toContain(fx.channels.aPublic);
      expect(idsA).not.toContain(fx.channels.bPublic);
      expect(idsA).not.toContain(fx.channels.bPrivate);
    });

    it('create -> read -> rename (conflict per workspace) -> delete, repeated in two workspaces', async () => {
      for (let round = 0; round < 2; round++) {
        // 생성: a는 A에, b는 B에 같은 이름(헤더 없이도 각자 유일한 워크스페이스로 해석된다)
        const ca = await request(app).post('/channels').set(auth(fx.users.a.token)).send({ name: 'proj' });
        const cb = await request(app).post('/channels').set(auth(fx.users.b.token)).send({ name: 'proj' });
        expect(ca.status).toBe(201);
        expect(cb.status).toBe(201);
        expect(ca.body.id).not.toBe(cb.body.id);
        const rows = await prisma.channelWorkspace.findMany({ where: { channelId: { in: [ca.body.id, cb.body.id] } }, orderBy: { channelId: 'asc' } });
        expect(rows.map((r) => [r.channelId, r.workspaceId, r.nameKey])).toEqual([
          [ca.body.id, fx.workspaceA, 'proj'],
          [cb.body.id, fx.workspaceB, 'proj'],
        ]);
        // 같은 워크스페이스에서는 대소문자만 달라도 충돌
        const dup = await request(app).post('/channels').set(auth(fx.users.ab.token)).set('X-Workspace-Id', String(fx.workspaceA)).send({ name: 'PROJ' });
        expect(dup.status).toBe(400);
        expect(dup.body.code).toBe('CHANNEL_NAME_TAKEN');

        // 조회: 각자 자기 것만, 상대 것은 404
        await request(app).get(`/channels/${ca.body.id}`).set(auth(fx.users.a.token)).expect(200);
        await request(app).get(`/channels/${cb.body.id}`).set(auth(fx.users.a.token)).expect(404);
        await request(app).get(`/channels/${ca.body.id}`).set(auth(fx.users.b.token)).expect(404);

        // 수정: A 안의 다른 이름과 겹치면 409, B에만 있는 이름은 A에서 쓸 수 있다
        const clash = await request(app).patch(`/channels/${ca.body.id}`).set(auth(fx.users.a.token)).send({ name: 'iso-a-public' });
        expect(clash.status).toBe(409);
        expect(clash.body.code).toBe('CHANNEL_NAME_TAKEN');
        const okRename = await request(app).patch(`/channels/${ca.body.id}`).set(auth(fx.users.a.token)).send({ name: 'iso-b-public' });
        expect(okRename.status).toBe(200);
        expect((await prisma.channelWorkspace.findFirst({ where: { channelId: ca.body.id } }))?.nameKey).toBe('iso-b-public');
        // 다른 워크스페이스 사람은 이름을 바꿀 수 없다(존재도 모른다)
        await request(app).patch(`/channels/${ca.body.id}`).set(auth(fx.users.b.token)).send({ name: 'hijack' }).expect(404);

        // 삭제: 마지막 멤버가 나가면 채널이 지워진다. 지운 뒤 조회는 404
        await request(app).post(`/channels/${ca.body.id}/leave`).set(auth(fx.users.a.token)).expect(200);
        await request(app).post(`/channels/${cb.body.id}/leave`).set(auth(fx.users.b.token)).expect(200);
        await request(app).get(`/channels/${ca.body.id}`).set(auth(fx.users.a.token)).expect(404);
        await request(app).get(`/channels/${cb.body.id}`).set(auth(fx.users.b.token)).expect(404);
      }
    });

    it('a workspace admin edits channels of that workspace only', async () => {
      await request(app).patch(`/channels/${fx.channels.aPublic}`).set(auth(fx.users.aAdmin.token)).send({ topic: 'by A admin' }).expect(200);
      // bOwner는 B의 OWNER지만 A 채널에는 권한이 없다(존재도 모른다)
      await request(app).patch(`/channels/${fx.channels.aPublic}`).set(auth(fx.users.bOwner.token)).send({ topic: 'x' }).expect(404);
      await request(app).patch(`/channels/${fx.channels.bPrivate}`).set(auth(fx.users.bOwner.token)).send({ topic: 'by B owner' }).expect(200);
    });
  });

  // ─── id로 접근하는 누출 매트릭스 ────────────────────────────────

  describe('cross-workspace access by id is 404', () => {
    it('channels, messages, threads, reactions, pins, files and permalinks of B are hidden from a', async () => {
      const msg = await channelMessage(fx.channels.bPublic, fx.users.b.id, 'only in B');
      const file = await prisma.file.create({
        data: { filename: 'iso.txt', originalName: 'iso.txt', mimetype: 'text/plain', size: 1, url: '/uploads/iso.txt', userId: fx.users.b.id, messageId: msg.id },
        select: { id: true },
      });
      const t = fx.users.a.token;
      const ch = fx.channels.bPublic;
      const cases: Array<[string, request.Test]> = [
        ['GET channel', request(app).get(`/channels/${ch}`).set(auth(t))],
        ['GET messages', request(app).get(`/channels/${ch}/messages`).set(auth(t))],
        ['GET members', request(app).get(`/channels/${ch}/members`).set(auth(t))],
        ['GET files', request(app).get(`/channels/${ch}/files`).set(auth(t))],
        ['GET pins', request(app).get(`/channels/${ch}/pins`).set(auth(t))],
        ['POST join', request(app).post(`/channels/${ch}/join`).set(auth(t))],
        ['PATCH channel', request(app).patch(`/channels/${ch}`).set(auth(t)).send({ topic: 'x' })],
        ['PUT star', request(app).put(`/channels/${ch}/star`).set(auth(t))],
        ['POST message', request(app).post(`/channels/${ch}/messages`).set(auth(t)).send({ content: 'x' })],
        ['POST members', request(app).post(`/channels/${ch}/members`).set(auth(t)).send({ userId: fx.users.a.id })],
        ['GET private channel', request(app).get(`/channels/${fx.channels.bPrivate}`).set(auth(t))],
        ['GET thread', request(app).get(`/messages/${msg.id}/thread`).set(auth(t))],
        ['PATCH message', request(app).patch(`/messages/${msg.id}`).set(auth(t)).send({ content: 'x' })],
        ['POST reaction', request(app).post(`/messages/${msg.id}/reactions`).set(auth(t)).send({ emoji: 'thumbsup' })],
        ['GET locate', request(app).get(`/messages/${msg.id}/locate?kind=channel`).set(auth(t))],
        ['GET file', request(app).get(`/files/${file.id}`).set(auth(t))],
      ];
      for (const [label, req] of cases) {
        const res = await req;
        expect([label, res.status]).toEqual([label, 404]);
      }
      // 없는 id와 숨긴 id는 본문까지 같다(존재 은닉)
      const pairs: Array<[string, string]> = [
        [`/channels/${ch}`, '/channels/999999'],
        [`/channels/${ch}/messages`, '/channels/999999/messages'],
        [`/users/${fx.users.b.id}`, '/users/999999'],
        [`/users/${fx.users.b.id}/presence`, '/users/999999/presence'],
      ];
      for (const [hidden, missing] of pairs) {
        const h = await request(app).get(hidden).set(auth(t));
        const m = await request(app).get(missing).set(auth(t));
        expect([hidden, h.status, h.body]).toEqual([hidden, 404, m.body]);
      }
      const putHidden = await request(app).put(`/channels/${ch}/star`).set(auth(t));
      const putMissing = await request(app).put('/channels/999999/star').set(auth(t));
      expect([putHidden.status, putHidden.body]).toEqual([404, putMissing.body]);
      // 같은 워크스페이스 사람(ab)은 공개 채널을 읽는다
      await request(app).get(`/channels/${ch}/messages`).set(inWs(fx.users.ab.token, fx.workspaceB)).expect(200);
    });

    it('keeps 403 for a private channel of the same workspace (D7)', async () => {
      const res = await request(app).put(`/channels/${fx.channels.aPrivate}/star`).set(auth(fx.users.ab.token));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_CHANNEL_MEMBER');
    });

    it('a header for a workspace the user is not in is 404, not a way in', async () => {
      const res = await request(app).get('/channels').set(inWs(fx.users.a.token, fx.workspaceB));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('WORKSPACE_NOT_FOUND');
    });

    it('a guest of A cannot join or read public channels of A they are not in, and sees nothing of B', async () => {
      await request(app).post(`/channels/${fx.channels.aPublic}/join`).set(auth(fx.users.ga.token)).expect(403);
      await request(app).get(`/channels/${fx.channels.aPublic}/messages`).set(auth(fx.users.ga.token)).expect(403);
      await request(app).post(`/channels/${fx.channels.bPublic}/join`).set(auth(fx.users.ga.token)).expect(404);
    });
  });

  // ─── 채널 멤버 추가 ───────────────────────────────────────────

  describe('adding channel members requires the channel workspace', () => {
    it('rejects a user outside the channel workspaces with USER_NOT_IN_WORKSPACE', async () => {
      const bad = await request(app).post(`/channels/${fx.channels.bPublic}/members`).set(auth(fx.users.b.token)).send({ userId: fx.users.a.id });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('USER_NOT_IN_WORKSPACE');
      // B 멤버 bOwner는 추가된다 -> 조회 -> 제거 -> 다시 조회
      await request(app).post(`/channels/${fx.channels.bPublic}/members`).set(auth(fx.users.b.token)).send({ userId: fx.users.bOwner.id }).expect(200);
      const members = await request(app).get(`/channels/${fx.channels.bPublic}/members`).set(auth(fx.users.b.token)).expect(200);
      expect(members.body.map((m: { userId: number }) => m.userId)).toContain(fx.users.bOwner.id);
      await request(app).post(`/channels/${fx.channels.bPublic}/leave`).set(auth(fx.users.bOwner.token)).expect(200);
      const after = await request(app).get(`/channels/${fx.channels.bPublic}/members`).set(auth(fx.users.b.token)).expect(200);
      expect(after.body.map((m: { userId: number }) => m.userId)).not.toContain(fx.users.bOwner.id);
    });

    it('lets a workspace admin (not a default admin) add a guest of that workspace', async () => {
      // aAdmin은 A의 ADMIN(User.role은 MEMBER). 게스트 추가 권한은 채널 워크스페이스의 역할로 본다
      const res = await request(app).post(`/channels/${fx.channels.aPublic}/members`).set(auth(fx.users.a.token)).send({ userId: fx.users.ga.id });
      expect(res.status).toBe(403);
      await prisma.channelMember.create({ data: { userId: fx.users.aAdmin.id, channelId: fx.channels.aPublic } });
      await request(app).post(`/channels/${fx.channels.aPublic}/members`).set(auth(fx.users.aAdmin.token)).send({ userId: fx.users.ga.id }).expect(200);
    });
  });

  // ─── 사용자 ─────────────────────────────────────────────────

  describe('users are scoped to shared workspaces', () => {
    it('lists only current workspace members and hides others by id unless there is DM history', async () => {
      const list = await request(app).get('/users').set(auth(fx.users.a.token)).expect(200);
      const ids = list.body.map((u: { id: number }) => u.id);
      expect(ids).toEqual(expect.arrayContaining([fx.users.a.id, fx.users.ab.id, fx.users.aAdmin.id]));
      expect(ids).not.toContain(fx.users.b.id);
      expect(ids).not.toContain(fx.users.bOwner.id);

      await request(app).get(`/users/${fx.users.b.id}`).set(auth(fx.users.a.token)).expect(404);
      await request(app).get(`/users/${fx.users.b.id}/presence`).set(auth(fx.users.a.token)).expect(404);
      await request(app).get(`/users/${fx.users.ab.id}`).set(auth(fx.users.a.token)).expect(200);
      // 조직 관리자라도 공유 워크스페이스가 없으면 일반 API에서는 보이지 않는다(스펙 5.2)
      await request(app).get(`/users/${fx.users.b.id}`).set(auth(fx.users.orgAdmin.token)).expect(404);

      // 게스트도 DM 이력이 있으면 보인다(공유 워크스페이스 여부보다 먼저 본다)
      await request(app).get(`/users/${fx.users.b.id}`).set(auth(fx.users.ga.token)).expect(404);
      const gdm = await prisma.directMessage.create({ data: { fromUserId: fx.users.ga.id, toUserId: fx.users.b.id, content: 'hi' } });
      await request(app).get(`/users/${fx.users.b.id}`).set(auth(fx.users.ga.token)).expect(200);
      await prisma.directMessage.delete({ where: { id: gdm.id } });

      // 기존 DM 대화가 있으면 계속 보인다(D3) -> 지우면 다시 404
      const dm = await prisma.directMessage.create({ data: { fromUserId: fx.users.b.id, toUserId: fx.users.a.id, content: 'hi' } });
      await request(app).get(`/users/${fx.users.b.id}`).set(auth(fx.users.a.token)).expect(200);
      await prisma.directMessage.delete({ where: { id: dm.id } });
      await request(app).get(`/users/${fx.users.b.id}`).set(auth(fx.users.a.token)).expect(404);
    });

    it('lists B members for ab only with the B header', async () => {
      const inB = await request(app).get('/users').set(inWs(fx.users.ab.token, fx.workspaceB)).expect(200);
      const ids = inB.body.map((u: { id: number }) => u.id);
      expect(ids).toContain(fx.users.b.id);
      expect(ids).not.toContain(fx.users.a.id);
    });
  });

  // ─── /admin은 기본 워크스페이스 범위 ───────────────────────────

  describe('/admin scopes', () => {
    it('hides channels, users, invites and webhooks of other workspaces (current workspace = default)', async () => {
      const admin = await defaultAdmin('iso-admin@example.com');
      const own = await request(app).post('/channels').set(auth(admin.token)).send({ name: 'general' });
      expect(own.status).toBe(201); // A·B에도 general이 있지만 기본 워크스페이스에서는 처음이다

      const channels = await request(app).get('/admin/channels').set(auth(admin.token)).expect(200);
      const channelIds = channels.body.map((c: { id: number }) => c.id);
      expect(channelIds).toContain(own.body.id);
      expect(channelIds).not.toContain(fx.channels.aGeneral);
      expect(channelIds).not.toContain(fx.channels.bPublic);

      const users = await request(app).get('/admin/users').set(auth(admin.token)).expect(200);
      const userIds = users.body.map((u: { id: number }) => u.id);
      expect(userIds).toContain(admin.id);
      expect(userIds).not.toContain(fx.users.b.id);

      for (const res of [
        await request(app).patch(`/admin/users/${fx.users.b.id}`).set(auth(admin.token)).send({ role: 'GUEST' }),
        await request(app).post(`/admin/channels/${fx.channels.bPublic}/archive`).set(auth(admin.token)),
        await request(app).patch(`/admin/channels/${fx.channels.bPublic}`).set(auth(admin.token)).send({ name: 'x' }),
        await request(app).delete(`/admin/channels/${fx.channels.bPublic}`).set(auth(admin.token)),
        await request(app).get(`/admin/channels/${fx.channels.bPublic}/members`).set(auth(admin.token)),
        await request(app).post(`/admin/channels/${fx.channels.bPublic}/members`).set(auth(admin.token)).send({ userId: admin.id }),
        await request(app).post('/webhooks').set(auth(admin.token)).send({ name: 'w', channelId: fx.channels.bPublic }),
      ]) {
        expect(res.status).toBe(404);
      }
      expect(await prisma.channel.findUnique({ where: { id: fx.channels.bPublic }, select: { archivedAt: true } })).toEqual({ archivedAt: null });
      expect((await prisma.user.findUnique({ where: { id: fx.users.b.id }, select: { role: true } }))?.role).toBe('MEMBER');

      // 기본 워크스페이스 채널에 다른 워크스페이스 사람은 넣을 수 없다
      const addB = await request(app).post(`/admin/channels/${own.body.id}/members`).set(auth(admin.token)).send({ userId: fx.users.b.id });
      expect(addB.status).toBe(400);
      expect(addB.body.code).toBe('USER_NOT_IN_WORKSPACE');

      // 초대: 다른 워크스페이스 초대는 목록에 없고 지울 수 없다
      const foreign = await prisma.inviteLink.create({ data: { code: 'iso-foreign-invite', createdBy: fx.users.bOwner.id, workspaceId: fx.workspaceB } });
      const invites = await request(app).get('/admin/invites').set(auth(admin.token)).expect(200);
      expect(invites.body.map((i: { id: number }) => i.id)).not.toContain(foreign.id);
      await request(app).delete(`/admin/invites/${foreign.id}`).set(auth(admin.token)).expect(404);
      expect(await prisma.inviteLink.findUnique({ where: { id: foreign.id } })).not.toBeNull();

      // 웹훅: B 채널의 웹훅은 목록에 없고 지울 수 없다
      const hook = await prisma.webhook.create({ data: { name: 'b-hook', channelId: fx.channels.bPublic, token: 'iso-hook-token', createdBy: fx.users.b.id } });
      const hooks = await request(app).get('/webhooks').set(auth(admin.token)).expect(200);
      expect(hooks.body.map((h: { id: number }) => h.id)).not.toContain(hook.id);
      await request(app).delete(`/webhooks/${hook.id}`).set(auth(admin.token)).expect(404);
    });

    it('refuses default workspace user management to an org admin who is not a default workspace member', async () => {
      // orgAdmin은 User.role이 ADMIN이지만 기본 워크스페이스 멤버가 아니다. 기본 워크스페이스 역할 관리는 못 한다
      const res = await request(app).get('/admin/users').set(auth(fx.users.orgAdmin.token));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ADMIN_REQUIRED');
      await request(app).patch(`/admin/users/${fx.users.a.id}`).set(auth(fx.users.orgAdmin.token)).send({ role: 'GUEST' }).expect(403);
      await request(app).get('/org/workspaces').set(auth(fx.users.orgAdmin.token)).expect(200);
    });

    it('lets an org admin manage accounts of any user in the organization (deactivate -> reactivate, sessions, force logout)', async () => {
      // b는 워크스페이스 B에만 있다. orgAdmin은 기본 워크스페이스 멤버가 아니다. 계정 단위 작업은 조직 단위다
      for (let round = 0; round < 2; round++) {
        await request(app).post(`/admin/users/${fx.users.b.id}/deactivate`).set(auth(fx.users.orgAdmin.token)).expect(200);
        expect((await prisma.user.findUnique({ where: { id: fx.users.b.id } }))?.deactivatedAt).not.toBeNull();
        await request(app).post(`/admin/users/${fx.users.b.id}/reactivate`).set(auth(fx.users.orgAdmin.token)).expect(200);
        expect((await prisma.user.findUnique({ where: { id: fx.users.b.id } }))?.deactivatedAt).toBeNull();
      }
      await request(app).get(`/admin/users/${fx.users.b.id}/sessions`).set(auth(fx.users.orgAdmin.token)).expect(200);
      await request(app).delete(`/admin/users/${fx.users.b.id}/sessions`).set(auth(fx.users.orgAdmin.token)).expect(200);
      await request(app).post(`/admin/users/${fx.users.b.id}/force-logout`).set(auth(fx.users.orgAdmin.token)).expect(200);
      // 일반 워크스페이스 관리자(bOwner, 조직 역할 MEMBER)는 계정 단위 작업을 못 한다
      await request(app).post(`/admin/users/${fx.users.b.id}/deactivate`).set(auth(fx.users.bOwner.token)).expect(403);
      // 조직 관리자라도 자기보다 높은 조직 역할은 못 건드린다
      const owner = await createFixtureUser('iso-org-owner@example.com', 'Org Owner');
      await setUserRole(prisma, owner.id, 'OWNER', { joinDefaultWorkspace: false });
      await request(app).post(`/admin/users/${owner.id}/deactivate`).set(auth(fx.users.orgAdmin.token)).expect(403);
    });

    it('lets an org owner outside the default workspace change security settings', async () => {
      const owner = await createFixtureUser('iso-org-owner2@example.com', 'Org Owner');
      await setUserRole(prisma, owner.id, 'OWNER', { joinDefaultWorkspace: false });
      await prisma.workspaceMember.create({ data: { workspaceId: fx.workspaceA, userId: owner.id, role: 'MEMBER' } });
      await request(app).get('/admin/settings/security').set(auth(owner.token)).expect(200);
      await request(app).patch('/admin/settings/security').set(auth(owner.token)).send({ allowOAuthApps: false }).expect(200);
      await request(app).patch('/admin/settings/security').set(auth(owner.token)).send({ allowOAuthApps: true }).expect(200);
      // 일반 멤버는 못 한다
      await request(app).get('/admin/settings/security').set(auth(fx.users.a.token)).expect(403);
    });

    it('a workspace OWNER manages channels, invites and webhooks of that workspace with its header, not of another', async () => {
      const h = inWs(fx.users.bOwner.token, fx.workspaceB);
      // 채널: 목록 -> 이름 변경 -> 보관 -> 보관 해제
      const list = await request(app).get('/admin/channels').set(h).expect(200);
      expect(list.body.map((c: { id: number }) => c.id)).toEqual(expect.arrayContaining([fx.channels.bPublic, fx.channels.bGeneral]));
      expect(list.body.map((c: { id: number }) => c.id)).not.toContain(fx.channels.aPublic);
      await request(app).patch(`/admin/channels/${fx.channels.bPublic}`).set(h).send({ name: 'isob-renamed' }).expect(200);
      await request(app).post(`/admin/channels/${fx.channels.bPublic}/archive`).set(h).expect(200);
      await request(app).post(`/admin/channels/${fx.channels.bPublic}/unarchive`).set(h).expect(200);
      await request(app).get(`/admin/channels/${fx.channels.aPublic}/members`).set(h).expect(404);
      // 초대: 만들기 -> 목록 -> 지우기 -> 목록에서 사라짐
      const inv = await request(app).post('/admin/invites').set(h).send({ role: 'MEMBER' }).expect(201);
      expect((await prisma.inviteLink.findUnique({ where: { id: inv.body.id } }))?.workspaceId).toBe(fx.workspaceB);
      const invites = await request(app).get('/admin/invites').set(h).expect(200);
      expect(invites.body.map((i: { id: number }) => i.id)).toEqual([inv.body.id]);
      await request(app).delete(`/admin/invites/${inv.body.id}`).set(h).expect(200);
      expect((await request(app).get('/admin/invites').set(h)).body).toEqual([]);
      // 웹훅: 만들기 -> 목록 -> 지우기
      const hook = await request(app).post('/webhooks').set(h).send({ name: 'b-hook', channelId: fx.channels.bPublic }).expect(201);
      const hooks = await request(app).get('/webhooks').set(h).expect(200);
      expect(hooks.body.map((x: { id: number }) => x.id)).toEqual([hook.body.id]);
      await request(app).post('/webhooks').set(h).send({ name: 'a-hook', channelId: fx.channels.aPublic }).expect(404);
      await request(app).delete(`/webhooks/${hook.body.id}`).set(h).expect(200);

      // ab는 B의 ADMIN, A의 MEMBER: 헤더 A로는 관리 권한이 없다(헤더 B 권한이 A로 넘어가지 않는다)
      await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: fx.workspaceB, userId: fx.users.ab.id } }, data: { role: 'ADMIN' } });
      await request(app).get('/admin/channels').set(inWs(fx.users.ab.token, fx.workspaceB)).expect(200);
      for (const res of [
        await request(app).get('/admin/channels').set(inWs(fx.users.ab.token, fx.workspaceA)),
        await request(app).get('/admin/invites').set(inWs(fx.users.ab.token, fx.workspaceA)),
        await request(app).get('/webhooks').set(inWs(fx.users.ab.token, fx.workspaceA)),
        await request(app).post(`/admin/channels/${fx.channels.aPublic}/archive`).set(inWs(fx.users.ab.token, fx.workspaceA)),
      ]) {
        expect(res.status).toBe(403);
      }
      // 기본 워크스페이스 역할(req.user.role)은 그대로다
      await request(app).get('/admin/users').set(inWs(fx.users.ab.token, fx.workspaceB)).expect(403);
    });
  });

  // ─── 워크스페이스를 떠날 때 채널 정리, 새 워크스페이스의 general ──────

  describe('workspace membership and channels', () => {
    it('leaving B drops B-only channel memberships and keeps channels still visible elsewhere', async () => {
      // aPublic을 B에도 보이게 한다(공유 API는 E1g라 행을 직접 만든다)
      await prisma.channelWorkspace.create({ data: { channelId: fx.channels.aPublic, workspaceId: fx.workspaceB, nameKey: channelNameKey('iso-a-public') } });
      await prisma.channelStar.create({ data: { userId: fx.users.ab.id, channelId: fx.channels.bPublic } });

      await request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.ab.token)).expect(200);
      const remaining = await prisma.channelMember.findMany({ where: { userId: fx.users.ab.id }, select: { channelId: true } });
      const ids = remaining.map((m) => m.channelId).sort();
      expect(ids).toEqual([fx.channels.aPublic, fx.channels.aGeneral].sort());
      expect(await prisma.channelStar.count({ where: { userId: fx.users.ab.id } })).toBe(0);
      // 다시 참여해도 지운 채널 멤버십은 저절로 돌아오지 않는다(기본 채널만 다시 가입)
      await request(app).post(`/workspaces/${fx.workspaceB}/members`).set(auth(fx.users.bOwner.token)).send({ userId: fx.users.ab.id }).expect(201);
      expect(await prisma.channelMember.findUnique({ where: { userId_channelId: { userId: fx.users.ab.id, channelId: fx.channels.bPublic } } })).toBeNull();
    });

    it('leaving deletes a private channel left with no members (same as the last member leaving), keeps archived ones', async () => {
      const make = async (name: string, archived: boolean) => {
        const res = await request(app).post('/channels').set(inWs(fx.users.ab.token, fx.workspaceB)).send({ name, isPrivate: true }).expect(201);
        if (archived) await prisma.channel.update({ where: { id: res.body.id }, data: { archivedAt: new Date() } });
        return res.body.id as number;
      };
      const solo = await make('isob-solo', false);
      const archived = await make('isob-archived', true);
      // b도 있는 비공개 채널은 남는다
      const pair = await make('isob-pair', false);
      await prisma.channelMember.create({ data: { channelId: pair, userId: fx.users.b.id } });

      await request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.ab.token)).expect(200);
      expect(await prisma.channel.findUnique({ where: { id: solo } })).toBeNull();
      expect(await prisma.channel.findUnique({ where: { id: archived } })).not.toBeNull();
      expect(await prisma.channel.findUnique({ where: { id: pair } })).not.toBeNull();
      expect(await prisma.channelMember.count({ where: { channelId: pair } })).toBe(1);
    });

    it('fills default channel slots once under concurrent sign-ups (workspace lock)', async () => {
      await prisma.channel.deleteMany({ where: { workspaceId: DEFAULT_WORKSPACE_ID } });
      const users = await Promise.all([1, 2, 3, 4, 5].map((i) => createFixtureUser(`iso-race${i}@example.com`, `Race ${i}`)));
      const results = await Promise.all(users.map((u) => joinDefaultChannels(prisma, u.id)));
      const generals = await prisma.channel.findMany({ where: { workspaceId: DEFAULT_WORKSPACE_ID, name: 'general' }, select: { id: true } });
      const randoms = await prisma.channel.findMany({ where: { workspaceId: DEFAULT_WORKSPACE_ID, name: 'random' }, select: { id: true } });
      expect(generals).toHaveLength(1);
      expect(randoms).toHaveLength(1);
      // 호스트 행이 없는 채널(경쟁에서 생긴 고아)이 없고, 모두 같은 두 채널에 들어갔다
      expect(await prisma.channel.count({ where: { workspaces: { none: {} } } })).toBe(0);
      for (const ids of results) expect([...ids].sort()).toEqual([generals[0].id, randoms[0].id].sort());
      // 사용자가 같은 이름으로 동시에 만들어도 워크스페이스 안에서는 하나만 생긴다
      const admin = await defaultAdmin('iso-race-admin@example.com');
      const creates = await Promise.all([1, 2, 3].map(() => request(app).post('/channels').set(auth(admin.token)).send({ name: 'race-room' })));
      expect(creates.map((r) => r.status).sort()).toEqual([201, 400, 400]);
    });

    it('POST /org/workspaces creates a default general channel with the creator in it', async () => {
      const res = await request(app).post('/org/workspaces').set(auth(fx.users.orgAdmin.token)).send({ slug: 'iso-c', name: 'iso C' });
      expect(res.status).toBe(201);
      const row = await prisma.channelWorkspace.findUnique({
        where: { workspaceId_nameKey: { workspaceId: res.body.id, nameKey: 'general' } },
        include: { channel: { select: { id: true, name: true, isPrivate: true, workspaceId: true } } },
      });
      expect(row).toMatchObject({ isDefault: true, defaultSlot: 'general', channel: { name: 'general', isPrivate: false, workspaceId: res.body.id } });
      expect(await prisma.channelMember.findUnique({ where: { userId_channelId: { userId: fx.users.orgAdmin.id, channelId: row!.channelId } } })).not.toBeNull();
      // 그 워크스페이스에 배정된 사람도 general에 들어간다
      await request(app).post(`/workspaces/${res.body.id}/members`).set(auth(fx.users.orgAdmin.token)).send({ userId: fx.users.a.id }).expect(201);
      expect(await prisma.channelMember.findUnique({ where: { userId_channelId: { userId: fx.users.a.id, channelId: row!.channelId } } })).not.toBeNull();
      expect(await prisma.channel.count({ where: { name: 'general' } })).toBe(3);
    });
  });
});

// ─── 소켓: 채널 이벤트가 다른 워크스페이스로 새지 않는다 ─────────────

describe('Channel events stay in their workspace (E1c)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  let fx: WorkspaceFixture;
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    port = await listenOnLoopback(httpServer);
  });

  afterAll(async () => {
    io.close();
    httpServer.close();
  });

  beforeEach(async () => {
    await resetDb();
    fx = await createWorkspaceFixture('isy');
  });

  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  function connect(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = Client(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'] });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  function record(s: ClientSocket, event: string): unknown[] {
    const got: unknown[] = [];
    s.on(event, (p: unknown) => got.push(p));
    return got;
  }

  function next(s: ClientSocket, event: string): Promise<any> {
    return new Promise((resolve) => s.once(event, resolve));
  }

  it('channel:updated for a public channel goes to its workspace room with workspaceIds', async () => {
    const a = await connect(fx.users.a.token);
    const b = await connect(fx.users.b.token);
    const bGot = record(b, 'channel:updated');
    const aNext = next(a, 'channel:updated');
    await request(app).patch(`/channels/${fx.channels.aPublic}`).set(auth(fx.users.aAdmin.token)).send({ topic: 'A only' }).expect(200);
    expect(await aNext).toMatchObject({ id: fx.channels.aPublic, topic: 'A only', workspaceIds: [fx.workspaceA] });
    // b가 받을 이벤트였다면 a와 같은 시점에 왔다. B 채널을 한 번 바꿔 순서를 맞춘 뒤 확인한다
    const bNext = next(b, 'channel:updated');
    await request(app).patch(`/channels/${fx.channels.bPublic}`).set(auth(fx.users.bOwner.token)).send({ topic: 'B only' }).expect(200);
    expect(await bNext).toMatchObject({ id: fx.channels.bPublic, workspaceIds: [fx.workspaceB] });
    expect(bGot.map((p) => (p as { id: number }).id)).toEqual([fx.channels.bPublic]);
  });

  it('a member of both workspaces gets one event per change; private updates reach members only', async () => {
    const ab = await connect(fx.users.ab.token);
    const bOwner = await connect(fx.users.bOwner.token);
    const abGot = record(ab, 'channel:updated');
    const ownerGot = record(bOwner, 'channel:updated');
    // 공유 채널처럼 A와 B 양쪽에 보이게 한다(E1g 전이라 행을 직접 만든다)
    await prisma.channelWorkspace.create({ data: { channelId: fx.channels.aPublic, workspaceId: fx.workspaceB, nameKey: 'isy-a-public' } });
    const ownerNext = next(bOwner, 'channel:updated');
    await request(app).patch(`/channels/${fx.channels.aPublic}`).set(auth(fx.users.aAdmin.token)).send({ topic: 'shared' }).expect(200);
    expect(await ownerNext).toMatchObject({ id: fx.channels.aPublic, workspaceIds: [fx.workspaceA, fx.workspaceB] });

    // 비공개 B 채널은 멤버(b)에게만. bOwner는 B 사람이어도 멤버가 아니라 받지 않는다
    const b = await connect(fx.users.b.token);
    const bNext = next(b, 'channel:updated');
    await request(app).patch(`/channels/${fx.channels.bPrivate}`).set(auth(fx.users.b.token)).send({ topic: 'secret' }).expect(403);
    await prisma.channelMember.update({ where: { userId_channelId: { userId: fx.users.b.id, channelId: fx.channels.bPrivate } }, data: { role: 'OWNER' } });
    await request(app).patch(`/channels/${fx.channels.bPrivate}`).set(auth(fx.users.b.token)).send({ topic: 'secret' }).expect(200);
    expect(await bNext).toMatchObject({ id: fx.channels.bPrivate });
    // 순서 맞추기: 공개 B 채널 변경을 모두가 받은 뒤 확인한다
    const abNext = next(ab, 'channel:updated');
    const ownerNext2 = next(bOwner, 'channel:updated');
    await request(app).patch(`/channels/${fx.channels.bPublic}`).set(auth(fx.users.bOwner.token)).send({ topic: 'sync' }).expect(200);
    await Promise.all([abNext, ownerNext2]);
    expect(abGot.map((p) => (p as { id: number }).id)).toEqual([fx.channels.aPublic, fx.channels.bPublic]);
    expect(ownerGot.map((p) => (p as { id: number }).id)).toEqual([fx.channels.aPublic, fx.channels.bPublic]);
  });

  it('public channel events skip guests of the workspace who are not in the channel', async () => {
    const a = await connect(fx.users.a.token);
    const ga = await connect(fx.users.ga.token);
    const gaGot = record(ga, 'channel:updated');
    const aNext = next(a, 'channel:updated');
    await request(app).patch(`/channels/${fx.channels.aPublic}`).set(auth(fx.users.aAdmin.token)).send({ topic: 'members only' }).expect(200);
    await aNext;
    // 게스트가 채널 멤버가 되면 받는다. 그 전에 받은 것이 없어야 한다
    await prisma.channelMember.create({ data: { channelId: fx.channels.aPublic, userId: fx.users.ga.id } });
    const gaNext = next(ga, 'channel:updated');
    await request(app).patch(`/channels/${fx.channels.aPublic}`).set(auth(fx.users.aAdmin.token)).send({ topic: 'guest member too' }).expect(200);
    expect(await gaNext).toMatchObject({ topic: 'guest member too' });
    expect(gaGot.map((p) => (p as { topic: string }).topic)).toEqual(['guest member too']);
  });

  it('a role change moves the socket in and out of the non-guest room', async () => {
    const ga = await connect(fx.users.ga.token);
    const room = `ws:${fx.workspaceA}:members`;
    const before = io.sockets.adapter.rooms.get(room)?.size ?? 0;
    const promoted = next(ga, 'workspace:member:updated');
    await request(app).patch(`/workspaces/${fx.workspaceA}/members/${fx.users.ga.id}`).set(auth(fx.users.aAdmin.token)).send({ role: 'MEMBER' }).expect(200);
    await promoted;
    expect(io.sockets.adapter.rooms.get(room)?.size).toBe(before + 1);
    const demoted = next(ga, 'workspace:member:updated');
    await request(app).patch(`/workspaces/${fx.workspaceA}/members/${fx.users.ga.id}`).set(auth(fx.users.aAdmin.token)).send({ role: 'GUEST' }).expect(200);
    await demoted;
    expect(io.sockets.adapter.rooms.get(room)?.size ?? 0).toBe(before);
  });

  it('leaving deletes an orphaned private channel and tells the leaver with channel:deleted', async () => {
    const created = await request(app).post('/channels').set(inWs(fx.users.ab.token, fx.workspaceB)).send({ name: 'isy-solo', isPrivate: true }).expect(201);
    const ab = await connect(fx.users.ab.token);
    const deleted = next(ab, 'channel:deleted');
    await request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.ab.token)).expect(200);
    expect(await deleted).toEqual({ channelId: created.body.id, workspaceIds: [fx.workspaceB] });
  });

  it('archive, unarchive and delete events from /admin do not reach other workspaces', async () => {
    const admin = await defaultAdmin('isy-admin@example.com');
    const created = await request(app).post('/channels').set(auth(admin.token)).send({ name: 'general' }).expect(201);
    const channelId = created.body.id as number;
    const adminSock = await connect(admin.token);
    const a = await connect(fx.users.a.token);
    const aGot: unknown[] = [];
    for (const e of ['channel:archived', 'channel:unarchived', 'channel:deleted']) a.on(e, (p: unknown) => aGot.push([e, p]));

    for (const [path, event] of [['archive', 'channel:archived'], ['unarchive', 'channel:unarchived']] as const) {
      const got = next(adminSock, event);
      await request(app).post(`/admin/channels/${channelId}/${path}`).set(auth(admin.token)).expect(200);
      expect(await got).toMatchObject({ channelId, name: 'general', workspaceIds: [DEFAULT_WORKSPACE_ID] });
    }
    const deleted = next(adminSock, 'channel:deleted');
    await request(app).delete(`/admin/channels/${channelId}`).set(auth(admin.token)).expect(200);
    expect(await deleted).toEqual({ channelId, workspaceIds: [DEFAULT_WORKSPACE_ID] });

    // 순서 맞추기: a에게 가는 이벤트를 하나 보낸 뒤 그 전에 받은 것이 없는지 본다
    const aSync = next(a, 'channel:updated');
    await request(app).patch(`/channels/${fx.channels.aPublic}`).set(auth(fx.users.aAdmin.token)).send({ topic: 'sync' }).expect(200);
    await aSync;
    expect(aGot).toEqual([]);
  });

  it('leaving a workspace removes the user from B-only channel rooms', async () => {
    const ab = await connect(fx.users.ab.token);
    await new Promise<void>((resolve) => ab.emit('join:channel', fx.channels.bPublic, () => resolve()));
    expect(io.sockets.adapter.rooms.get(`channel:${fx.channels.bPublic}`)?.size).toBe(1);
    const b = await connect(fx.users.b.token);
    await new Promise<void>((resolve) => b.emit('join:channel', fx.channels.bPublic, () => resolve()));
    const left = next(b, 'channel:member-left');
    await request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.ab.token)).expect(200);
    expect(await left).toMatchObject({ channelId: fx.channels.bPublic, userId: fx.users.ab.id });
    expect(io.sockets.adapter.rooms.get(`channel:${fx.channels.bPublic}`)?.size).toBe(1);
  });
});
