import { OrgRole, Prisma, Role } from '@prisma/client';

// 조직·워크스페이스(E1a). docs/specs/E1-multi-workspace.md 3절.
// 서버당 조직은 하나(D1)이고, 기본 조직·워크스페이스(id=1)는 마이그레이션 20261102010000이 만든다.
// 기본 조직·워크스페이스의 이름은 빈 문자열로 저장하고, 화면은 번역 키(common:organization.defaultName,
// common:workspace.defaultName)로 보여 준다. 이름은 데이터라 첫 OWNER가 바꾸면 그 값이 그대로 쓰인다.
// 현재 워크스페이스 해석(X-Workspace-Id)은 E1b 범위라, 지금 생성 경로는 모두 기본 워크스페이스를 쓴다.
// 이 파일은 db.js를 가져오지 않는다(seed가 같은 함수를 쓰므로 클라이언트를 인자로 받는다).
export const DEFAULT_ORGANIZATION_ID = 1;
export const DEFAULT_WORKSPACE_ID = 1;
export const DEFAULT_ORGANIZATION_NAME = '';
export const DEFAULT_WORKSPACE_NAME = '';
export const DEFAULT_WORKSPACE_SLUG = 'main';

const NAME_KEY_MAX = 80;

// ChannelWorkspace.nameKey: 워크스페이스 안 채널 이름 유일성의 기준(대소문자 무시). 이 JS 규칙이 정답이다.
// 새 이름은 normalizeChannelName이 이미 소문자로 만들지만, 대문자가 남은 옛 이름도 같은 키가 되게 한 번 더 내린다.
// 로캘 독립 toLowerCase를 쓴다(normalizeChannelName과 같은 이유).
export function channelNameKey(name: string): string {
  return name.toLowerCase();
}

// 같은 워크스페이스에서 키가 겹치는 옛 채널의 키. 채널 이름에 쓸 수 없는 '~'와 채널 id를 붙인다(마이그레이션 백필과 같은 규칙).
// 길이는 VarChar(80)처럼 코드 포인트로 센다.
export function channelNameKeyWithSuffix(key: string, channelId: number): string {
  const suffix = `~${channelId}`;
  return Array.from(key).slice(0, NAME_KEY_MAX - suffix.length).join('') + suffix;
}

// 전역 역할(User.role)에서 조직 역할로. 마이그레이션 백필과 같은 규칙이다.
export function orgRoleFor(role: Role): OrgRole {
  if (role === 'OWNER') return 'OWNER';
  if (role === 'ADMIN') return 'ADMIN';
  return 'MEMBER';
}

// 호스트 여부는 따로 저장하지 않고 Channel.workspaceId와 같은 워크스페이스의 행인지로 판단한다(이중 저장 방지).
// 불변식: 모든 채널은 Channel.workspaceId 워크스페이스의 ChannelWorkspace 행을 정확히 하나 가진다.
export function isHostRow(row: { workspaceId: number }, channel: { workspaceId: number }): boolean {
  return row.workspaceId === channel.workspaceId;
}

// 채널 생성 data에 붙이는 호스트 연결. 채널과 호스트 워크스페이스 행이 한 번의 중첩 create로 함께 생긴다.
// isDefault는 "기본 채널로 지정됨", defaultSlot은 그 채널이 채우는 기본 채널 자리(general·random)다.
export function channelHostData(
  name: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
  opts: { isDefault?: boolean; defaultSlot?: string | null } = {},
) {
  const { isDefault = false, defaultSlot = null } = opts;
  return {
    host: { connect: { id: workspaceId } },
    workspaces: { create: { workspaceId, isDefault, defaultSlot, nameKey: channelNameKey(name) } },
  } satisfies Partial<Prisma.ChannelCreateInput>;
}

