import { TEST_PASSWORD } from './test-constants.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import app from '../app.js';
import prisma from '../db.js';
import { createInitialOwner } from '../services/bootstrapService.js';
import { DEFAULT_ORGANIZATION_ID, DEFAULT_WORKSPACE_ID } from '../services/workspaceService.js';

// E1a 조직·워크스페이스 스키마와 백필(docs/specs/E1-multi-workspace.md 4.2절).
// 1) 마이그레이션 SQL을 옛 형태의 표가 있는 임시 스키마에 트랜잭션으로 적용해 백필 결과를 확인하고 ROLLBACK한다.
// 2) 이미 마이그레이션된 테스트 DB에서 가입·부트스트랩·채널 생성·이름 변경·역할 변경·삭제가 새 행을 맞게 쓰는지 CRUD로 반복한다.

const MIGRATION_SQL = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations/20261102010000_add_organizations_workspaces/migration.sql'),
  'utf8',
);

// 주석 줄을 빼고 문장 단위로 나눈다. 이 마이그레이션에는 문자열 안의 ';'가 없다.
const MIGRATION_STATEMENTS = MIGRATION_SQL
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

const SCHEMA = 'e1_migration_test';

// E1a 직전 상태에서 마이그레이션이 건드리는 열만 가진 옛 표
const LEGACY_DDL = [
  `CREATE SCHEMA ${SCHEMA}`,
  `SET LOCAL search_path TO ${SCHEMA}`,
  `CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'GUEST')`,
  `CREATE TABLE "User" ("id" SERIAL PRIMARY KEY, "email" VARCHAR(255) NOT NULL UNIQUE, "role" "Role" NOT NULL DEFAULT 'MEMBER',
     "deactivatedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE "Channel" ("id" SERIAL PRIMARY KEY, "name" VARCHAR(80) NOT NULL UNIQUE, "isPrivate" BOOLEAN NOT NULL DEFAULT false,
     "archivedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE "InviteLink" ("id" SERIAL PRIMARY KEY, "code" VARCHAR(64) NOT NULL UNIQUE, "createdBy" INTEGER NOT NULL)`,
];

const LEGACY_DATA = [
  `INSERT INTO "User" ("id", "email", "role", "deactivatedAt", "createdAt") VALUES
     (11, 'owner@e1.test', 'OWNER', NULL, '2026-01-01'),
     (12, 'admin@e1.test', 'ADMIN', NULL, '2026-01-02'),
     (13, 'member@e1.test', 'MEMBER', NULL, '2026-01-03'),
     (14, 'guest@e1.test', 'GUEST', NULL, '2026-01-04'),
     (15, 'gone@e1.test', 'MEMBER', '2026-02-01', '2026-01-05'),
     (16, 'owner2@e1.test', 'OWNER', NULL, '2026-01-06')`,
  `INSERT INTO "Channel" ("id", "name", "isPrivate", "archivedAt") VALUES
     (21, 'general', false, NULL),
     (22, 'random', false, NULL),
     (23, 'Dev', false, NULL),
     (24, 'dev', false, NULL),
     (25, 'secret', true, NULL),
     (26, 'old', false, '2026-03-01')`,
  `INSERT INTO "InviteLink" ("code", "createdBy") VALUES ('legacy-a', 11), ('legacy-b', 12)`,
];

class Rollback extends Error {}

// 옛 표를 만들고 데이터를 넣은 뒤 마이그레이션을 적용하고, check가 끝나면 전부 되돌린다.
// 마이그레이션 문장은 저장소의 고정 파일이라 Prisma.raw로 실행한다(사용자 입력이 들어가지 않는다).
async function runMigrationAndRollback<T>(
  withData: boolean,
  check: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      for (const sql of LEGACY_DDL) await tx.$executeRaw(Prisma.raw(sql));
      if (withData) for (const sql of LEGACY_DATA) await tx.$executeRaw(Prisma.raw(sql));
      for (const sql of MIGRATION_STATEMENTS) await tx.$executeRaw(Prisma.raw(sql));
      result = await check(tx);
      throw new Rollback();
    }, { timeout: 30000 });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

