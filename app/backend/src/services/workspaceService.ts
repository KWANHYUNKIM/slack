import { OrgRole, Prisma, Role } from '@prisma/client';

// 조직·워크스페이스(E1a). docs/specs/E1-multi-workspace.md 3절.
// 서버당 조직은 하나(D1)이고, 기본 조직·워크스페이스(id=1)는 마이그레이션 20261102010000이 만든다.
// 현재 워크스페이스 해석(X-Workspace-Id)은 E1b 범위라, 지금 생성 경로는 모두 기본 워크스페이스를 쓴다.
export const DEFAULT_ORGANIZATION_ID = 1;
export const DEFAULT_WORKSPACE_ID = 1;

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

// 채널 생성 data에 붙이는 호스트 연결. 채널과 ChannelWorkspace 호스트 행이 한 INSERT 문맥에서 함께 생긴다.
export function channelHostData(name: string, workspaceId = DEFAULT_WORKSPACE_ID, isDefault = false) {
  return {
    host: { connect: { id: workspaceId } },
    workspaces: { create: { workspaceId, isHost: true, isDefault, nameKey: channelNameKey(name) } },
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

// E1b~E1g 동안 User.role이 권한 판단의 원천이므로, 역할이 바뀌면 기본 워크스페이스 역할과 조직 역할을
// 같은 규칙(백필과 동일)으로 따라가게 한다. 그래야 E1b의 호환 심(req.user.role = WorkspaceMember.role)이
// 켜지는 순간에도 결과가 같다. 호출한 쪽이 User.role을 바꾸는 같은 트랜잭션에서 부른다.
export async function mirrorUserRole(db: Prisma.TransactionClient, userId: number, role: Role): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { orgRole: orgRoleFor(role) } });
  await db.workspaceMember.updateMany({
    where: { workspaceId: DEFAULT_WORKSPACE_ID, userId },
    data: { role },
  });
  if (role === 'OWNER') {
    await db.organization.update({ where: { id: DEFAULT_ORGANIZATION_ID }, data: { primaryOwnerId: userId } });
  }
}
