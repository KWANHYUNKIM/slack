import { TEST_PASSWORD } from './test-constants.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import app from '../app.js';
import prisma from '../db.js';
import { createInitialOwner } from '../services/bootstrapService.js';
import {
  DEFAULT_ORGANIZATION_ID, DEFAULT_WORKSPACE_ID, channelHostData, isHostRow, setUserRole,
} from '../services/workspaceService.js';

// E1a 조직·워크스페이스 스키마와 백필(docs/specs/E1-multi-workspace.md 4.2절).
// 1) 마이그레이션 SQL을 옛 형태의 표가 있는 임시 스키마에 트랜잭션으로 적용해 백필 결과를 확인하고 ROLLBACK한다.
// 2) 이미 마이그레이션된 테스트 DB에서 가입·부트스트랩·채널 생성·이름 변경·비공개 전환·보관·역할 변경·삭제가
//    새 행을 맞게 쓰는지 생성·조회·수정·삭제로 반복한다.

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
  // 10: 가장 먼저 만든 OWNER지만 비활성이라 주 소유자가 되지 않는다
  `INSERT INTO "User" ("id", "email", "role", "deactivatedAt", "createdAt") VALUES
     (10, 'old-owner@e1.test', 'OWNER', '2026-02-01', '2025-12-31'),
     (11, 'owner@e1.test', 'OWNER', NULL, '2026-01-01'),
     (12, 'admin@e1.test', 'ADMIN', NULL, '2026-01-02'),
     (13, 'member@e1.test', 'MEMBER', NULL, '2026-01-03'),
     (14, 'guest@e1.test', 'GUEST', NULL, '2026-01-04'),
     (15, 'gone@e1.test', 'MEMBER', '2026-02-01', '2026-01-05'),
     (16, 'owner2@e1.test', 'OWNER', NULL, '2026-01-06')`,
  // random은 보관돼 있어 기본 채널이 아니다
  `INSERT INTO "Channel" ("id", "name", "isPrivate", "archivedAt") VALUES
     (21, 'general', false, NULL),
     (22, 'random', false, '2026-03-01'),
     (23, 'Dev', false, NULL),
     (24, 'dev', false, NULL),
     (25, 'secret', true, NULL),
     (26, 'old', false, '2026-03-01')`,
  `INSERT INTO "InviteLink" ("code", "createdBy") VALUES ('legacy-a', 11), ('legacy-b', 12)`,
];

