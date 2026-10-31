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

// 기본 워크스페이스가 아닌 워크스페이스 참여(MEMBER). 나갔던(leftAt) 사용자가 다시 들어오면 같은 행을 되살린다.
// 기본 워크스페이스 멤버십과 역할은 setUserRole이 쓴다. 다른 워크스페이스의 역할 변경은 E1b API가 맡는다.
export async function addWorkspaceMember(
  db: Prisma.TransactionClient,
  params: { workspaceId: number; userId: number; invitedBy?: number | null },
): Promise<void> {
  const { workspaceId, userId, invitedBy = null } = params;
  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, invitedBy },
    update: { leftAt: null, joinedAt: new Date(), invitedBy },
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
// 기본 워크스페이스 멤버십과 역할, 조직 주 소유자를 함께 맞춘다. 그래야 E1b의 호환 심(req.user.role = WorkspaceMember.role)이
// 켜지는 순간에도 결과가 같다. 다른 코드는 User.role을 직접 쓰지 않는다(tests/user-role-writes.test.ts가 검사).
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