async function schemaExists(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = ${SCHEMA}`;
  return rows[0].n > 0;
}

describe('E1a migration backfill (transaction + ROLLBACK)', () => {
  it('moves existing users, channels and invites into the default organization and workspace', async () => {
    const snapshot = await runMigrationAndRollback(true, async (tx) => ({
      users: await tx.$queryRaw<Array<{ id: number; role: string; orgRole: string; organizationId: number; defaultWorkspaceId: number }>>`
        SELECT "id", "role"::text, "orgRole"::text, "organizationId", "defaultWorkspaceId" FROM "User" ORDER BY "id"`,
      members: await tx.$queryRaw<Array<{ userId: number; workspaceId: number; role: string; joinedOk: boolean; leftAt: Date | null }>>`
        SELECT m."userId", m."workspaceId", m."role"::text, m."joinedAt" = u."createdAt" AS "joinedOk", m."leftAt"
        FROM "WorkspaceMember" m JOIN "User" u ON u."id" = m."userId" ORDER BY m."userId"`,
      channels: await tx.$queryRaw<Array<{ id: number; workspaceId: number; isHost: boolean; isDefault: boolean; nameKey: string }>>`
        SELECT c."id", c."workspaceId", cw."isHost", cw."isDefault", cw."nameKey"
        FROM "Channel" c JOIN "ChannelWorkspace" cw ON cw."channelId" = c."id" ORDER BY c."id"`,
      invites: await tx.$queryRaw<Array<{ workspaceId: number }>>`SELECT "workspaceId" FROM "InviteLink"`,
      org: await tx.$queryRaw<Array<{ id: number; primaryOwnerId: number | null }>>`SELECT "id", "primaryOwnerId" FROM "Organization"`,
      workspaces: await tx.$queryRaw<Array<{ id: number; organizationId: number; slug: string; discoverability: string }>>`
        SELECT "id", "organizationId", "slug", "discoverability"::text FROM "Workspace"`,
      nextWorkspaceId: (await tx.$queryRaw<Array<{ id: number }>>`
        INSERT INTO "Workspace" ("organizationId", "slug", "name") VALUES (1, 'second', 'Second') RETURNING "id"`)[0].id,
    }));

    // 행 수: User = WorkspaceMember, Channel = ChannelWorkspace(isHost)
    expect(snapshot.members).toHaveLength(snapshot.users.length);
    expect(snapshot.channels).toHaveLength(6);
    expect(snapshot.channels.every((c) => c.isHost && c.workspaceId === 1)).toBe(true);

    // 역할 매핑: 워크스페이스 역할은 그대로, 조직 역할은 OWNER/ADMIN만 올라간다. 비활성 사용자도 멤버다.
    const orgRoles = Object.fromEntries(snapshot.users.map((u) => [u.id, u.orgRole]));
    expect(orgRoles).toEqual({ 11: 'OWNER', 12: 'ADMIN', 13: 'MEMBER', 14: 'MEMBER', 15: 'MEMBER', 16: 'OWNER' });
    for (const m of snapshot.members) {
      expect(m.workspaceId).toBe(1);
      expect(m.role).toBe(snapshot.users.find((u) => u.id === m.userId)!.role);
      expect(m.joinedOk).toBe(true);
      expect(m.leftAt).toBeNull();
    }
    expect(snapshot.users.every((u) => u.organizationId === 1 && u.defaultWorkspaceId === 1)).toBe(true);

    // 주 소유자는 가장 먼저 만든 OWNER
    expect(snapshot.org).toEqual([{ id: 1, primaryOwnerId: 11 }]);
    expect(snapshot.workspaces).toEqual([{ id: 1, organizationId: 1, slug: 'main', discoverability: 'INVITE_ONLY' }]);
    // id를 직접 넣은 뒤에도 시퀀스가 맞아 다음 워크스페이스는 2다
    expect(snapshot.nextWorkspaceId).toBe(2);

    // 기본 채널은 공개 general·random, 대소문자만 다른 옛 이름은 nameKey가 겹치지 않게 접미사를 받는다
    const byId = Object.fromEntries(snapshot.channels.map((c) => [c.id, c]));
    expect(byId[21]).toMatchObject({ isDefault: true, nameKey: 'general' });
    expect(byId[22]).toMatchObject({ isDefault: true, nameKey: 'random' });
    expect(byId[23]).toMatchObject({ isDefault: false, nameKey: 'dev' });
    expect(byId[24]).toMatchObject({ isDefault: false, nameKey: 'dev~24' });
    expect(byId[25]).toMatchObject({ isDefault: false, nameKey: 'secret' });
    expect(byId[26]).toMatchObject({ isDefault: false, nameKey: 'old' });

    expect(snapshot.invites).toEqual([{ workspaceId: 1 }, { workspaceId: 1 }]);

    // ROLLBACK 뒤에는 임시 스키마가 남지 않는다
    expect(await schemaExists()).toBe(false);
  });

  it('creates the default organization and workspace on an empty database', async () => {
    const snapshot = await runMigrationAndRollback(false, async (tx) => ({
      org: await tx.$queryRaw<Array<{ id: number; primaryOwnerId: number | null }>>`SELECT "id", "primaryOwnerId" FROM "Organization"`,
      workspaceCount: (await tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "Workspace"`)[0].n,
      memberCount: (await tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "WorkspaceMember"`)[0].n,
      // 새 사용자는 기본값으로 기본 조직에 들어간다(조직 FK가 기본 행을 가리킨다)
      newUser: (await tx.$queryRaw<Array<{ organizationId: number; orgRole: string }>>`
        INSERT INTO "User" ("email") VALUES ('new@e1.test') RETURNING "organizationId", "orgRole"::text`)[0],
    }));
    expect(snapshot.org).toEqual([{ id: 1, primaryOwnerId: null }]);
    expect(snapshot.workspaceCount).toBe(1);
    expect(snapshot.memberCount).toBe(0);
    expect(snapshot.newUser).toEqual({ organizationId: 1, orgRole: 'MEMBER' });
    expect(await schemaExists()).toBe(false);
  });
});

describe('E1a creation paths write workspace rows', () => {
  async function resetDb() {
    await prisma.auditLog.deleteMany();
    await prisma.inviteLink.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.workspace.deleteMany({ where: { id: { not: DEFAULT_WORKSPACE_ID } } });
  }

  async function login(email: string) {
    const res = await request(app).post('/auth/login').send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    return res.body.token as string;
  }

  async function membership(userId: number) {
    return prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: DEFAULT_WORKSPACE_ID, userId } } });
  }

  beforeEach(resetDb);

  it('bootstrap owner becomes primary owner and workspace OWNER, deleting the user cascades', async () => {
    const owner = await createInitialOwner({ email: 'e1-owner@example.com', password: TEST_PASSWORD, name: 'E1 Owner' });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(user).toMatchObject({ organizationId: DEFAULT_ORGANIZATION_ID, orgRole: 'OWNER', defaultWorkspaceId: DEFAULT_WORKSPACE_ID });
    expect(await membership(owner.id)).toMatchObject({ role: 'OWNER', leftAt: null });
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: 1 } })).primaryOwnerId).toBe(owner.id);

    // 기본 채널은 기본 워크스페이스의 기본 채널로 연결된다
    const defaults = await prisma.channelWorkspace.findMany({
      where: { workspaceId: DEFAULT_WORKSPACE_ID, isDefault: true },
      include: { channel: { select: { name: true } } },
    });
    expect(defaults.map((d) => d.channel.name).sort()).toEqual(['general', 'random']);
    expect(defaults.every((d) => d.isHost)).toBe(true);

    // Delete: 사용자를 지우면 멤버십이 연쇄로 지워지고 주 소유자는 비워진다
    await prisma.auditLog.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.user.delete({ where: { id: owner.id } });
    expect(await membership(owner.id)).toBeNull();
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: 1 } })).primaryOwnerId).toBeNull();
  });

  it('invite registration joins the invite workspace with the invite role and inviter', async () => {
    const adminRes = await request(app).post('/auth/register')
      .send({ email: 'e1-admin@example.com', password: TEST_PASSWORD, name: 'E1 Admin' });
    expect(adminRes.status).toBe(201);
    const adminId = adminRes.body.user.id as number;
    expect(await membership(adminId)).toMatchObject({ role: 'MEMBER', invitedBy: null });
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });
    const adminToken = await login('e1-admin@example.com');

    // 관리자 API로 만든 초대는 기본 워크스페이스를 가리킨다
    const invite = await request(app).post('/admin/invites').set('Authorization', `Bearer ${adminToken}`).send({ role: 'GUEST' });
    expect(invite.status).toBe(201);
    const stored = await prisma.inviteLink.findUniqueOrThrow({ where: { code: invite.body.code } });
    expect(stored.workspaceId).toBe(DEFAULT_WORKSPACE_ID);

    const guestRes = await request(app).post('/auth/register')
      .send({ email: 'e1-guest@example.com', password: TEST_PASSWORD, name: 'E1 Guest', inviteCode: invite.body.code });
    expect(guestRes.status).toBe(201);
    const guestId = guestRes.body.user.id as number;
    expect(await membership(guestId)).toMatchObject({ role: 'GUEST', invitedBy: adminId, leftAt: null });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: guestId } }))
      .toMatchObject({ orgRole: 'MEMBER', defaultWorkspaceId: DEFAULT_WORKSPACE_ID, organizationId: DEFAULT_ORGANIZATION_ID });
  });

  it('channel create, rename and delete keep the host ChannelWorkspace row in sync', async () => {
    const res = await request(app).post('/auth/register')
      .send({ email: 'e1-maker@example.com', password: TEST_PASSWORD, name: 'E1 Maker' });
    const token = res.body.token as string;

    for (let round = 0; round < 2; round++) {
      // Create
      const created = await request(app).post('/channels').set('Authorization', `Bearer ${token}`)
        .send({ name: `e1-chan-${round}` });
      expect(created.status).toBe(201);
      const channelId = created.body.id as number;

      // Read
      const host = await prisma.channelWorkspace.findUniqueOrThrow({
        where: { channelId_workspaceId: { channelId, workspaceId: DEFAULT_WORKSPACE_ID } },
      });
      expect(host).toMatchObject({ isHost: true, isDefault: false, nameKey: `e1-chan-${round}` });
      expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelId } })).workspaceId).toBe(DEFAULT_WORKSPACE_ID);

      // Update: 이름을 바꾸면 nameKey도 바뀐다
      const renamed = await request(app).patch(`/channels/${channelId}`).set('Authorization', `Bearer ${token}`)
        .send({ name: `e1-renamed-${round}` });
      expect(renamed.status).toBe(200);
      const after = await prisma.channelWorkspace.findMany({ where: { channelId } });
      expect(after.map((r) => r.nameKey)).toEqual([`e1-renamed-${round}`]);

      // 같은 워크스페이스에서 대소문자만 다른 이름은 nameKey 유니크에 걸린다(DB 수준)
      const other = await prisma.channel.create({ data: { name: `E1-Renamed-${round}` } });
      await expect(prisma.channelWorkspace.create({
        data: { channelId: other.id, workspaceId: DEFAULT_WORKSPACE_ID, isHost: true, nameKey: `e1-renamed-${round}` },
      })).rejects.toMatchObject({ code: 'P2002' });
      await prisma.channel.delete({ where: { id: other.id } });

      // Delete: 채널을 지우면 연결 행도 사라진다
      await prisma.channel.delete({ where: { id: channelId } });
      expect(await prisma.channelWorkspace.count({ where: { channelId } })).toBe(0);
    }
  });

  it('role change and ownership transfer mirror into workspace role, org role and primary owner', async () => {
    const owner = await createInitialOwner({ email: 'e1-own@example.com', password: TEST_PASSWORD, name: 'E1 Own' });
    const ownerToken = await login('e1-own@example.com');
    const memberRes = await request(app).post('/auth/register')
      .send({ email: 'e1-mem@example.com', password: TEST_PASSWORD, name: 'E1 Mem' });
    const memberId = memberRes.body.user.id as number;

    // Update: MEMBER → ADMIN → MEMBER 반복
    for (const role of ['ADMIN', 'MEMBER', 'ADMIN'] as const) {
      const changed = await request(app).patch(`/admin/users/${memberId}`).set('Authorization', `Bearer ${ownerToken}`).send({ role });
      expect(changed.status).toBe(200);
      expect((await membership(memberId))!.role).toBe(role);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: memberId } })).orgRole).toBe(role);
    }

    const transfer = await request(app).post('/admin/transfer-ownership').set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: memberId });
    expect(transfer.status).toBe(200);
    expect((await membership(memberId))!.role).toBe('OWNER');
    expect((await membership(owner.id))!.role).toBe('ADMIN');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).orgRole).toBe('ADMIN');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: 1 } })).primaryOwnerId).toBe(memberId);
  });

  it('workspace rows: create, read, update, delete with unique slug and restricted host delete', async () => {
    const userRes = await request(app).post('/auth/register')
      .send({ email: 'e1-ws@example.com', password: TEST_PASSWORD, name: 'E1 Ws' });
    const userId = userRes.body.user.id as number;

    for (let round = 0; round < 2; round++) {
      // Create
      const ws = await prisma.workspace.create({ data: { organizationId: DEFAULT_ORGANIZATION_ID, slug: `e1-ws-${round}`, name: `E1 WS ${round}` } });
      expect(ws.id).toBeGreaterThan(DEFAULT_WORKSPACE_ID);
      await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId, role: 'ADMIN' } });
      // 조직 안에서 slug와 이름은 유일하다
      await expect(prisma.workspace.create({ data: { organizationId: 1, slug: `e1-ws-${round}`, name: 'Other' } }))
        .rejects.toMatchObject({ code: 'P2002' });
      await expect(prisma.workspace.create({ data: { organizationId: 1, slug: 'other', name: `E1 WS ${round}` } }))
        .rejects.toMatchObject({ code: 'P2002' });

      // 같은 이름 채널을 다른 워크스페이스에 연결할 수 있다(워크스페이스 단위 유일성)
      const general = await prisma.channelWorkspace.findFirst({ where: { workspaceId: DEFAULT_WORKSPACE_ID, nameKey: 'general' } });
      expect(general).not.toBeNull();
      const hosted = await prisma.channel.create({ data: { name: `e1-hosted-${round}`, workspaceId: ws.id } });
      await prisma.channelWorkspace.create({ data: { channelId: hosted.id, workspaceId: ws.id, isHost: true, nameKey: 'general' } });

      // Read
      const read = await prisma.workspace.findUniqueOrThrow({
        where: { id: ws.id },
        include: { members: true, channels: true, hostedChannels: true },
      });
      expect(read.members).toEqual([expect.objectContaining({ userId, role: 'ADMIN', leftAt: null })]);
      expect(read.channels.map((c) => c.channelId)).toEqual([hosted.id]);
      expect(read.hostedChannels.map((c) => c.id)).toEqual([hosted.id]);

      // Update: 나가기는 행을 남기고 leftAt만 채운다
      await prisma.workspace.update({ where: { id: ws.id }, data: { name: `E1 WS ${round} renamed`, discoverability: 'OPEN' } });
      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: ws.id, userId } },
        data: { leftAt: new Date() },
      });
      expect((await prisma.workspaceMember.findMany({ where: { userId, leftAt: null } })).map((m) => m.workspaceId))
        .toEqual([DEFAULT_WORKSPACE_ID]);

      // Delete: 호스트로 둔 채널이 있으면 워크스페이스를 지울 수 없다(D6 보관만, 실수로 지워도 채널은 보호)
      await expect(prisma.workspace.delete({ where: { id: ws.id } })).rejects.toMatchObject({ code: 'P2003' });
      await prisma.channel.delete({ where: { id: hosted.id } });
      await prisma.workspace.delete({ where: { id: ws.id } });
      expect(await prisma.workspaceMember.count({ where: { workspaceId: ws.id } })).toBe(0);
      expect(await prisma.workspace.findUnique({ where: { id: ws.id } })).toBeNull();
    }
  });
});
