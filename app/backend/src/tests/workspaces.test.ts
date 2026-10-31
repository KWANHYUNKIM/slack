import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { listenOnLoopback } from './listenLoopback.js';
import { DEFAULT_WORKSPACE_ID, setUserRole } from '../services/workspaceService.js';
import { WorkspaceFixture, addFixtureMember, createFixtureUser, createWorkspaceFixture } from './helpers/workspaces.js';

// E1b: 현재 워크스페이스 해석(X-Workspace-Id), 호환 심, 워크스페이스·멤버 CRUD, 초대 수락, ws:<id> room과 workspace:* 이벤트.
// 각 테스트는 새 픽스처(워크스페이스 A·B, 사용자 a·b·ab·orgAdmin·ga·aAdmin·bOwner)로 시작한다.

async function resetDb(): Promise<void> {
  await prisma.auditLog.deleteMany();
  await prisma.inviteLink.deleteMany();
  await prisma.message.deleteMany();
  await prisma.channelMember.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.user.deleteMany();
  await prisma.workspace.deleteMany({ where: { id: { not: DEFAULT_WORKSPACE_ID } } });
  await prisma.workspace.update({ where: { id: DEFAULT_WORKSPACE_ID }, data: { archivedAt: null, discoverability: 'INVITE_ONLY' } });
  await prisma.organization.update({ where: { id: 1 }, data: { primaryOwnerId: null, name: '' } });
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('Workspaces (E1b)', () => {
  let fx: WorkspaceFixture;

  beforeEach(async () => {
    await resetDb();
    fx = await createWorkspaceFixture('wsx');
  });

  // ─── 현재 워크스페이스 해석 ────────────────────────────────────

  describe('X-Workspace-Id resolution', () => {
    it('uses the first joined workspace when there is no header and echoes it', async () => {
      const res = await request(app).get('/users').set(auth(fx.users.a.token));
      expect(res.status).toBe(200);
      expect(res.headers['x-workspace-id']).toBe(String(fx.workspaceA));
    });

    it('prefers defaultWorkspaceId and follows PUT /users/me/default-workspace', async () => {
      const put = await request(app).put('/users/me/default-workspace').set(auth(fx.users.ab.token)).send({ workspaceId: fx.workspaceB });
      expect(put.status).toBe(200);
      expect(put.body.defaultWorkspaceId).toBe(fx.workspaceB);
      const res = await request(app).get('/users').set(auth(fx.users.ab.token));
      expect(res.headers['x-workspace-id']).toBe(String(fx.workspaceB));

      // 멤버가 아닌 워크스페이스는 기억하지 않는다
      const bad = await request(app).put('/users/me/default-workspace').set(auth(fx.users.a.token)).send({ workspaceId: fx.workspaceB });
      expect(bad.status).toBe(404);
      expect(bad.body.code).toBe('WORKSPACE_NOT_FOUND');
    });

    it('accepts a header for a workspace the user belongs to', async () => {
      const res = await request(app).get('/users').set(auth(fx.users.ab.token)).set('X-Workspace-Id', String(fx.workspaceB));
      expect(res.status).toBe(200);
      expect(res.headers['x-workspace-id']).toBe(String(fx.workspaceB));
    });

    it('hides other, missing and archived workspaces with 404 and rejects malformed ids with 400', async () => {
      const other = await request(app).get('/users').set(auth(fx.users.a.token)).set('X-Workspace-Id', String(fx.workspaceB));
      expect(other.status).toBe(404);
      expect(other.body.code).toBe('WORKSPACE_NOT_FOUND');

      const missing = await request(app).get('/users').set(auth(fx.users.a.token)).set('X-Workspace-Id', '999999');
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('WORKSPACE_NOT_FOUND');

      for (const bad of ['abc', '1.5', '-1', '0', '99999999999']) {
        const res = await request(app).get('/users').set(auth(fx.users.a.token)).set('X-Workspace-Id', bad);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_WORKSPACE_ID');
      }

      await prisma.workspace.update({ where: { id: fx.workspaceB }, data: { archivedAt: new Date() } });
      const archived = await request(app).get('/users').set(auth(fx.users.ab.token)).set('X-Workspace-Id', String(fx.workspaceB));
      expect(archived.status).toBe(404);
    });

    it('returns 403 NO_WORKSPACE when the user has no active workspace, but account paths still work', async () => {
      await prisma.workspaceMember.updateMany({ where: { userId: fx.users.a.id }, data: { leftAt: new Date() } });
      const res = await request(app).get('/users').set(auth(fx.users.a.token));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NO_WORKSPACE');

      const me = await request(app).get('/users/me').set(auth(fx.users.a.token));
      expect(me.status).toBe(200);
      expect(me.body.workspaces).toEqual([]);
      const list = await request(app).get('/workspaces').set(auth(fx.users.a.token));
      expect(list.status).toBe(200);
      expect(list.body.workspaces).toEqual([]);
    });

    it('treats users without any membership row as implicit members of the default workspace', async () => {
      const legacy = await createFixtureUser('wsx-legacy@example.com', 'Legacy');
      const res = await request(app).get('/users').set(auth(legacy.token));
      expect(res.status).toBe(200);
      expect(res.headers['x-workspace-id']).toBe(String(DEFAULT_WORKSPACE_ID));
    });
  });

  // ─── 호환 심 ──────────────────────────────────────────────────

  describe('existing routes keep the default workspace role (no escalation through the header)', () => {
    it('a workspace ADMIN elsewhere is not an /admin admin with that header', async () => {
      // ab는 A의 MEMBER, B의 ADMIN. /admin은 아직 워크스페이스 범위가 없어 User.role(MEMBER)로 판단한다
      await addFixtureMember(fx.workspaceB, fx.users.ab.id, 'ADMIN');
      const inB = await request(app).get('/admin/users').set(auth(fx.users.ab.token)).set('X-Workspace-Id', String(fx.workspaceB));
      expect(inB.status).toBe(403);
    });

    it('a workspace OWNER elsewhere cannot transfer ownership or promote with that header', async () => {
      // bOwner: 기본 워크스페이스 ADMIN, 워크스페이스 B OWNER
      await setUserRole(prisma, fx.users.bOwner.id, 'ADMIN');
      const headers = { ...auth(fx.users.bOwner.token), 'X-Workspace-Id': String(fx.workspaceB) };
      const transfer = await request(app).post('/admin/transfer-ownership').set(headers).send({ userId: fx.users.b.id });
      expect(transfer.status).toBe(403);
      const promote = await request(app).patch(`/admin/users/${fx.users.b.id}`).set(headers).send({ role: 'ADMIN' });
      expect(promote.status).toBe(403);
      expect((await prisma.user.findUnique({ where: { id: fx.users.b.id }, select: { role: true } }))?.role).toBe('MEMBER');
      // 새 API에서는 B의 OWNER 권한이 그대로 쓰인다
      const wsPromote = await request(app).patch(`/workspaces/${fx.workspaceB}/members/${fx.users.b.id}`).set(auth(fx.users.bOwner.token)).send({ role: 'ADMIN' });
      expect(wsPromote.status).toBe(200);
    });

    it('a default workspace GUEST stays guest-scoped in GET /users even with a header for a workspace where they are MEMBER', async () => {
      const g = await createFixtureUser('wsx-guest@example.com', 'Guest');
      await setUserRole(prisma, g.id, 'GUEST');
      await addFixtureMember(fx.workspaceB, g.id, 'MEMBER');
      const res = await request(app).get('/users').set(auth(g.token)).set('X-Workspace-Id', String(fx.workspaceB));
      expect(res.status).toBe(200);
      const ids = res.body.map((u: { id: number }) => u.id);
      expect(ids).not.toContain(fx.users.b.id);
      expect(ids).not.toContain(fx.users.bOwner.id);
    });

    it('keeps User.role as the default workspace role (legacy users and direct prisma promotions)', async () => {
      const reg = await request(app).post('/auth/register').send({ email: 'wsx-reg@example.com', password: TEST_PASSWORD, name: 'Reg' });
      expect(reg.status).toBe(201);
      const memberRes = await request(app).get('/admin/users').set(auth(reg.body.token));
      expect(memberRes.status).toBe(403);
      // 기존 테스트처럼 User.role만 바꿔도 기본 워크스페이스에서 관리자다
      await prisma.user.update({ where: { id: reg.body.user.id }, data: { role: 'ADMIN' } });
      const adminRes = await request(app).get('/admin/users').set(auth(reg.body.token));
      expect(adminRes.status).toBe(200);
      expect(adminRes.headers['x-workspace-id']).toBe(String(DEFAULT_WORKSPACE_ID));
    });
  });

  // ─── 로그인·내 정보 응답 ─────────────────────────────────────

  describe('login and /users/me', () => {
    it('include organization, orgRole, workspaces and defaultWorkspaceId', async () => {
      const reg = await request(app).post('/auth/register').send({ email: 'wsx-login@example.com', password: TEST_PASSWORD, name: 'Login' });
      const login = await request(app).post('/auth/login').send({ email: 'wsx-login@example.com', password: TEST_PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.user.role).toBe('MEMBER');
      expect(login.body.user.orgRole).toBe('MEMBER');
      expect(login.body.user.organization).toEqual({ id: 1, name: '' });
      expect(login.body.user.defaultWorkspaceId).toBe(DEFAULT_WORKSPACE_ID);
      expect(login.body.user.workspaces).toEqual([expect.objectContaining({ id: DEFAULT_WORKSPACE_ID, slug: 'main', role: 'MEMBER' })]);

      const me = await request(app).get('/users/me').set(auth(reg.body.token));
      expect(me.body.workspaces.map((w: { id: number }) => w.id)).toEqual([DEFAULT_WORKSPACE_ID]);
      expect(me.body.orgRole).toBe('MEMBER');
    });

    it('GET /workspaces lists active workspaces with role in join order', async () => {
      const res = await request(app).get('/workspaces').set(auth(fx.users.ab.token));
      expect(res.status).toBe(200);
      expect(res.body.workspaces.map((w: { id: number; role: string }) => [w.id, w.role])).toEqual([
        [fx.workspaceA, 'MEMBER'], [fx.workspaceB, 'MEMBER'],
      ]);
    });
  });

  // ─── 조직: 워크스페이스 CRUD ─────────────────────────────────

  describe('org workspace CRUD', () => {
    it('create -> read -> update -> archive -> 404 -> unarchive, repeated', async () => {
      const admin = fx.users.orgAdmin.token;
      for (let round = 0; round < 2; round++) {
        const slug = `wsx-c${round}`;
        // Create
        const created = await request(app).post('/org/workspaces').set(auth(admin))
          .send({ slug, name: `Created ${round}`, discoverability: 'OPEN' });
        expect(created.status).toBe(201);
        const id = created.body.id as number;
        expect(created.body).toMatchObject({ slug, name: `Created ${round}`, discoverability: 'OPEN', memberCount: 1 });

        // Read: 조직 목록, 만든 사람의 목록(OWNER), 단건
        const list = await request(app).get('/org/workspaces').set(auth(admin));
        expect(list.body.workspaces.find((w: { id: number }) => w.id === id)).toMatchObject({ memberCount: 1, archivedAt: null });
        const mine = await request(app).get('/workspaces').set(auth(admin));
        expect(mine.body.workspaces.find((w: { id: number }) => w.id === id)).toMatchObject({ role: 'OWNER' });
        const one = await request(app).get(`/workspaces/${id}`).set(auth(admin));
        expect(one.status).toBe(200);
        expect(one.body.role).toBe('OWNER');

        // Update
        const updated = await request(app).patch(`/org/workspaces/${id}`).set(auth(admin))
          .send({ name: `Renamed ${round}`, discoverability: 'INVITE_ONLY', description: 'desc' });
        expect(updated.status).toBe(200);
        expect(updated.body).toMatchObject({ name: `Renamed ${round}`, discoverability: 'INVITE_ONLY', description: 'desc' });

        // Delete(보관): 이후 그 워크스페이스 API는 404
        const archived = await request(app).post(`/org/workspaces/${id}/archive`).set(auth(admin));
        expect(archived.status).toBe(200);
        expect(archived.body.archivedAt).not.toBeNull();
        expect((await request(app).get(`/workspaces/${id}`).set(auth(admin))).status).toBe(404);
        expect((await request(app).get('/users').set(auth(admin)).set('X-Workspace-Id', String(id))).status).toBe(404);
        expect((await request(app).get(`/workspaces/${id}/members`).set(auth(admin))).status).toBe(404);
        const listAfter = await request(app).get('/org/workspaces').set(auth(admin));
        expect(listAfter.body.workspaces.find((w: { id: number }) => w.id === id).archivedAt).not.toBeNull();

        // 보관 해제하면 다시 보인다
        const unarchived = await request(app).post(`/org/workspaces/${id}/unarchive`).set(auth(admin));
        expect(unarchived.status).toBe(200);
        expect((await request(app).get(`/workspaces/${id}`).set(auth(admin))).status).toBe(200);
        await request(app).post(`/org/workspaces/${id}/archive`).set(auth(admin));
      }
      const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map((l) => l.action);
      expect(actions).toEqual(expect.arrayContaining(['workspace.created', 'workspace.updated', 'workspace.archived', 'workspace.unarchived']));
    });

    it('validates slug and rejects duplicate slug or name (case-insensitive)', async () => {
      const admin = auth(fx.users.orgAdmin.token);
      for (const slug of ['Bad Slug', '-x', 'x-', 'a'.repeat(22), '한글']) {
        const res = await request(app).post('/org/workspaces').set(admin).send({ slug, name: `n ${slug}` });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_WORKSPACE_SLUG');
      }
      const dupSlug = await request(app).post('/org/workspaces').set(admin).send({ slug: 'wsx-a', name: 'Other' });
      expect(dupSlug.status).toBe(409);
      expect(dupSlug.body.code).toBe('WORKSPACE_SLUG_TAKEN');
      const dupName = await request(app).post('/org/workspaces').set(admin).send({ slug: 'wsx-new', name: 'WSX a' });
      expect(dupName.status).toBe(409);
      expect(dupName.body.code).toBe('WORKSPACE_NAME_TAKEN');
      const rename = await request(app).patch(`/org/workspaces/${fx.workspaceA}`).set(admin).send({ slug: 'wsx-b' });
      expect(rename.status).toBe(409);
      expect(rename.body.code).toBe('WORKSPACE_SLUG_TAKEN');
    });

    it('denies non org admins and lets a workspace owner edit only their workspace', async () => {
      const create = await request(app).post('/org/workspaces').set(auth(fx.users.aAdmin.token)).send({ slug: 'wsx-x', name: 'X' });
      expect(create.status).toBe(403);
      expect(create.body.code).toBe('ORG_ADMIN_REQUIRED');
      expect((await request(app).get('/org/workspaces').set(auth(fx.users.a.token))).status).toBe(403);
      expect((await request(app).get('/org').set(auth(fx.users.a.token))).status).toBe(403);

      // B의 OWNER는 B를 고칠 수 있지만 보관은 못 하고, A는 존재도 모른다
      const own = await request(app).patch(`/org/workspaces/${fx.workspaceB}`).set(auth(fx.users.bOwner.token)).send({ name: 'B renamed' });
      expect(own.status).toBe(200);
      const archive = await request(app).post(`/org/workspaces/${fx.workspaceB}/archive`).set(auth(fx.users.bOwner.token));
      expect(archive.status).toBe(403);
      const other = await request(app).patch(`/org/workspaces/${fx.workspaceA}`).set(auth(fx.users.bOwner.token)).send({ name: 'nope' });
      expect(other.status).toBe(404);
      // A의 ADMIN(OWNER 아님)은 고칠 수 없다
      const notOwner = await request(app).patch(`/org/workspaces/${fx.workspaceA}`).set(auth(fx.users.aAdmin.token)).send({ name: 'nope' });
      expect(notOwner.status).toBe(403);
    });

    it('refuses to archive the default workspace and the last active workspace', async () => {
      const admin = auth(fx.users.orgAdmin.token);
      const def = await request(app).post(`/org/workspaces/${DEFAULT_WORKSPACE_ID}/archive`).set(admin);
      expect(def.status).toBe(409);
      expect(def.body.code).toBe('DEFAULT_WORKSPACE_ARCHIVE_FORBIDDEN');
      expect((await prisma.workspace.findUnique({ where: { id: DEFAULT_WORKSPACE_ID } }))?.archivedAt).toBeNull();

      // 기본 워크스페이스가 (데이터로) 보관된 상태에서만 닿는 가드
      await prisma.workspace.update({ where: { id: DEFAULT_WORKSPACE_ID }, data: { archivedAt: new Date() } });
      await request(app).post(`/org/workspaces/${fx.workspaceB}/archive`).set(admin).expect(200);
      const last = await request(app).post(`/org/workspaces/${fx.workspaceA}/archive`).set(admin);
      expect(last.status).toBe(409);
      expect(last.body.code).toBe('LAST_WORKSPACE');
    });

    it('counts active members per workspace including implicit default workspace members', async () => {
      const admin = auth(fx.users.orgAdmin.token);
      const legacy = await createFixtureUser('wsx-count@example.com', 'Count');
      const gone = await createFixtureUser('wsx-gone@example.com', 'Gone');
      await prisma.user.update({ where: { id: gone.id }, data: { deactivatedAt: new Date() } });
      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: fx.workspaceA, userId: fx.users.a.id } }, data: { leftAt: new Date() },
      });
      const res = await request(app).get('/org/workspaces').set(admin);
      const count = (id: number) => res.body.workspaces.find((w: { id: number }) => w.id === id).memberCount;
      // A: ab, orgAdmin, ga, aAdmin(a는 나감). B: b, ab, bOwner. 기본: 행 없는 legacy만(gone은 비활성)
      expect(count(fx.workspaceA)).toBe(4);
      expect(count(fx.workspaceB)).toBe(3);
      expect(count(DEFAULT_WORKSPACE_ID)).toBe(1);
      expect(legacy.id).toBeGreaterThan(0);
    });

    it('GET /org shows the organization, PATCH /org needs an org owner, GET /org/users lists teams', async () => {
      const get = await request(app).get('/org').set(auth(fx.users.orgAdmin.token));
      expect(get.status).toBe(200);
      expect(get.body.id).toBe(1);
      const denied = await request(app).patch('/org').set(auth(fx.users.orgAdmin.token)).send({ name: 'Acme' });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('ORG_OWNER_REQUIRED');

      await setUserRole(prisma, fx.users.orgAdmin.id, 'OWNER', { joinDefaultWorkspace: false });
      const ok = await request(app).patch('/org').set(auth(fx.users.orgAdmin.token)).send({ name: 'Acme' });
      expect(ok.status).toBe(200);
      expect(ok.body.name).toBe('Acme');

      const users = await request(app).get('/org/users').set(auth(fx.users.orgAdmin.token));
      expect(users.status).toBe(200);
      const ab = users.body.items.find((u: { id: number }) => u.id === fx.users.ab.id);
      expect(ab.teams).toEqual([{ workspaceId: fx.workspaceA, role: 'MEMBER' }, { workspaceId: fx.workspaceB, role: 'MEMBER' }]);
    });
  });

  // ─── 멤버 CRUD ───────────────────────────────────────────────

  describe('workspace member CRUD', () => {
    it('assign -> list -> change role -> remove -> re-assign, repeated, with audit logs', async () => {
      const admin = auth(fx.users.aAdmin.token);
      const target = fx.users.b.id;
      for (let round = 0; round < 2; round++) {
        // Create(D9: 워크스페이스 관리자가 조직 사용자를 직접 배정)
        const add = await request(app).post(`/workspaces/${fx.workspaceA}/members`).set(admin)
          .send({ userId: target, channelIds: [fx.channels.aPublic] });
        expect(add.status).toBe(201);
        expect(add.body).toEqual({ workspaceId: fx.workspaceA, userId: target, role: 'MEMBER' });
        expect(await prisma.channelMember.findUnique({ where: { userId_channelId: { userId: target, channelId: fx.channels.aPublic } } })).not.toBeNull();

        // Read
        const list = await request(app).get(`/workspaces/${fx.workspaceA}/members`).set(admin);
        expect(list.status).toBe(200);
        expect(list.body.items.find((u: { id: number }) => u.id === target)).toMatchObject({ role: 'MEMBER' });
        // 배정된 사용자는 헤더로 A를 쓸 수 있다
        expect((await request(app).get('/users').set(auth(fx.users.b.token)).set('X-Workspace-Id', String(fx.workspaceA))).status).toBe(200);

        // Update
        const patch = await request(app).patch(`/workspaces/${fx.workspaceA}/members/${target}`).set(admin).send({ role: 'GUEST' });
        expect(patch.status).toBe(200);
        expect(patch.body.role).toBe('GUEST');
        const listAfter = await request(app).get(`/workspaces/${fx.workspaceA}/members`).set(admin);
        expect(listAfter.body.items.find((u: { id: number }) => u.id === target).role).toBe('GUEST');
        // B의 역할은 그대로
        const bRow = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: fx.workspaceB, userId: target } } });
        expect(bRow?.role).toBe('MEMBER');

        // Delete
        const del = await request(app).delete(`/workspaces/${fx.workspaceA}/members/${target}`).set(admin);
        expect(del.status).toBe(200);
        const listGone = await request(app).get(`/workspaces/${fx.workspaceA}/members`).set(admin);
        expect(listGone.body.items.some((u: { id: number }) => u.id === target)).toBe(false);
        expect((await request(app).get('/users').set(auth(fx.users.b.token)).set('X-Workspace-Id', String(fx.workspaceA))).status).toBe(404);
        // 행은 남고 leftAt이 채워진다
        const row = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: fx.workspaceA, userId: target } } });
        expect(row?.leftAt).not.toBeNull();
        // 다시 지우면 404
        expect((await request(app).delete(`/workspaces/${fx.workspaceA}/members/${target}`).set(admin)).status).toBe(404);
      }
      const actions = (await prisma.auditLog.findMany({ where: { targetId: target }, select: { action: true } })).map((l) => l.action);
      expect(actions.filter((a) => a === 'workspace.member_added')).toHaveLength(2);
      expect(actions).toEqual(expect.arrayContaining(['workspace.member_role_changed', 'workspace.member_removed']));
    });

    it('enforces permissions: non-member 404, member 403, role limits for workspace admins', async () => {
      // A의 일반 멤버
      const asMember = await request(app).post(`/workspaces/${fx.workspaceA}/members`).set(auth(fx.users.a.token)).send({ userId: fx.users.b.id });
      expect(asMember.status).toBe(403);
      expect(asMember.body.code).toBe('WORKSPACE_ADMIN_REQUIRED');
      // B의 소유자는 A 멤버가 아니다
      const nonMember = await request(app).post(`/workspaces/${fx.workspaceA}/members`).set(auth(fx.users.bOwner.token)).send({ userId: fx.users.b.id });
      expect(nonMember.status).toBe(404);
      expect(nonMember.body.code).toBe('WORKSPACE_NOT_FOUND');
      const readNonMember = await request(app).get(`/workspaces/${fx.workspaceA}/members`).set(auth(fx.users.b.token));
      expect(readNonMember.status).toBe(404);
      // A의 ADMIN(OWNER·조직 관리자 아님)은 ADMIN 이상을 줄 수 없고 ADMIN을 건드릴 수 없다
      const grantAdmin = await request(app).post(`/workspaces/${fx.workspaceA}/members`).set(auth(fx.users.aAdmin.token))
        .send({ userId: fx.users.b.id, role: 'ADMIN' });
      expect(grantAdmin.status).toBe(403);
      expect(grantAdmin.body.code).toBe('WORKSPACE_ROLE_FORBIDDEN');
      const promote = await request(app).patch(`/workspaces/${fx.workspaceA}/members/${fx.users.a.id}`).set(auth(fx.users.aAdmin.token)).send({ role: 'ADMIN' });
      expect(promote.status).toBe(403);
      // 조직 관리자는 멤버가 아닌 워크스페이스도 관리하고 ADMIN을 줄 수 있다
      const orgAssign = await request(app).post(`/workspaces/${fx.workspaceB}/members`).set(auth(fx.users.orgAdmin.token))
        .send({ userId: fx.users.a.id, role: 'ADMIN' });
      expect(orgAssign.status).toBe(201);
      // 이미 멤버, 없는 사용자, 다른 워크스페이스 채널
      const dup = await request(app).post(`/workspaces/${fx.workspaceB}/members`).set(auth(fx.users.orgAdmin.token)).send({ userId: fx.users.a.id });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('USER_ALREADY_WORKSPACE_MEMBER');
      const missing = await request(app).post(`/workspaces/${fx.workspaceB}/members`).set(auth(fx.users.orgAdmin.token)).send({ userId: 999999 });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('USER_NOT_FOUND');
      const wrongChannel = await request(app).post(`/workspaces/${fx.workspaceB}/members`).set(auth(fx.users.orgAdmin.token))
        .send({ userId: fx.users.ga.id, channelIds: [fx.channels.aPublic] });
      expect(wrongChannel.status).toBe(400);
      expect(wrongChannel.body.code).toBe('INVALID_CHANNEL_ID');
      // 자기 역할은 못 바꾼다
      const self = await request(app).patch(`/workspaces/${fx.workspaceB}/members/${fx.users.bOwner.id}`).set(auth(fx.users.bOwner.token)).send({ role: 'MEMBER' });
      expect(self.status).toBe(400);
    });

    it('keeps at least one owner and protects the primary owner', async () => {
      const admin = auth(fx.users.orgAdmin.token);
      const demote = await request(app).patch(`/workspaces/${fx.workspaceB}/members/${fx.users.bOwner.id}`).set(admin).send({ role: 'MEMBER' });
      expect(demote.status).toBe(409);
      expect(demote.body.code).toBe('LAST_WORKSPACE_OWNER');
      const leave = await request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.bOwner.token));
      expect(leave.status).toBe(409);
      expect(leave.body.code).toBe('LAST_WORKSPACE_OWNER');
      // 두 번째 OWNER가 있으면 강등할 수 있다
      await request(app).patch(`/workspaces/${fx.workspaceB}/members/${fx.users.b.id}`).set(admin).send({ role: 'OWNER' }).expect(200);
      await request(app).patch(`/workspaces/${fx.workspaceB}/members/${fx.users.bOwner.id}`).set(admin).send({ role: 'MEMBER' }).expect(200);

      // 조직 주 소유자는 제거할 수 없다
      await setUserRole(prisma, fx.users.ab.id, 'OWNER', { joinDefaultWorkspace: false });
      const primary = await request(app).delete(`/workspaces/${fx.workspaceA}/members/${fx.users.ab.id}`).set(admin);
      expect(primary.status).toBe(403);
      expect(primary.body.code).toBe('CANNOT_REMOVE_PRIMARY_OWNER');
      // 기본 워크스페이스가 아닌 곳은 주 소유자도 스스로 나갈 수 있다(기본 워크스페이스 나가기는 따로 막힌다)
      const primaryLeave = await request(app).post(`/workspaces/${fx.workspaceA}/leave`).set(auth(fx.users.ab.token));
      expect(primaryLeave.status).toBe(200);
      expect((await request(app).get(`/workspaces/${fx.workspaceA}`).set(auth(fx.users.ab.token))).status).toBe(404);
    });

    it('removing yourself follows the leave rules (no rank check, last owner and default workspace still apply)', async () => {
      // A의 ADMIN이 자기 자신을 DELETE로 빼면 나가기와 같다
      const selfA = await request(app).delete(`/workspaces/${fx.workspaceA}/members/${fx.users.aAdmin.id}`).set(auth(fx.users.aAdmin.token));
      expect(selfA.status).toBe(200);
      // 감사 로그는 응답 뒤에 쓰인다(writeAuditLog를 기다리지 않음). 잠깐 기다리며 확인한다
      let left = null;
      for (let i = 0; i < 20 && !left; i++) {
        left = await prisma.auditLog.findFirst({ where: { action: 'workspace.left', targetId: fx.users.aAdmin.id } });
        if (!left) await new Promise((r) => setTimeout(r, 50));
      }
      expect(left).not.toBeNull();
      // B의 유일한 OWNER는 자기 자신을 뺄 수 없다
      const selfB = await request(app).delete(`/workspaces/${fx.workspaceB}/members/${fx.users.bOwner.id}`).set(auth(fx.users.bOwner.token));
      expect(selfB.status).toBe(409);
      expect(selfB.body.code).toBe('LAST_WORKSPACE_OWNER');
    });

    it('two admins removing the same member at once: one 200, one 404 (role re-read under the lock)', async () => {
      const admin = auth(fx.users.orgAdmin.token);
      for (let round = 0; round < 3; round++) {
        await addFixtureMember(fx.workspaceB, fx.users.a.id, 'MEMBER');
        const results = await Promise.all([
          request(app).delete(`/workspaces/${fx.workspaceB}/members/${fx.users.a.id}`).set(admin),
          request(app).delete(`/workspaces/${fx.workspaceB}/members/${fx.users.a.id}`).set(auth(fx.users.bOwner.token)),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
      }
      // 감사 로그는 응답 뒤에 쓰인다. 마지막 한 건을 잠깐 기다린다
      let removedLogs = 0;
      for (let i = 0; i < 20 && removedLogs < 3; i++) {
        removedLogs = await prisma.auditLog.count({ where: { action: 'workspace.member_removed', targetId: fx.users.a.id } });
        if (removedLogs < 3) await new Promise((r) => setTimeout(r, 50));
      }
      expect(removedLogs).toBe(3);
    });

    it('two owners leaving at the same time: exactly one succeeds (row lock)', async () => {
      for (let round = 0; round < 3; round++) {
        await addFixtureMember(fx.workspaceB, fx.users.b.id, 'OWNER');
        await addFixtureMember(fx.workspaceB, fx.users.bOwner.id, 'OWNER');
        const results = await Promise.all([
          request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.b.token)),
          request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.bOwner.token)),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe('LAST_WORKSPACE_OWNER');
        const owners = await prisma.workspaceMember.count({ where: { workspaceId: fx.workspaceB, role: 'OWNER', leftAt: null } });
        expect(owners).toBe(1);
      }
    });

    it('does not let anyone leave or be removed from the default workspace through /workspaces', async () => {
      const owner = await createFixtureUser('wsx-defowner@example.com', 'DefOwner');
      await setUserRole(prisma, owner.id, 'OWNER');
      const member = await createFixtureUser('wsx-defm@example.com', 'DefM');
      await setUserRole(prisma, member.id, 'MEMBER');
      const leave = await request(app).post(`/workspaces/${DEFAULT_WORKSPACE_ID}/leave`).set(auth(member.token));
      expect(leave.status).toBe(409);
      expect(leave.body.code).toBe('DEFAULT_WORKSPACE_MEMBERSHIP_REQUIRED');
      const remove = await request(app).delete(`/workspaces/${DEFAULT_WORKSPACE_ID}/members/${member.id}`).set(auth(owner.token));
      expect(remove.status).toBe(409);
      expect(remove.body.code).toBe('DEFAULT_WORKSPACE_MEMBERSHIP_REQUIRED');
      const row = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: DEFAULT_WORKSPACE_ID, userId: member.id } } });
      expect(row?.leftAt).toBeNull();
    });

    it('keeps the implicit default workspace membership when a row-less user gets a first workspace', async () => {
      const legacy = await createFixtureUser('wsx-legacy2@example.com', 'Legacy2');
      await request(app).post(`/workspaces/${fx.workspaceB}/members`).set(auth(fx.users.orgAdmin.token)).send({ userId: legacy.id }).expect(201);
      const list = await request(app).get('/workspaces').set(auth(legacy.token));
      expect(list.body.workspaces.map((w: { id: number }) => w.id).sort()).toEqual([DEFAULT_WORKSPACE_ID, fx.workspaceB].sort());
    });

    it('default workspace role changes go through setUserRole (User.role and orgRole follow)', async () => {
      const owner = await createFixtureUser('wsx-owner@example.com', 'Owner');
      await setUserRole(prisma, owner.id, 'OWNER');
      const member = await createFixtureUser('wsx-m1@example.com', 'M1');
      await setUserRole(prisma, member.id, 'MEMBER');
      const res = await request(app).patch(`/workspaces/${DEFAULT_WORKSPACE_ID}/members/${member.id}`).set(auth(owner.token)).send({ role: 'ADMIN' });
      expect(res.status).toBe(200);
      const after = await prisma.user.findUnique({ where: { id: member.id }, select: { role: true, orgRole: true } });
      expect(after).toEqual({ role: 'ADMIN', orgRole: 'ADMIN' });
      // 조직 ADMIN(기본 워크스페이스 OWNER 아님)은 기본 워크스페이스에서 ADMIN을 줄 수 없다(조직 역할이 같이 바뀌므로)
      const denied = await request(app).patch(`/workspaces/${DEFAULT_WORKSPACE_ID}/members/${owner.id}`).set(auth(fx.users.orgAdmin.token)).send({ role: 'MEMBER' });
      expect(denied.status).toBe(403);
    });
  });

  // ─── 재리뷰 보강: 이름 유일성, 잘못된 id, 계정 단위 경로 ─────

  describe('review follow-ups', () => {
    it('workspace names are unique case-insensitively at the DB level, also under concurrent creates', async () => {
      const admin = auth(fx.users.orgAdmin.token);
      for (let round = 0; round < 2; round++) {
        const results = await Promise.all([
          request(app).post('/org/workspaces').set(admin).send({ slug: `wsx-r${round}a`, name: `Race ${round}` }),
          request(app).post('/org/workspaces').set(admin).send({ slug: `wsx-r${round}b`, name: `RACE ${round}` }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe('WORKSPACE_NAME_TAKEN');
      }
      // 앱 검사를 거치지 않는 쓰기도 인덱스가 막는다
      await expect(prisma.workspace.create({ data: { organizationId: 1, slug: 'wsx-direct', name: 'wSx A' } }))
        .rejects.toMatchObject({ code: 'P2002' });
      // 이름 변경도 같은 규칙
      const rename = await request(app).patch(`/org/workspaces/${fx.workspaceB}`).set(admin).send({ name: 'WSX A' });
      expect(rename.status).toBe(409);
      expect(rename.body.code).toBe('WORKSPACE_NAME_TAKEN');
      // 대소문자만 바꾸는 자기 이름 변경은 된다
      const self = await request(app).patch(`/org/workspaces/${fx.workspaceA}`).set(admin).send({ name: 'WSX A' });
      expect(self.status).toBe(200);
    });

    it('rejects a malformed :id with 400 whoever calls', async () => {
      for (const token of [fx.users.a.token, fx.users.orgAdmin.token]) {
        expect((await request(app).patch('/org/workspaces/abc').set(auth(token)).send({ name: 'x' })).body.code).toBe('INVALID_WORKSPACE_ID');
        expect((await request(app).post('/org/workspaces/0/archive').set(auth(token))).status).toBe(400);
        expect((await request(app).post('/org/workspaces/1.5/unarchive').set(auth(token))).status).toBe(400);
        expect((await request(app).get('/workspaces/abc/members').set(auth(token))).status).toBe(400);
      }
    });

    it('account-level paths (/push, /oauth authorize) ignore the workspace header and work without a workspace', async () => {
      await prisma.workspaceMember.updateMany({ where: { userId: fx.users.a.id }, data: { leftAt: new Date() } });
      const push = await request(app).delete('/push/subscribe').set(auth(fx.users.a.token)).set('X-Workspace-Id', 'garbage')
        .send({ endpoint: 'https://push.example.invalid/x' });
      expect(push.status).toBe(200);
      expect(push.headers['x-workspace-id']).toBeUndefined();
      const oauth = await request(app).get('/oauth/authorize/details').set(auth(fx.users.a.token)).set('X-Workspace-Id', 'garbage');
      expect(oauth.body.code).not.toBe('NO_WORKSPACE');
      expect(oauth.body.code).not.toBe('INVALID_WORKSPACE_ID');
      // 워크스페이스 단위 경로는 여전히 막힌다
      expect((await request(app).get('/users').set(auth(fx.users.a.token))).body.code).toBe('NO_WORKSPACE');
    });
  });

  // ─── 찾아보기·참여·나가기 ────────────────────────────────────

  describe('discover, join and leave', () => {
    it('joins OPEN workspaces only, hides HIDDEN, and leaves', async () => {
      await prisma.workspace.update({ where: { id: fx.workspaceB }, data: { discoverability: 'OPEN' } });
      const hidden = await prisma.workspace.create({ data: { organizationId: 1, slug: 'wsx-h', name: 'Hidden', discoverability: 'HIDDEN' } });

      const discover = await request(app).get('/workspaces/discover').set(auth(fx.users.a.token));
      expect(discover.status).toBe(200);
      const ids = discover.body.workspaces.map((w: { id: number }) => w.id);
      expect(ids).toEqual(expect.arrayContaining([fx.workspaceA, fx.workspaceB]));
      expect(ids).not.toContain(hidden.id);
      expect(discover.body.workspaces.find((w: { id: number }) => w.id === fx.workspaceA).isMember).toBe(true);

      for (let round = 0; round < 2; round++) {
        const join = await request(app).post(`/workspaces/${fx.workspaceB}/join`).set(auth(fx.users.a.token));
        expect(join.status).toBe(201);
        expect(join.body.workspace).toMatchObject({ id: fx.workspaceB, role: 'MEMBER' });
        expect((await request(app).post(`/workspaces/${fx.workspaceB}/join`).set(auth(fx.users.a.token))).status).toBe(409);
        const leave = await request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.a.token));
        expect(leave.status).toBe(200);
        expect((await request(app).get(`/workspaces/${fx.workspaceB}`).set(auth(fx.users.a.token))).status).toBe(404);
      }

      const inviteOnly = await request(app).post(`/workspaces/${fx.workspaceA}/join`).set(auth(fx.users.b.token));
      expect(inviteOnly.status).toBe(403);
      expect(inviteOnly.body.code).toBe('WORKSPACE_NOT_OPEN');
      const hiddenJoin = await request(app).post(`/workspaces/${hidden.id}/join`).set(auth(fx.users.b.token));
      expect(hiddenJoin.status).toBe(404);
      // 게스트는 스스로 참여하지 못한다
      const guest = await request(app).post(`/workspaces/${fx.workspaceB}/join`).set(auth(fx.users.ga.token));
      expect(guest.status).toBe(403);
    });
  });

  // ─── 초대 수락 ───────────────────────────────────────────────

  describe('invite accept for signed-in users', () => {
    async function invite(workspaceId: number, opts: { code: string; role?: 'MEMBER' | 'GUEST' | 'ADMIN'; maxUses?: number; expiresAt?: Date }) {
      return prisma.inviteLink.create({
        data: { code: opts.code, createdBy: fx.users.bOwner.id, workspaceId, role: opts.role ?? 'MEMBER', maxUses: opts.maxUses ?? null, expiresAt: opts.expiresAt ?? null },
      });
    }

    it('accepts, rejects duplicates without consuming, and repeats after leaving', async () => {
      await invite(fx.workspaceB, { code: 'wsx-inv-1', role: 'ADMIN', maxUses: 3 });
      const info = await request(app).get('/auth/invite/wsx-inv-1');
      expect(info.status).toBe(200);
      expect(info.body.workspace).toMatchObject({ id: fx.workspaceB, slug: 'wsx-b' });

      for (let round = 0; round < 2; round++) {
        const accept = await request(app).post('/auth/invite/wsx-inv-1/accept').set(auth(fx.users.a.token));
        expect(accept.status).toBe(200);
        // 초대 역할 ADMIN도 가입처럼 MEMBER로 낮춘다
        expect(accept.body.workspace).toMatchObject({ id: fx.workspaceB, role: 'MEMBER' });
        const again = await request(app).post('/auth/invite/wsx-inv-1/accept').set(auth(fx.users.a.token));
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('USER_ALREADY_WORKSPACE_MEMBER');
        await request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.a.token)).expect(200);
      }
      const used = await prisma.inviteLink.findUnique({ where: { code: 'wsx-inv-1' } });
      expect(used?.useCount).toBe(2);
      const row = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: fx.workspaceB, userId: fx.users.a.id } } });
      expect(row?.invitedBy).toBe(fx.users.bOwner.id);

      // 사용 한도
      const third = await request(app).post('/auth/invite/wsx-inv-1/accept').set(auth(fx.users.ga.token));
      expect(third.status).toBe(200);
      const exhausted = await request(app).post('/auth/invite/wsx-inv-1/accept').set(auth(fx.users.aAdmin.token));
      expect(exhausted.status).toBe(400);
      expect(exhausted.body.code).toBe('INVITE_EXHAUSTED');
    });

    it('the same user accepting twice at once uses the invite only once', async () => {
      await invite(fx.workspaceB, { code: 'wsx-inv-race', maxUses: 10 });
      for (let round = 0; round < 3; round++) {
        const results = await Promise.all([
          request(app).post('/auth/invite/wsx-inv-race/accept').set(auth(fx.users.a.token)),
          request(app).post('/auth/invite/wsx-inv-race/accept').set(auth(fx.users.a.token)),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe('USER_ALREADY_WORKSPACE_MEMBER');
        expect((await prisma.inviteLink.findUnique({ where: { code: 'wsx-inv-race' } }))?.useCount).toBe(round + 1);
        await request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.a.token)).expect(200);
      }
    });

    it('rejects invites to archived workspaces, expired and unknown invites', async () => {
      await invite(fx.workspaceB, { code: 'wsx-inv-arch' });
      await prisma.workspace.update({ where: { id: fx.workspaceB }, data: { archivedAt: new Date() } });
      const accept = await request(app).post('/auth/invite/wsx-inv-arch/accept').set(auth(fx.users.a.token));
      expect(accept.status).toBe(400);
      expect(accept.body.code).toBe('INVITE_INVALID');
      expect((await request(app).get('/auth/invite/wsx-inv-arch')).status).toBe(404);
      const register = await request(app).post('/auth/register')
        .send({ email: 'wsx-arch@example.com', password: TEST_PASSWORD, name: 'Arch', inviteCode: 'wsx-inv-arch' });
      expect(register.status).toBe(400);
      expect(register.body.code).toBe('INVITE_INVALID');
      expect((await prisma.inviteLink.findUnique({ where: { code: 'wsx-inv-arch' } }))?.useCount).toBe(0);

      await invite(fx.workspaceA, { code: 'wsx-inv-exp', expiresAt: new Date(Date.now() - 1000) });
      const expired = await request(app).post('/auth/invite/wsx-inv-exp/accept').set(auth(fx.users.b.token));
      expect(expired.status).toBe(400);
      expect(expired.body.code).toBe('INVITE_EXPIRED');
      const unknown = await request(app).post('/auth/invite/nope/accept').set(auth(fx.users.b.token));
      expect(unknown.status).toBe(400);
      expect(unknown.body.code).toBe('INVITE_INVALID');
      expect((await request(app).post('/auth/invite/nope/accept')).status).toBe(401);
    });

    it('registration through a non-default workspace invite does not join the default workspace', async () => {
      await invite(fx.workspaceB, { code: 'wsx-inv-reg', role: 'GUEST' });
      const reg = await request(app).post('/auth/register')
        .send({ email: 'wsx-new@example.com', password: TEST_PASSWORD, name: 'New', inviteCode: 'wsx-inv-reg' });
      expect(reg.status).toBe(201);
      const list = await request(app).get('/workspaces').set(auth(reg.body.token));
      expect(list.body.workspaces.map((w: { id: number; role: string }) => [w.id, w.role])).toEqual([[fx.workspaceB, 'GUEST']]);
      expect((await request(app).get('/users').set(auth(reg.body.token)).set('X-Workspace-Id', String(DEFAULT_WORKSPACE_ID))).status).toBe(404);
    });
  });
});

