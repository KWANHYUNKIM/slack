import { OrgRole, Prisma, Role } from '@prisma/client';

// 조직·워크스페이스(E1a). docs/specs/E1-multi-workspace.md 3절.
// 서버당 조직은 하나(D1)이고, 기본 조직·워크스페이스(id=1)는 마이그레이션 20261102010000이 만든다.
// 기본 조직·워크스페이스의 이름은 빈 문자열로 저장하고, 화면은 번역 키(common:organization.defaultName,
// common:workspace.defaultName)로 보여 준다. 이름은 데이터라 첫 OWNER가 바꾸면 그 값이 그대로 쓰인다.
// 현재 워크스페이스 해석(X-Workspace-Id)은 E1b 범위라, 지금 생성 경로는 모두 기본 워크스페이스를 쓴다.
export const DEFAULT_ORGANIZATION_ID = 1;
export const DEFAULT_WORKSPACE_ID = 1;
export const DEFAULT_ORGANIZATION_NAME = '';
export const DEFAULT_WORKSPACE_NAME = '';
export const DEFAULT_WORKSPACE_SLUG = 'main';

// ChannelWorkspace.nameKey: 워크스페이스 안 채널 이름 유일성의 기준(대소문자 무시).
// 새 이름은 normalizeChannelName이 이미 소문자로 만들지만, 대문자가 남은 옛 이름도 같은 키가 되게 한 번 더 내린다.
// 로캘 독립 toLowerCase를 쓴다(normalizeChannelName과 같은 이유).
export function channelNameKey(name: string): string {
  return name.toLowerCase();
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
export function channelHostData(name: string, workspaceId = DEFAULT_WORKSPACE_ID, isDefault = false) {
  return {
    host: { connect: { id: workspaceId } },
    workspaces: { create: { workspaceId, isDefault, nameKey: channelNameKey(name) } },
  } satisfies Partial<Prisma.ChannelCreateInput>;
}

// 워크스페이스 참여. 나갔던(leftAt) 사용자가 다시 들어오면 같은 행을 되살린다.
export async function addWorkspaceMember(
  db: Prisma.TransactionClient,
  params: { workspaceId: number; userId: number; role: Role; invitedBy?: number | null },
): Promise<void> {
  const { workspaceId, userId, role, invitedBy = null } = params;
  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId, userId } },
    create: { workspaceId, userId, role, invitedBy },
    update: { role, leftAt: null, joinedAt: new Date(), invitedBy },
  });
}

// 사용자 역할을 바꾸는 유일한 경로. E1b~E1g 동안 User.role이 권한 판단의 원천이므로 조직 역할, 기본 워크스페이스 역할,
// 조직 주 소유자를 같은 규칙(백필과 동일)으로 함께 맞춘다. 그래야 E1b의 호환 심(req.user.role = WorkspaceMember.role)이
// 켜지는 순간에도 결과가 같다. 다른 코드는 User.role을 직접 쓰지 않는다(tests/user-role-writes.test.ts가 검사).
// 여러 사용자의 역할을 함께 바꿀 때(소유권 이전)는 같은 트랜잭션에서 올리는 쪽을 먼저 부른다.
export async function setUserRole(db: Prisma.TransactionClient, userId: number, role: Role): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { role, orgRole: orgRoleFor(role) } });
  await db.workspaceMember.updateMany({
    where: { workspaceId: DEFAULT_WORKSPACE_ID, userId },
    data: { role },
  });

  const org = await db.organization.findUniqueOrThrow({
    where: { id: DEFAULT_ORGANIZATION_ID },
    select: { primaryOwnerId: true },
  });
  if (role === 'OWNER') {
    // 주 소유자가 비어 있을 때만 채운다. 이미 있으면 그대로 둔다(OWNER가 여럿일 수 있다).
    if (org.primaryOwnerId === null) {
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
