import { Prisma, Role } from '@prisma/client';
import prisma from '../db.js';
import { getWorkspaceState } from '../middleware/workspace.js';
import { ActiveMembership, activeMemberWhere, roleRank } from './workspaceService.js';

// 채널·사용자 범위 격리(E1c, docs/specs/E1-multi-workspace.md 5.3).
// 목록은 현재 워크스페이스(req.workspace.id)로 거르고, id로 오는 채널·사용자는 리소스에서 워크스페이스를 역산한다.
// 역산 규칙: 채널은 ChannelWorkspace(채널이 보이는 워크스페이스), 사용자는 활성 멤버십. 요청자와 겹치는 워크스페이스가
// 없으면 존재를 숨기려고 404다(D7). 겹치면 그 워크스페이스들에서의 요청자 역할(가장 높은 것)로 기존 규칙(게스트·관리자)을 판단한다.
// req.user.role(기본 워크스페이스 역할)은 바꾸지 않는다(E1b 결정). 헤더가 아니라 리소스에서 역할을 고르므로 헤더로 권한을 올릴 수 없다.

/** 사용자의 활성 멤버십. 요청에서 이미 읽은 것이 있으면 그것을 쓴다 */
export async function membershipsOf(userId: number, known?: ActiveMembership[]): Promise<ActiveMembership[]> {
  if (known) return known;
  return (await getWorkspaceState(userId))?.memberships ?? [];
}

/** 채널이 보이는 워크스페이스 id(오름차순). 채널이 없으면 빈 배열 */
export async function channelWorkspaceIds(channelId: number, db: Prisma.TransactionClient = prisma): Promise<number[]> {
  const rows = await db.channelWorkspace.findMany({
    where: { channelId },
    select: { workspaceId: true },
    orderBy: { workspaceId: 'asc' },
  });
  return rows.map((r) => r.workspaceId);
}

/**
 * 요청자가 workspaceIds 중 활성 멤버인 곳에서의 가장 높은 역할. 겹치는 워크스페이스가 없으면 null.
 * 가장 높은 역할을 쓰는 이유: 공유 채널(E1g)은 한쪽 게스트가 다른 쪽 멤버일 수 있고, 그 사람은 멤버로서 채널을 본다.
 */
export function roleInWorkspaces(memberships: ActiveMembership[], workspaceIds: number[]): Role | null {
  let best: Role | null = null;
  for (const m of memberships) {
    if (!workspaceIds.includes(m.workspaceId)) continue;
    if (best === null || roleRank(m.role) > roleRank(best)) best = m.role;
  }
  return best;
}

/** 요청자가 채널이 보이는 워크스페이스 중 하나에 활성 멤버인지와 그 역할 */
export async function channelScopeFor(
  userId: number,
  channelId: number,
  known?: ActiveMembership[],
): Promise<{ workspaceIds: number[]; role: Role | null }> {
  const [workspaceIds, memberships] = await Promise.all([channelWorkspaceIds(channelId), membershipsOf(userId, known)]);
  return { workspaceIds, role: roleInWorkspaces(memberships, workspaceIds) };
}

/**
 * 채널 멤버로 추가할 대상이 채널의 워크스페이스 중 하나에 활성 멤버인지(5.3). 그 워크스페이스에서의 대상 역할을 돌려준다.
 * 아니면 null(라우트가 400 USER_NOT_IN_WORKSPACE로 바꾼다). 계정 비활성은 호출한 쪽이 따로 본다.
 */
export async function targetRoleInChannelWorkspaces(
  targetUserId: number,
  workspaceIds: number[],
): Promise<Role | null> {
  return roleInWorkspaces(await membershipsOf(targetUserId), workspaceIds);
}

/** 워크스페이스 활성 멤버인 사용자 조건에 다른 조건을 더한다(사용자 목록과 관리 API의 대상 고르기) */
export function memberOfWorkspaceWhere(workspaceId: number, where: Prisma.UserWhereInput = {}): Prisma.UserWhereInput {
  return { AND: [where, activeMemberWhere(workspaceId)] };
}

/** 워크스페이스에 보이는 채널(공유 채널 포함) 조건에 다른 조건을 더한다. 채널 목록·관리·웹훅이 함께 쓴다 */
export function channelInWorkspaceWhere(workspaceId: number, where: Prisma.ChannelWhereInput = {}): Prisma.ChannelWhereInput {
  return { ...where, workspaces: { some: { workspaceId } } };
}

/**
 * 다른 사용자의 프로필·프레즌스를 볼 수 있는지(5.3). 본인, DM 이력이 있는 사람(게스트도, D3), 활성 워크스페이스를 하나 이상
 * 공유하는 사람. 공유 워크스페이스에서 요청자가 모두 게스트이면 기존 게스트 규칙(같은 채널에 있는 사람만)을 따른다.
 * 조직 관리자라도 공유 워크스페이스가 없으면 404다(관리는 /org, 스펙 5.2). 대상이 없으면 false.
 */
export async function canSeeUser(viewerId: number, targetId: number, known?: ActiveMembership[]): Promise<boolean> {
  if (viewerId === targetId) return true;
  if (await hasDmHistory(viewerId, targetId)) return true;
  const [viewer, target] = await Promise.all([membershipsOf(viewerId, known), membershipsOf(targetId)]);
  const role = roleInWorkspaces(viewer, target.map((m) => m.workspaceId));
  if (role === null) return false;
  if (role !== 'GUEST') return true;
  return sharesChannel(viewerId, targetId);
}

async function sharesChannel(userId: number, otherId: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT cm1."channelId" AS id
    FROM "ChannelMember" cm1
    JOIN "ChannelMember" cm2 ON cm2."channelId" = cm1."channelId"
    WHERE cm1."userId" = ${userId} AND cm2."userId" = ${otherId}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** 1:1 DM을 주고받았거나 같은 그룹 DM에 지금 함께 있다(D3: 기존 대화는 워크스페이스와 무관하게 유지) */
async function hasDmHistory(userId: number, otherId: number): Promise<boolean> {
  const [dm, group] = await Promise.all([
    prisma.directMessage.findFirst({
      where: {
        groupId: null,
        OR: [
          { fromUserId: userId, toUserId: otherId },
          { fromUserId: otherId, toUserId: userId },
        ],
      },
      select: { id: true },
    }),
    prisma.dMGroupMember.findFirst({
      where: { userId, group: { members: { some: { userId: otherId } } } },
      select: { userId: true },
    }),
  ]);
  return !!dm || !!group;
}