// 기본 워크스페이스가 아닌 워크스페이스 참여. 나갔던(leftAt) 사용자가 다시 들어오면 같은 행을 되살리고 역할을 새로 정한다.
// 기본 워크스페이스 멤버십과 역할은 setUserRole이 쓴다(joinWorkspace가 둘 중 하나를 고른다).
export async function addWorkspaceMember(
  db: Prisma.TransactionClient,
  params: { workspaceId: number; userId: number; invitedBy?: number | null; role?: Role },
): Promise<void> {
  const { workspaceId, userId, invitedBy = null, role = 'MEMBER' } = params;
  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, invitedBy, role },
    update: { leftAt: null, joinedAt: new Date(), invitedBy, role },
  });
}

export interface SetUserRoleOptions {
  /** 기본 워크스페이스 멤버십이 없으면 만든다(기본 true). 다른 워크스페이스로 초대된 가입자는 false */
  joinDefaultWorkspace?: boolean;
  /** 멤버십을 새로 만들 때 남길 초대한 사람 */
  invitedBy?: number | null;
  /** 이 사용자를 조직 주 소유자로 지정한다(소유권 이전). role이 OWNER일 때만 쓴다 */
  makePrimaryOwner?: boolean;
}

// 사용자 역할의 유일한 기록자. E1b~E1g 동안 User.role이 권한 판단의 원천이므로 User.role·orgRole(한 번의 update),
// 기본 워크스페이스 멤버십과 역할, 조직 주 소유자를 함께 맞춘다. 그래야 기본 워크스페이스 역할을 User.role로 읽든
// WorkspaceMember.role로 읽든 결과가 같다. 다른 코드는 User.role을 직접 쓰지 않는다(tests/user-role-writes.test.ts가 검사).
export async function setUserRole(
  db: Prisma.TransactionClient,
  userId: number,
  role: Role,
  opts: SetUserRoleOptions = {},
): Promise<void> {
  const { joinDefaultWorkspace = true, invitedBy = null, makePrimaryOwner = false } = opts;
  await db.user.update({ where: { id: userId }, data: { role, orgRole: orgRoleFor(role) } });
  if (joinDefaultWorkspace) {
    await db.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: DEFAULT_WORKSPACE_ID, userId } },
      create: { workspaceId: DEFAULT_WORKSPACE_ID, userId, role, invitedBy },
      update: { role },
    });
  } else {
    await db.workspaceMember.updateMany({ where: { workspaceId: DEFAULT_WORKSPACE_ID, userId }, data: { role } });
  }

  const org = await db.organization.findUniqueOrThrow({
    where: { id: DEFAULT_ORGANIZATION_ID },
    select: { primaryOwnerId: true },
  });
  if (role === 'OWNER') {
    // 이전 대상자는 명시적으로 주 소유자가 된다. 그 밖에는 비어 있을 때만 채운다(OWNER가 여럿일 수 있다).
    if (makePrimaryOwner || org.primaryOwnerId === null) {
      await db.organization.update({ where: { id: DEFAULT_ORGANIZATION_ID }, data: { primaryOwnerId: userId } });
    }
    return;
  }
  if (org.primaryOwnerId === userId) {
    // 주 소유자가 강등되면 남은 활성 OWNER 중 가장 오래된 사람으로 넘기고, 없으면 비운다.
    const next = await db.user.findFirst({
      where: { role: 'OWNER', deactivatedAt: null, organizationId: DEFAULT_ORGANIZATION_ID, id: { not: userId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    await db.organization.update({ where: { id: DEFAULT_ORGANIZATION_ID }, data: { primaryOwnerId: next?.id ?? null } });
  }
}

// 백필 SQL은 PostgreSQL lower()로 nameKey를 만들었다. DB 정렬 규칙(C 등)에 따라 비ASCII 대문자(É, İ)가 JS와 다르게
// 내려갈 수 있으므로, 서버 시작 때 한 번 JS 규칙(channelNameKey)과 다른 행을 고친다. 다시 돌려도 바뀌는 행이 없다(멱등).
// 맞는 키를 다른 채널이 이미 쓰고 있으면 접미사 규칙(channelNameKeyWithSuffix)을 쓴다. 예외 없이 끝나도록 먼저 확인하고 바꾼다.
// 표 이름을 스키마 없이 쓰는 raw 쿼리라 search_path를 따른다(마이그레이션 테스트가 임시 스키마에서 같은 함수를 돌린다).
export async function normalizeChannelNameKeys(db: Prisma.TransactionClient): Promise<number> {
  const rows = await db.$queryRaw<Array<{ channelId: number; workspaceId: number; nameKey: string; name: string }>>`
    SELECT cw."channelId", cw."workspaceId", cw."nameKey", c."name"
    FROM "ChannelWorkspace" cw JOIN "Channel" c ON c."id" = cw."channelId"
    ORDER BY cw."workspaceId", cw."channelId"`;
  let fixed = 0;
  for (const row of rows) {
    const expected = channelNameKey(row.name);
    const suffixed = channelNameKeyWithSuffix(expected, row.channelId);
    if (row.nameKey === expected || row.nameKey === suffixed) continue;
    const taken = await db.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one FROM "ChannelWorkspace"
      WHERE "workspaceId" = ${row.workspaceId} AND "nameKey" = ${expected} AND "channelId" <> ${row.channelId}`;
    const key = taken.length > 0 ? suffixed : expected;
    await db.$executeRaw`
      UPDATE "ChannelWorkspace" SET "nameKey" = ${key}
      WHERE "channelId" = ${row.channelId} AND "workspaceId" = ${row.workspaceId}`;
    fixed++;
  }
  return fixed;
}

// ─── 멤버십 해석(E1b) ───────────────────────────────────────────────
// 역할의 원천: 기본 워크스페이스는 User.role(setUserRole이 WorkspaceMember.role과 함께 맞춘다. E1h 전까지 권한 판단의 원천),
// 다른 워크스페이스는 WorkspaceMember.role. 테스트가 prisma로 User.role만 바꿔도 기본 워크스페이스 결과가 기존과 같다.
// 멤버십 행이 하나도 없는 사용자(E1a 이전 경로나 테스트가 prisma로 직접 만든 사용자)는 기본 워크스페이스의 암묵 멤버로 본다.
// 다른 워크스페이스로만 초대된 사용자는 그 행이 있으므로 기본 워크스페이스에 암묵 참여하지 않는다.

export interface ActiveMembership {
  workspaceId: number;
  role: Role;
  joinedAt: Date;
}

export interface UserWorkspaceState {
  userId: number;
  organizationId: number;
  orgRole: OrgRole;
  /** User.role. 기본 워크스페이스 역할과 같다 */
  userRole: Role;
  deactivated: boolean;
  defaultWorkspaceId: number | null;
  /** 활성(나가지 않음, 보관 안 됨) 멤버십. 참여한 순서 */
  memberships: ActiveMembership[];
}

const ROLE_RANK: Record<Role, number> = { GUEST: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function roleRank(role: Role): number {
  return ROLE_RANK[role];
}

export function isWorkspaceAdminRole(role: Role | null | undefined): boolean {
  return role === 'ADMIN' || role === 'OWNER';
}

export function isOrgAdminRole(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export const MEMBERSHIP_USER_SELECT = {
  id: true,
  role: true,
  orgRole: true,
  organizationId: true,
  defaultWorkspaceId: true,
  deactivatedAt: true,
  createdAt: true,
  workspaces: {
    select: {
      workspaceId: true, role: true, joinedAt: true, leftAt: true,
      workspace: { select: { archivedAt: true, organizationId: true } },
    },
  },
} satisfies Prisma.UserSelect;

type MembershipUser = Prisma.UserGetPayload<{ select: typeof MEMBERSHIP_USER_SELECT }>;

/** 조회한 사용자 행에서 활성 멤버십을 계산한다. defaultWorkspaceArchived는 암묵 멤버십 판단에만 쓴다 */
export function activeMembershipsOf(user: MembershipUser, defaultWorkspaceArchived: boolean): ActiveMembership[] {
  const memberships: ActiveMembership[] = [];
  for (const m of user.workspaces) {
    if (m.leftAt || m.workspace.archivedAt || m.workspace.organizationId !== user.organizationId) continue;
    memberships.push({
      workspaceId: m.workspaceId,
      role: m.workspaceId === DEFAULT_WORKSPACE_ID ? user.role : m.role,
      joinedAt: m.joinedAt,
    });
  }
  if (user.workspaces.length === 0 && user.organizationId === DEFAULT_ORGANIZATION_ID && !defaultWorkspaceArchived) {
    memberships.push({ workspaceId: DEFAULT_WORKSPACE_ID, role: user.role, joinedAt: user.createdAt });
  }
  return memberships.sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.workspaceId - b.workspaceId);
}

export async function isDefaultWorkspaceArchived(db: Prisma.TransactionClient): Promise<boolean> {
  const ws = await db.workspace.findUnique({ where: { id: DEFAULT_WORKSPACE_ID }, select: { archivedAt: true } });
  return !ws || ws.archivedAt !== null;
}

export async function loadUserWorkspaceState(db: Prisma.TransactionClient, userId: number): Promise<UserWorkspaceState | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: MEMBERSHIP_USER_SELECT });
  if (!user) return null;
  // 암묵 멤버십 후보일 때만 기본 워크스페이스 보관 여부를 따로 본다
  const defaultArchived = user.workspaces.length === 0 ? await isDefaultWorkspaceArchived(db) : false;
  return {
    userId: user.id,
    organizationId: user.organizationId,
    orgRole: user.orgRole,
    userRole: user.role,
    deactivated: user.deactivatedAt !== null,
    defaultWorkspaceId: user.defaultWorkspaceId,
    memberships: activeMembershipsOf(user, defaultArchived),
  };
}

export type WorkspacePick =
  | { ok: true; workspaceId: number; role: Role }
  | { ok: false; status: 400 | 403 | 404; code: 'INVALID_WORKSPACE_ID' | 'NO_WORKSPACE' | 'WORKSPACE_NOT_FOUND' };

const INT32_MAX = 2_147_483_647;

/** 워크스페이스 id 문자열(헤더·경로)을 양의 32비트 정수로. 아니면 null */
export function parseWorkspaceId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= INT32_MAX ? n : null;
}

/**
 * 현재 워크스페이스 고르기(스펙 5.2). 헤더가 있으면 그 값(형식이 틀리면 400, 활성 멤버가 아니면 404로 존재를 숨긴다),
 * 없으면 defaultWorkspaceId, 그것도 활성이 아니면 가장 먼저 참여한 활성 워크스페이스. 하나도 없으면 403 NO_WORKSPACE.
 */
export function pickWorkspace(state: UserWorkspaceState, header: string | string[] | undefined): WorkspacePick {
  if (header !== undefined) {
    const id = parseWorkspaceId(Array.isArray(header) ? undefined : header.trim());
    if (id === null) return { ok: false, status: 400, code: 'INVALID_WORKSPACE_ID' };
    const m = state.memberships.find((x) => x.workspaceId === id);
    if (!m) return { ok: false, status: 404, code: 'WORKSPACE_NOT_FOUND' };
    return { ok: true, workspaceId: m.workspaceId, role: m.role };
  }
  const preferred = state.memberships.find((x) => x.workspaceId === state.defaultWorkspaceId) ?? state.memberships[0];
  if (!preferred) return { ok: false, status: 403, code: 'NO_WORKSPACE' };
  return { ok: true, workspaceId: preferred.workspaceId, role: preferred.role };
}

/** 워크스페이스 활성 멤버를 고르는 User 조건(계정 비활성은 별개 축이라 여기서 거르지 않는다) */
export function activeMemberWhere(workspaceId: number): Prisma.UserWhereInput {
  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    return {
      organizationId: DEFAULT_ORGANIZATION_ID,
      OR: [{ workspaces: { some: { workspaceId, leftAt: null } } }, { workspaces: { none: {} } }],
    };
  }
  return { workspaces: { some: { workspaceId, leftAt: null } } };
}

/** 워크스페이스의 활성 OWNER 수(비활성 계정 제외) */
export async function countWorkspaceOwners(db: Prisma.TransactionClient, workspaceId: number): Promise<number> {
  const ownerWhere: Prisma.UserWhereInput = workspaceId === DEFAULT_WORKSPACE_ID
    ? { role: 'OWNER' }
    : { workspaces: { some: { workspaceId, leftAt: null, role: 'OWNER' } } };
  return db.user.count({ where: { AND: [activeMemberWhere(workspaceId), ownerWhere, { deactivatedAt: null }] } });
}

/** 트랜잭션 안에서 워크스페이스 행을 잠근다. 같은 워크스페이스의 OWNER 수를 바꾸는 요청(나가기·제거·강등)을 줄 세운다 */
export async function lockWorkspace(db: Prisma.TransactionClient, workspaceId: number): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
}

// 채널 이름 잠금의 첫 키. 두 정수 형식 advisory lock이라 한 정수 형식(legalHoldService)과 키 공간이 겹치지 않는다.
const CHANNEL_NAME_LOCK = 0x434e; // 'CN'

/**
 * 워크스페이스 안 채널 이름을 정하는 경로(기본 채널 자리 채우기, 채널 생성, 이름 변경)를 워크스페이스 단위로 줄 세운다(E1c).
 * 트랜잭션 안에서 불러야 하고 트랜잭션이 끝날 때 풀린다. 여러 워크스페이스는 id 오름차순으로 잠가 교착을 막는다.
 */
export async function lockWorkspaceChannelNames(db: Prisma.TransactionClient, workspaceIds: number[]): Promise<void> {
  for (const id of [...new Set(workspaceIds)].sort((a, b) => a - b)) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(${CHANNEL_NAME_LOCK}::int4, ${id}::int4)`;
  }
}

/** 마지막 OWNER를 빼거나 강등하려 할 때 던진다. 라우트가 409 LAST_WORKSPACE_OWNER로 바꾼다 */
export class LastWorkspaceOwnerError extends Error {
  constructor() {
    super('LAST_WORKSPACE_OWNER');
  }
}

/** 잠근 뒤 다시 읽어 보니 이미 활성 멤버일 때 던진다(초대 수락). 라우트가 409 USER_ALREADY_WORKSPACE_MEMBER로 바꾼다 */
export class AlreadyWorkspaceMemberError extends Error {
  constructor() {
    super('USER_ALREADY_WORKSPACE_MEMBER');
  }
}

/** 잠근 뒤 다시 읽어 보니 대상이 이미 활성 멤버가 아닐 때 던진다. 라우트가 404 USER_NOT_FOUND로 바꾼다 */
export class WorkspaceMemberGoneError extends Error {
  constructor() {
    super('WORKSPACE_MEMBER_GONE');
  }
}

/**
 * OWNER 수를 바꿀 수 있는 변경(나가기·제거·강등)의 공통 앞부분. 트랜잭션 안에서 워크스페이스 행을 잠근 뒤 대상의 지금 역할을
 * 다시 읽는다(요청 전에 읽은 역할은 그 사이 바뀌었을 수 있다). 잠금은 트랜잭션이 끝날 때 풀리므로 두 OWNER가 동시에 나가도
 * 하나만 성공한다. newRole은 바꿀 역할이고 나가기·제거는 null이다. OWNER에서 벗어나면 마지막 OWNER인지 확인한다.
 * 지금 역할을 돌려준다.
 */
export async function lockAndReadMemberRole(
  db: Prisma.TransactionClient,
  workspaceId: number,
  userId: number,
  newRole: Role | null,
): Promise<Role> {
  await lockWorkspace(db, workspaceId);
  const state = await loadUserWorkspaceState(db, userId);
  const current = state?.memberships.find((m) => m.workspaceId === workspaceId)?.role;
  if (!current) throw new WorkspaceMemberGoneError();
  if (current === 'OWNER' && newRole !== 'OWNER' && (await countWorkspaceOwners(db, workspaceId)) <= 1) {
    throw new LastWorkspaceOwnerError();
  }
  return current;
}

/**
 * 행이 하나도 없는 기본 워크스페이스 암묵 멤버가 다른 워크스페이스 행을 처음 얻기 전에 부른다.
 * 그대로 두면 행이 생기는 순간 암묵 멤버십이 사라지므로 기본 워크스페이스 행을 지금 역할(User.role)로 만든다.
 * 가입 경로(다른 워크스페이스 초대로 새로 만든 계정)는 부르지 않는다.
 */
export async function materializeImplicitDefaultMembership(db: Prisma.TransactionClient, userId: number): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, organizationId: true, _count: { select: { workspaces: true } } },
  });
  if (!user || user._count.workspaces > 0 || user.organizationId !== DEFAULT_ORGANIZATION_ID) return;
  if (await isDefaultWorkspaceArchived(db)) return;
  await db.workspaceMember.createMany({
    data: [{ workspaceId: DEFAULT_WORKSPACE_ID, userId, role: user.role }],
    skipDuplicates: true,
  });
}