// 불변식: 모든 채널은 호스트 워크스페이스(Channel.workspaceId)의 ChannelWorkspace 행을 정확히 하나 가진다
async function channelsBreakingHostInvariant(db: Prisma.TransactionClient): Promise<number[]> {
  const rows = await db.$queryRaw<Array<{ id: number }>>`
    SELECT c."id" FROM "Channel" c
    WHERE (SELECT count(*) FROM "ChannelWorkspace" cw WHERE cw."channelId" = c."id" AND cw."workspaceId" = c."workspaceId") <> 1
    ORDER BY c."id"`;
  return rows.map((r) => r.id);
}

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
      channels: await tx.$queryRaw<Array<{ id: number; channelWorkspaceId: number; rowWorkspaceId: number; isDefault: boolean; nameKey: string }>>`
        SELECT c."id", c."workspaceId" AS "channelWorkspaceId", cw."workspaceId" AS "rowWorkspaceId", cw."isDefault", cw."nameKey"
        FROM "Channel" c JOIN "ChannelWorkspace" cw ON cw."channelId" = c."id" ORDER BY c."id"`,
      broken: await channelsBreakingHostInvariant(tx),
      invites: await tx.$queryRaw<Array<{ workspaceId: number }>>`SELECT "workspaceId" FROM "InviteLink"`,
      org: await tx.$queryRaw<Array<{ id: number; name: string; primaryOwnerId: number | null }>>`
        SELECT "id", "name", "primaryOwnerId" FROM "Organization"`,
      workspaces: await tx.$queryRaw<Array<{ id: number; organizationId: number; slug: string; name: string; discoverability: string }>>`
        SELECT "id", "organizationId", "slug", "name", "discoverability"::text FROM "Workspace"`,
      nextWorkspaceId: (await tx.$queryRaw<Array<{ id: number }>>`
        INSERT INTO "Workspace" ("organizationId", "slug", "name") VALUES (1, 'second', 'Second') RETURNING "id"`)[0].id,
    }));

    // 행 수: User = WorkspaceMember, 채널마다 호스트 워크스페이스 행 하나
    expect(snapshot.members).toHaveLength(snapshot.users.length);
    expect(snapshot.channels).toHaveLength(6);
    expect(snapshot.broken).toEqual([]);
    expect(snapshot.channels.every((c) => c.channelWorkspaceId === 1 && isHostRow({ workspaceId: c.rowWorkspaceId }, { workspaceId: c.channelWorkspaceId }))).toBe(true);

    // 역할 매핑: 워크스페이스 역할은 그대로, 조직 역할은 OWNER/ADMIN만 올라간다. 비활성 사용자도 멤버다.
    const orgRoles = Object.fromEntries(snapshot.users.map((u) => [u.id, u.orgRole]));
    expect(orgRoles).toEqual({ 10: 'OWNER', 11: 'OWNER', 12: 'ADMIN', 13: 'MEMBER', 14: 'MEMBER', 15: 'MEMBER', 16: 'OWNER' });
    for (const m of snapshot.members) {
      expect(m.workspaceId).toBe(1);
      expect(m.role).toBe(snapshot.users.find((u) => u.id === m.userId)!.role);
      expect(m.joinedOk).toBe(true);
      expect(m.leftAt).toBeNull();
    }
    expect(snapshot.users.every((u) => u.organizationId === 1 && u.defaultWorkspaceId === 1)).toBe(true);

    // 주 소유자는 활성 OWNER 중 가장 오래된 사람(비활성 10은 건너뛴다). 이름은 빈 문자열(화면은 번역 키로 표시)
    expect(snapshot.org).toEqual([{ id: 1, name: '', primaryOwnerId: 11 }]);
    expect(snapshot.workspaces).toEqual([{ id: 1, organizationId: 1, slug: 'main', name: '', discoverability: 'INVITE_ONLY' }]);
    // id를 직접 넣은 뒤에도 시퀀스가 맞아 다음 워크스페이스는 2다
    expect(snapshot.nextWorkspaceId).toBe(2);

    // 기본 채널은 공개·미보관 general·random만, 대소문자만 다른 옛 이름은 nameKey가 겹치지 않게 접미사를 받는다
    const byId = Object.fromEntries(snapshot.channels.map((c) => [c.id, c]));
    expect(byId[21]).toMatchObject({ isDefault: true, nameKey: 'general' });
    expect(byId[22]).toMatchObject({ isDefault: false, nameKey: 'random' });
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

  async function register(email: string) {
    const res = await request(app).post('/auth/register').send({ email, password: TEST_PASSWORD, name: email.split('@')[0] });
    expect(res.status).toBe(201);
    return { id: res.body.user.id as number, token: res.body.token as string };
  }

  async function membership(userId: number) {
    return prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: DEFAULT_WORKSPACE_ID, userId } } });
  }

  async function joinedChannelNames(userId: number) {
    const rows = await prisma.channelMember.findMany({ where: { userId }, include: { channel: { select: { name: true } } } });
    return rows.map((r) => r.channel.name).sort();
  }

  async function primaryOwnerId() {
    return (await prisma.organization.findUniqueOrThrow({ where: { id: DEFAULT_ORGANIZATION_ID } })).primaryOwnerId;
  }

  beforeEach(resetDb);
  // 각 테스트의 앱 경로가 만든 채널은 모두 호스트 행 불변식을 지킨다
  afterEach(async () => {
    expect(await channelsBreakingHostInvariant(prisma)).toEqual([]);
  });

  it('bootstrap owner becomes primary owner and workspace OWNER, deleting the user cascades', async () => {
    const owner = await createInitialOwner({ email: 'e1-owner@example.com', password: TEST_PASSWORD, name: 'E1 Owner' });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(user).toMatchObject({ role: 'OWNER', organizationId: DEFAULT_ORGANIZATION_ID, orgRole: 'OWNER', defaultWorkspaceId: DEFAULT_WORKSPACE_ID });
    expect(await membership(owner.id)).toMatchObject({ role: 'OWNER', leftAt: null });
    expect(await primaryOwnerId()).toBe(owner.id);

    // 기본 채널은 기본 워크스페이스의 기본 채널(호스트 행)로 만들어진다
    const defaults = await prisma.channelWorkspace.findMany({
      where: { workspaceId: DEFAULT_WORKSPACE_ID, isDefault: true },
      include: { channel: { select: { name: true, workspaceId: true } } },
    });
    expect(defaults.map((d) => d.channel.name).sort()).toEqual(['general', 'random']);
    expect(defaults.every((d) => isHostRow(d, d.channel))).toBe(true);

    // Delete: 사용자를 지우면 멤버십이 연쇄로 지워지고 주 소유자는 비워진다
    await prisma.auditLog.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.user.delete({ where: { id: owner.id } });
    expect(await membership(owner.id)).toBeNull();
    expect(await primaryOwnerId()).toBeNull();
  });

  it('invite registration joins the invite workspace with the invite role and inviter', async () => {
    const admin = await register('e1-admin@example.com');
    expect(await membership(admin.id)).toMatchObject({ role: 'MEMBER', invitedBy: null });
    await prisma.$transaction((tx) => setUserRole(tx, admin.id, 'ADMIN'));
    const adminToken = await login('e1-admin@example.com');

    // 관리자 API로 만든 초대는 기본 워크스페이스를 가리킨다
    const invite = await request(app).post('/admin/invites').set('Authorization', `Bearer ${adminToken}`).send({ role: 'GUEST' });
    expect(invite.status).toBe(201);
    const stored = await prisma.inviteLink.findUniqueOrThrow({ where: { code: invite.body.code } });
    expect(stored.workspaceId).toBe(DEFAULT_WORKSPACE_ID);

    const guestRes = await request(app).post('/auth/register')
      .send({ email: 'e1-guest@example.com', password: TEST_PASSWORD, name: 'E1 Guest', inviteCode: invite.body.code });
    expect(guestRes.status).toBe(201);
    expect(guestRes.body.user.role).toBe('GUEST');
    const guestId = guestRes.body.user.id as number;
    expect(await membership(guestId)).toMatchObject({ role: 'GUEST', invitedBy: admin.id, leftAt: null });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: guestId } }))
      .toMatchObject({ role: 'GUEST', orgRole: 'MEMBER', defaultWorkspaceId: DEFAULT_WORKSPACE_ID, organizationId: DEFAULT_ORGANIZATION_ID });
  });

  it('channel create, rename and delete keep the host ChannelWorkspace row in sync', async () => {
    const { token } = await register('e1-maker@example.com');

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
      expect(host).toMatchObject({ isDefault: false, nameKey: `e1-chan-${round}` });
      expect((await prisma.channel.findUniqueOrThrow({ where: { id: channelId } })).workspaceId).toBe(DEFAULT_WORKSPACE_ID);

      // Update: 이름을 바꾸면 nameKey도 바뀐다
      const renamed = await request(app).patch(`/channels/${channelId}`).set('Authorization', `Bearer ${token}`)
        .send({ name: `e1-renamed-${round}` });
      expect(renamed.status).toBe(200);
      const after = await prisma.channelWorkspace.findMany({ where: { channelId } });
      expect(after.map((r) => r.nameKey)).toEqual([`e1-renamed-${round}`]);

      // 같은 워크스페이스에서 대소문자만 다른 이름은 nameKey 유니크에 걸린다(DB 수준, 채널 생성 자체가 원자적으로 실패)
      await expect(prisma.channel.create({ data: { name: `E1-Renamed-${round}`, ...channelHostData(`E1-Renamed-${round}`) } }))
        .rejects.toMatchObject({ code: 'P2002' });
      expect(await prisma.channel.count({ where: { name: `E1-Renamed-${round}` } })).toBe(0);

      // Delete: 채널을 지우면 연결 행도 사라진다
      await prisma.channel.delete({ where: { id: channelId } });
      expect(await prisma.channelWorkspace.count({ where: { channelId } })).toBe(0);
    }
  });

  it('default channels follow isDefault: rename keeps it, private or archived drops it', async () => {
    await createInitialOwner({ email: 'e1-def-owner@example.com', password: TEST_PASSWORD, name: 'Def Owner' });
    const ownerToken = await login('e1-def-owner@example.com');
    const general = await prisma.channel.findFirstOrThrow({ where: { name: 'general' } });
    const random = await prisma.channel.findFirstOrThrow({ where: { name: 'random' } });

    // #general 이름을 바꿔도 기본 채널로 남고, 새 가입자가 들어가도 general이 새로 생기지 않는다
    const renamed = await request(app).patch(`/channels/${general.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'lobby' });
    expect(renamed.status).toBe(200);
    expect((await prisma.channelWorkspace.findFirstOrThrow({ where: { channelId: general.id } })).isDefault).toBe(true);
    const u1 = await register('e1-def-1@example.com');
    expect(await joinedChannelNames(u1.id)).toEqual(['lobby', 'random']);
    expect(await prisma.channel.count({ where: { name: 'general' } })).toBe(0);

    // 비공개로 바꾸면 자동 가입 대상이 아니다
    const priv = await request(app).patch(`/admin/channels/${random.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ isPrivate: true });
    expect(priv.status).toBe(200);
    expect((await prisma.channelWorkspace.findFirstOrThrow({ where: { channelId: random.id } })).isDefault).toBe(false);
    const u2 = await register('e1-def-2@example.com');
    expect(await joinedChannelNames(u2.id)).toEqual(['lobby']);

    // 보관해도 빠진다. 기본 채널이 하나도 남지 않으면 그때만 general을 새로 만들고(random은 비공개라 건너뜀)
    const archived = await request(app).post(`/admin/channels/${general.id}/archive`).set('Authorization', `Bearer ${ownerToken}`);
    expect(archived.status).toBe(200);
    expect((await prisma.channelWorkspace.findFirstOrThrow({ where: { channelId: general.id } })).isDefault).toBe(false);
    const u3 = await register('e1-def-3@example.com');
    expect(await joinedChannelNames(u3.id)).toEqual(['general']);
    const fresh = await prisma.channel.findFirstOrThrow({ where: { name: 'general' }, include: { workspaces: true } });
    expect(fresh.workspaces).toEqual([expect.objectContaining({ workspaceId: DEFAULT_WORKSPACE_ID, isDefault: true, nameKey: 'general' })]);
    expect(await prisma.channel.count({ where: { name: 'random' } })).toBe(1);

    // 다음 가입자는 다시 만들지 않고 같은 general에 들어간다
    const u4 = await register('e1-def-4@example.com');
    expect(await joinedChannelNames(u4.id)).toEqual(['general']);
    expect(await prisma.channel.count({ where: { name: 'general' } })).toBe(1);
  });

  it('uses an existing channel that differs only in case as the default instead of creating one', async () => {
    const upper = await prisma.channel.create({ data: { name: 'General', ...channelHostData('General') } });
    const u = await register('e1-case@example.com');
    expect(await joinedChannelNames(u.id)).toEqual(['General', 'random']);
    expect(await prisma.channel.count({ where: { name: 'general' } })).toBe(0);
    expect((await prisma.channelWorkspace.findFirstOrThrow({ where: { channelId: upper.id } })).isDefault).toBe(true);
  });

  it('role change and ownership transfer mirror into workspace role, org role and primary owner', async () => {
    const owner = await createInitialOwner({ email: 'e1-own@example.com', password: TEST_PASSWORD, name: 'E1 Own' });
    const ownerToken = await login('e1-own@example.com');
    const member = await register('e1-mem@example.com');

    // Update: MEMBER → ADMIN → MEMBER → ADMIN 반복
    for (const role of ['ADMIN', 'MEMBER', 'ADMIN'] as const) {
      const changed = await request(app).patch(`/admin/users/${member.id}`).set('Authorization', `Bearer ${ownerToken}`).send({ role });
      expect(changed.status).toBe(200);
      expect(changed.body.role).toBe(role);
      expect((await membership(member.id))!.role).toBe(role);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: member.id } })).orgRole).toBe(role);
    }

    const transfer = await request(app).post('/admin/transfer-ownership').set('Authorization', `Bearer ${ownerToken}`)
      .send({ userId: member.id });
    expect(transfer.status).toBe(200);
    expect((await membership(member.id))!.role).toBe('OWNER');
    expect((await membership(owner.id))!.role).toBe('ADMIN');
    expect(await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).toMatchObject({ role: 'ADMIN', orgRole: 'ADMIN' });
    expect(await primaryOwnerId()).toBe(member.id);
  });

  it('demoting the primary owner hands it to the oldest remaining active OWNER, or clears it', async () => {
    const a = await createInitialOwner({ email: 'e1-po-a@example.com', password: TEST_PASSWORD, name: 'A' });
    const b = await register('e1-po-b@example.com');
    const c = await register('e1-po-c@example.com');
    await prisma.$transaction(async (tx) => {
      await setUserRole(tx, c.id, 'OWNER');
      await setUserRole(tx, b.id, 'OWNER');
    });
    // 다른 사람을 OWNER로 올려도 주 소유자는 그대로
    expect(await primaryOwnerId()).toBe(a.id);

    // A 강등 → 활성 OWNER 중 가장 오래된 B
    await prisma.$transaction((tx) => setUserRole(tx, a.id, 'ADMIN'));
    expect(await primaryOwnerId()).toBe(b.id);

    // B가 비활성이면 건너뛴다: B 강등 전 비활성화 → C
    await prisma.user.update({ where: { id: b.id }, data: { deactivatedAt: new Date() } });
    await prisma.$transaction((tx) => setUserRole(tx, b.id, 'MEMBER'));
    expect(await primaryOwnerId()).toBe(c.id);

    // 마지막 OWNER 강등 → 비움, 다시 OWNER가 생기면 채운다
    await prisma.$transaction((tx) => setUserRole(tx, c.id, 'MEMBER'));
    expect(await primaryOwnerId()).toBeNull();
    await prisma.$transaction((tx) => setUserRole(tx, a.id, 'OWNER'));
    expect(await primaryOwnerId()).toBe(a.id);
    expect(await membership(a.id)).toMatchObject({ role: 'OWNER' });
    expect(await membership(c.id)).toMatchObject({ role: 'MEMBER' });
  });

  it('workspace rows: create, read, update, delete with unique slug and restricted host delete', async () => {
    const { id: userId } = await register('e1-ws@example.com');

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

      // 같은 nameKey 채널을 다른 워크스페이스에 호스트할 수 있다(워크스페이스 단위 유일성)
      expect(await prisma.channelWorkspace.findFirst({ where: { workspaceId: DEFAULT_WORKSPACE_ID, nameKey: 'general' } })).not.toBeNull();
      const hosted = await prisma.channel.create({ data: { name: `e1-hosted-${round}`, ...channelHostData('general', ws.id) } });

      // Read
      const read = await prisma.workspace.findUniqueOrThrow({
        where: { id: ws.id },
        include: { members: true, channels: true, hostedChannels: true },
      });
      expect(read.members).toEqual([expect.objectContaining({ userId, role: 'ADMIN', leftAt: null })]);
      expect(read.channels.map((c) => c.channelId)).toEqual([hosted.id]);
      expect(read.hostedChannels.map((c) => c.id)).toEqual([hosted.id]);
      expect(isHostRow(read.channels[0], hosted)).toBe(true);

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