// ─── 소켓: ws:<id> room과 workspace:* 이벤트 ─────────────────────

describe('Workspace socket events (E1b)', () => {
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
    fx = await createWorkspaceFixture('wsy');
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

  /** 이벤트를 기록한다. 받지 말아야 할 이벤트는 다른 이벤트를 받을 때까지 기다린 뒤 기록이 비었는지 본다 */
  function record(s: ClientSocket, event: string): unknown[] {
    const got: unknown[] = [];
    s.on(event, (p: unknown) => got.push(p));
    return got;
  }

  function next(s: ClientSocket, event: string): Promise<any> {
    return new Promise((resolve) => s.once(event, resolve));
  }

  it('joins ws rooms on connect: workspace:updated reaches members only', async () => {
    const b = await connect(fx.users.b.token);
    const a = await connect(fx.users.a.token);
    const aGot = record(a, 'workspace:updated');
    const bNext = next(b, 'workspace:updated');
    await request(app).patch(`/org/workspaces/${fx.workspaceB}`).set(auth(fx.users.orgAdmin.token)).send({ name: 'B v2' }).expect(200);
    expect(await bNext).toMatchObject({ id: fx.workspaceB, name: 'B v2' });
    // a가 받을 이벤트가 있었다면 b와 같은 시점에 도착했다. 한 번 더 왕복해 순서를 맞춘 뒤 확인한다
    const aSelf = next(a, 'workspace:updated');
    await request(app).patch(`/org/workspaces/${fx.workspaceA}`).set(auth(fx.users.orgAdmin.token)).send({ name: 'A v2' }).expect(200);
    expect(await aSelf).toMatchObject({ id: fx.workspaceA });
    expect(aGot).toEqual([expect.objectContaining({ id: fx.workspaceA })]);
  });

  it('member added/updated/removed in another workspace: events and room changes only, the connection stays', async () => {
    const a = await connect(fx.users.a.token);
    const b = await connect(fx.users.b.token);
    const admin = auth(fx.users.orgAdmin.token);
    const aErrors = record(a, 'error');
    const aDisconnects = record(a, 'disconnect');

    for (let round = 0; round < 2; round++) {
      const added = next(a, 'workspace:member:added');
      const bSawAdded = next(b, 'workspace:member:added');
      await request(app).post(`/workspaces/${fx.workspaceB}/members`).set(admin).send({ userId: fx.users.a.id }).expect(201);
      expect(await added).toEqual({ workspaceId: fx.workspaceB, userId: fx.users.a.id, role: 'MEMBER' });
      expect(await bSawAdded).toMatchObject({ userId: fx.users.a.id });

      // 이제 a도 B room에 있다
      const aUpdated = next(a, 'workspace:updated');
      await request(app).patch(`/org/workspaces/${fx.workspaceB}`).set(admin).send({ description: `x${round}` }).expect(200);
      expect(await aUpdated).toMatchObject({ id: fx.workspaceB });

      // 역할 변경: 이벤트만, 연결은 유지
      const roleChanged = next(a, 'workspace:member:updated');
      await request(app).patch(`/workspaces/${fx.workspaceB}/members/${fx.users.a.id}`).set(admin).send({ role: 'ADMIN' }).expect(200);
      expect(await roleChanged).toEqual({ workspaceId: fx.workspaceB, userId: fx.users.a.id, role: 'ADMIN' });

      // 제거: 이벤트를 받고 B room에서만 빠진다
      const removed = next(a, 'workspace:member:removed');
      const bSawRemoved = next(b, 'workspace:member:removed');
      await request(app).delete(`/workspaces/${fx.workspaceB}/members/${fx.users.a.id}`).set(admin).expect(200);
      expect(await removed).toEqual({ workspaceId: fx.workspaceB, userId: fx.users.a.id });
      expect(await bSawRemoved).toMatchObject({ userId: fx.users.a.id });

      // 같은 연결로 B 이벤트는 더 받지 않고 A 이벤트는 받는다(b가 받는 시점까지 a에는 오지 않음)
      const aGot = record(a, 'workspace:updated');
      const bUpdated = next(b, 'workspace:updated');
      await request(app).patch(`/org/workspaces/${fx.workspaceB}`).set(admin).send({ description: `y${round}` }).expect(200);
      await bUpdated;
      const aSelf = next(a, 'workspace:updated');
      await request(app).patch(`/org/workspaces/${fx.workspaceA}`).set(admin).send({ description: `z${round}` }).expect(200);
      await aSelf;
      expect(aGot.map((p: any) => p.id)).toEqual([fx.workspaceA]);
      a.off('workspace:updated');
    }
    expect(a.connected).toBe(true);
    expect(aErrors).toEqual([]);
    expect(aDisconnects).toEqual([]);
  });

  it('a default workspace role change disconnects the target (socket.user.role changes)', async () => {
    const owner = await createFixtureUser('wsy-owner@example.com', 'Owner');
    await setUserRole(prisma, owner.id, 'OWNER');
    const member = await createFixtureUser('wsy-m@example.com', 'M');
    await setUserRole(prisma, member.id, 'MEMBER');
    const m = await connect(member.token);
    const updated = next(m, 'workspace:member:updated');
    const kicked = next(m, 'error');
    const dropped = next(m, 'disconnect');
    await request(app).patch(`/workspaces/${DEFAULT_WORKSPACE_ID}/members/${member.id}`).set(auth(owner.token)).send({ role: 'ADMIN' }).expect(200);
    expect(await updated).toEqual({ workspaceId: DEFAULT_WORKSPACE_ID, userId: member.id, role: 'ADMIN' });
    expect(await kicked).toEqual({ message: 'Workspace membership changed' });
    expect(await dropped).toBe('io server disconnect');
  });

  it('leaving by yourself does not disconnect you', async () => {
    const ab = await connect(fx.users.ab.token);
    const removed = next(ab, 'workspace:member:removed');
    await request(app).post(`/workspaces/${fx.workspaceB}/leave`).set(auth(fx.users.ab.token)).expect(200);
    expect(await removed).toEqual({ workspaceId: fx.workspaceB, userId: fx.users.ab.id });
    // 같은 소켓으로 A 이벤트를 계속 받는다
    const aUpdated = next(ab, 'workspace:updated');
    await request(app).patch(`/org/workspaces/${fx.workspaceA}`).set(auth(fx.users.orgAdmin.token)).send({ description: 'still' }).expect(200);
    expect(await aUpdated).toMatchObject({ id: fx.workspaceA });
    expect(ab.connected).toBe(true);
  });

  it('workspace:archived goes to members and the room is emptied', async () => {
    const b = await connect(fx.users.b.token);
    const archived = next(b, 'workspace:archived');
    await request(app).post(`/org/workspaces/${fx.workspaceB}/archive`).set(auth(fx.users.orgAdmin.token)).expect(200);
    expect(await archived).toEqual({ id: fx.workspaceB });
    expect(io.sockets.adapter.rooms.get(`ws:${fx.workspaceB}`)?.size ?? 0).toBe(0);

    const unarchived = next(b, 'workspace:unarchived');
    await request(app).post(`/org/workspaces/${fx.workspaceB}/unarchive`).set(auth(fx.users.orgAdmin.token)).expect(200);
    expect(await unarchived).toEqual({ id: fx.workspaceB });
  });

  it('does not let a user without memberships into any ws room', async () => {
    const legacy = await createFixtureUser('wsy-legacy@example.com', 'Legacy');
    await connect(legacy.token);
    // 행이 없는 사용자는 기본 워크스페이스 room에만 들어간다
    expect(io.sockets.adapter.rooms.get(`ws:${DEFAULT_WORKSPACE_ID}`)?.size).toBe(1);
  });
});