/**
 * 워크스페이스에 넣는다(배정, 초대 수락, 공개 워크스페이스 참여). 기본 워크스페이스는 역할을 setUserRole로 쓰고
 * 나갔던 행을 되살린다. 다른 워크스페이스는 WorkspaceMember 행만 쓴다.
 */
export async function joinWorkspace(
  db: Prisma.TransactionClient,
  params: { workspaceId: number; userId: number; role: Role; invitedBy?: number | null },
): Promise<void> {
  const { workspaceId, userId, role, invitedBy = null } = params;
  if (workspaceId !== DEFAULT_WORKSPACE_ID) {
    await materializeImplicitDefaultMembership(db, userId);
    await addWorkspaceMember(db, { workspaceId, userId, role, invitedBy });
    return;
  }
  await setUserRole(db, userId, role, { joinDefaultWorkspace: true, invitedBy });
  await db.workspaceMember.updateMany({
    where: { workspaceId, userId, leftAt: { not: null } },
    data: { leftAt: null, joinedAt: new Date(), invitedBy },
  });
}

/** 워크스페이스 역할 변경. 기본 워크스페이스는 setUserRole이라 조직 역할도 함께 바뀐다(E1a 규칙) */
export async function changeWorkspaceRole(
  db: Prisma.TransactionClient,
  params: { workspaceId: number; userId: number; role: Role },
): Promise<void> {
  const { workspaceId, userId, role } = params;
  if (workspaceId === DEFAULT_WORKSPACE_ID) {
    await setUserRole(db, userId, role);
    return;
  }
  await db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { role } });
}

/**
 * 워크스페이스에서 뺀다(제거, 나가기). 행은 지우지 않고 leftAt을 채운다. 행이 없던 기본 워크스페이스 암묵 멤버는
 * 나간 행을 새로 만든다(다시 암묵 멤버가 되지 않게). 그 워크스페이스를 기본으로 기억하고 있으면 비운다.
 * 채널 정리(E1c, 스펙 5.3): 그 워크스페이스에 보이는 채널 중 남은 활성 워크스페이스 어디에도 보이지 않는 채널에서
 * ChannelMember와 즐겨찾기를 지운다. 공유 채널은 남은 워크스페이스에 여전히 보이면 유지한다. 읽음 행은 채널 나가기처럼 남긴다.
 * 그 결과 멤버가 아무도 남지 않은 비공개 채널은 채널 나가기(POST /channels/:id/leave)의 마지막 멤버 규칙처럼 지운다.
 * 단 보관된 채널(나가기 라우트도 막는다)과 법적 보존 채널은 기록 보호를 위해 남긴다.
 * 멤버십을 잃은 채널과 지운 채널(지우기 전의 workspaceIds 포함)을 돌려준다. 호출한 쪽이 소켓 room 정리와 이벤트를 보낸다.
 */
export async function leaveWorkspace(
  db: Prisma.TransactionClient,
  params: { workspaceId: number; userId: number; currentRole: Role },
): Promise<LeaveWorkspaceResult> {
  const { workspaceId, userId, currentRole } = params;
  const now = new Date();
  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, role: currentRole, leftAt: now },
    update: { leftAt: now },
  });
  await db.user.updateMany({ where: { id: userId, defaultWorkspaceId: workspaceId }, data: { defaultWorkspaceId: null } });

  const remaining = (await loadUserWorkspaceState(db, userId))?.memberships.map((m) => m.workspaceId) ?? [];
  const lost = await db.channelMember.findMany({
    where: {
      userId,
      channel: {
        workspaces: { some: { workspaceId }, none: { workspaceId: { in: remaining } } },
      },
    },
    select: { channelId: true },
  });
  const channelIds = lost.map((m) => m.channelId);
  if (channelIds.length === 0) return { lostChannelIds: [], deletedChannels: [] };
  await db.channelMember.deleteMany({ where: { userId, channelId: { in: channelIds } } });
  await db.channelStar.deleteMany({ where: { userId, channelId: { in: channelIds } } });

  const orphans = await db.channel.findMany({
    where: { id: { in: channelIds }, isPrivate: true, archivedAt: null, legalHold: false, members: { none: {} } },
    select: { id: true, workspaces: { select: { workspaceId: true }, orderBy: { workspaceId: 'asc' } } },
  });
  if (orphans.length > 0) await db.channel.deleteMany({ where: { id: { in: orphans.map((c) => c.id) } } });
  return {
    lostChannelIds: channelIds,
    deletedChannels: orphans.map((c) => ({ id: c.id, workspaceIds: c.workspaces.map((w) => w.workspaceId) })),
  };
}

export interface LeaveWorkspaceResult {
  /** 멤버십을 잃은 채널(지운 채널 포함) */
  lostChannelIds: number[];
  /** 마지막 멤버가 빠져 지운 비공개 채널과 지우기 전 보이던 워크스페이스 */
  deletedChannels: Array<{ id: number; workspaceIds: number[] }>;
}

/** 공개·미보관 기본 채널 가입(기본 워크스페이스가 아닌 곳). 기본 워크스페이스는 자리 채우기까지 하는 joinDefaultChannels를 쓴다 */
export async function joinWorkspaceDefaultChannels(db: Prisma.TransactionClient, workspaceId: number, userId: number): Promise<void> {
  const targets = await db.channel.findMany({
    where: { isPrivate: false, archivedAt: null, workspaces: { some: { workspaceId, isDefault: true } } },
    select: { id: true },
  });
  if (targets.length === 0) return;
  await db.channelMember.createMany({
    data: targets.map((c) => ({ userId, channelId: c.id })),
    skipDuplicates: true,
  });
}

/** 워크스페이스 주소(slug): 영문 소문자·숫자·하이픈 1~21자, 하이픈으로 시작하거나 끝나지 않는다 */
export const WORKSPACE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,19}[a-z0-9])?$/;

export const WORKSPACE_PUBLIC_SELECT = {
  id: true, slug: true, name: true, description: true, icon: true, discoverability: true,
} satisfies Prisma.WorkspaceSelect;

/**
 * 로그인 응답, GET /users/me, GET /workspaces가 함께 쓰는 조직·워크스페이스 정보.
 * 멤버십은 호출한 쪽이 이미 읽은 상태(authMiddleware가 req.workspaceState에 둔 것)를 받아 다시 조회하지 않는다.
 */
export async function workspaceSummaryForUser(db: Prisma.TransactionClient, state: UserWorkspaceState) {
  const [organization, workspaces] = await Promise.all([
    db.organization.findUnique({ where: { id: state.organizationId }, select: { id: true, name: true } }),
    db.workspace.findMany({
      where: { id: { in: state.memberships.map((m) => m.workspaceId) } },
      select: WORKSPACE_PUBLIC_SELECT,
    }),
  ]);
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  return {
    organization,
    orgRole: state.orgRole,
    defaultWorkspaceId: state.defaultWorkspaceId,
    workspaces: state.memberships.flatMap((m) => {
      const w = byId.get(m.workspaceId);
      return w ? [{ ...w, role: m.role }] : [];
    }),
  };
}
