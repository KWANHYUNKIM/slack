import { Prisma, Role } from '@prisma/client';
import prisma from '../db.js';
import { getIO, kickUser } from '../websocket/index.js';
import { invalidateTokenCache } from '../middleware/auth.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { logError } from '../utils/logger.js';
import { joinDefaultChannels } from './defaultChannelService.js';
import {
  DEFAULT_WORKSPACE_ID, LeaveWorkspaceResult, changeWorkspaceRole, lockAndReadMemberRole, joinWorkspace, joinWorkspaceDefaultChannels,
  leaveWorkspace,
} from './workspaceService.js';

// 워크스페이스 멤버십 변경(E1b)의 공통 경로: DB 쓰기 → 캐시 비우기 → 소켓 room 가입·탈퇴와 workspace:* 이벤트 → 감사 로그.
// 배정(/workspaces/:id/members), 초대 수락(/auth/invite/:code/accept), 공개 워크스페이스 참여·나가기가 함께 쓴다.

/** 멤버십·역할이 바뀌어 소켓을 끊을 때 보내는 사유 */
export const WORKSPACE_KICK_MESSAGE = 'Workspace membership changed';

export function workspaceRoom(workspaceId: number): string {
  return `ws:${workspaceId}`;
}

/** 게스트가 아닌 활성 멤버의 room(E1c). 공개 채널 이벤트(channelService.channelAudience)의 대상이다 */
export function workspaceMembersRoom(workspaceId: number): string {
  return `ws:${workspaceId}:members`;
}

/** 역할에 맞춰 대상 사용자의 모든 소켓을 비게스트 room에 넣거나 뺀다(참여·역할 변경 때) */
export function syncMembersRoom(userId: number, workspaceId: number, role: Role | null): void {
  const io = getIO();
  if (!io) return;
  if (role !== null && role !== 'GUEST') io.in(`user:${userId}`).socketsJoin(workspaceMembersRoom(workspaceId));
  else io.in(`user:${userId}`).socketsLeave(workspaceMembersRoom(workspaceId));
}

export type MemberAddSource = 'assign' | 'invite' | 'join';

/** 대상 사용자의 모든 소켓을 room에 넣고 본인과 워크스페이스 멤버에게 알린다. 배열 대상이라 본인은 한 번만 받는다 */
function announceAdded(workspaceId: number, userId: number, role: Role): void {
  const io = getIO();
  if (!io) return;
  io.in(`user:${userId}`).socketsJoin(workspaceRoom(workspaceId));
  syncMembersRoom(userId, workspaceId, role);
  io.to([`user:${userId}`, workspaceRoom(workspaceId)]).emit('workspace:member:added', { workspaceId, userId, role });
}

function announceRemoved(workspaceId: number, userId: number): void {
  const io = getIO();
  if (!io) return;
  io.to([`user:${userId}`, workspaceRoom(workspaceId)]).emit('workspace:member:removed', { workspaceId, userId });
  io.in(`user:${userId}`).socketsLeave([workspaceRoom(workspaceId), workspaceMembersRoom(workspaceId)]);
}

function announceUpdated(workspaceId: number, userId: number, role: Role): void {
  syncMembersRoom(userId, workspaceId, role);
  getIO()?.to([`user:${userId}`, workspaceRoom(workspaceId)]).emit('workspace:member:updated', { workspaceId, userId, role });
}

/**
 * 워크스페이스에 넣는다. 게스트가 아니면 그 워크스페이스의 기본 채널에도 넣는다(게스트는 관리자가 채널을 정한다).
 * channelIds는 호출한 쪽이 이 워크스페이스의 공개 채널인지 이미 확인한 값이다.
 */
export async function addMember(params: {
  workspaceId: number; userId: number; role: Role; actorId: number; source: MemberAddSource; channelIds?: number[];
  /** 멤버십에 남길 초대한 사람. 없으면 배정은 actorId, 직접 참여는 null */
  invitedBy?: number | null;
  /** 같은 트랜잭션에서 먼저 도는 확인(초대 사용 처리). false면 Error('INVITE_INVALID')로 되돌린다 */
  claim?: (tx: Prisma.TransactionClient) => Promise<boolean>;
}): Promise<void> {
  const { workspaceId, userId, role, actorId, source, channelIds = [], claim } = params;
  const invitedBy = params.invitedBy !== undefined ? params.invitedBy : source === 'join' ? null : actorId;
  await prisma.$transaction(async (tx) => {
    if (claim && !(await claim(tx))) throw new Error('INVITE_INVALID');
    await joinWorkspace(tx, { workspaceId, userId, role, invitedBy });
    if (channelIds.length > 0) {
      await tx.channelMember.createMany({ data: channelIds.map((channelId) => ({ userId, channelId })), skipDuplicates: true });
    }
  });
  invalidateTokenCache(userId);

  if (role !== 'GUEST') {
    try {
      if (workspaceId === DEFAULT_WORKSPACE_ID) await joinDefaultChannels(prisma, userId);
      else await joinWorkspaceDefaultChannels(prisma, workspaceId, userId);
    } catch (error) {
      // 기본 채널 가입 실패로 참여 자체를 되돌리지 않는다(가입 경로와 같은 규칙)
      logError('Workspace default channel join error', error);
    }
  }

  announceAdded(workspaceId, userId, role);
  const action = source === 'assign' ? 'workspace.member_added' : source === 'invite' ? 'workspace.invite_accepted' : 'workspace.joined';
  void writeAuditLog({
    action, actorId, targetType: 'user', targetId: userId,
    details: `workspaceId=${workspaceId}; role=${role}${channelIds.length ? `; channelIds=${channelIds.join(',')}` : ''}`,
  });
}

/**
 * 워크스페이스를 떠나며 멤버십을 잃은 채널: 채널 나가기와 같은 이벤트를 보내고 대상 소켓을 채널 room에서 뺀다.
 * 마지막 멤버가 빠져 지운 비공개 채널은 channel:deleted를 그 채널의 마지막 멤버였던 대상(다른 탭)에게 보내고 room을 비운다.
 */
async function announceChannelsLeft(userId: number, left: LeaveWorkspaceResult): Promise<void> {
  const io = getIO();
  if (!io || left.lostChannelIds.length === 0) return;
  const deleted = new Map(left.deletedChannels.map((c) => [c.id, c.workspaceIds]));
  const remainingIds = left.lostChannelIds.filter((id) => !deleted.has(id));
  const counts = remainingIds.length > 0
    ? await prisma.channelMember.groupBy({ by: ['channelId'], where: { channelId: { in: remainingIds } }, _count: { _all: true } })
    : [];
  const countOf = new Map(counts.map((c) => [c.channelId, c._count._all]));
  for (const channelId of remainingIds) {
    io.to(`channel:${channelId}`).emit('channel:member-left', { channelId, userId, memberCount: countOf.get(channelId) ?? 0 });
    io.in(`user:${userId}`).socketsLeave(`channel:${channelId}`);
  }
  for (const [channelId, workspaceIds] of deleted) {
    io.to(`user:${userId}`).emit('channel:deleted', { channelId, workspaceIds });
    io.in(`channel:${channelId}`).socketsLeave(`channel:${channelId}`);
  }
}

export async function updateMemberRole(params: {
  workspaceId: number; userId: number; role: Role; actorId: number;
}): Promise<Role> {
  const { workspaceId, userId, role, actorId } = params;
  const previousRole = await prisma.$transaction(async (tx) => {
    const current = await lockAndReadMemberRole(tx, workspaceId, userId, role);
    if (current !== role) await changeWorkspaceRole(tx, { workspaceId, userId, role });
    return current;
  });
  if (previousRole === role) return previousRole;
  invalidateTokenCache(userId);
  announceUpdated(workspaceId, userId, role);
  // 기본 워크스페이스 역할은 User.role이라 소켓의 socket.user.role도 바뀐다. 남은 소켓을 끊어 새 역할로 다시 붙게 한다
  // (/admin 역할 변경과 같은 규칙). 다른 워크스페이스 역할은 소켓이 들고 있지 않으므로 이벤트만 보낸다.
  if (workspaceId === DEFAULT_WORKSPACE_ID) kickUser(userId, WORKSPACE_KICK_MESSAGE);
  void writeAuditLog({
    action: 'workspace.member_role_changed', actorId, targetType: 'user', targetId: userId,
    details: `workspaceId=${workspaceId}; from=${previousRole}; to=${role}`,
  });
  return previousRole;
}

export async function removeMember(params: {
  workspaceId: number; userId: number; actorId: number; self: boolean;
}): Promise<void> {
  const { workspaceId, userId, actorId, self } = params;
  const { currentRole, left } = await prisma.$transaction(async (tx) => {
    const current = await lockAndReadMemberRole(tx, workspaceId, userId, null);
    return { currentRole: current, left: await leaveWorkspace(tx, { workspaceId, userId, currentRole: current }) };
  });
  invalidateTokenCache(userId);
  // 연결은 끊지 않는다. 대상 소켓을 ws:<id> room에서 빼고 workspace:member:removed로 알린다
  announceRemoved(workspaceId, userId);
  await announceChannelsLeft(userId, left);
  void writeAuditLog({
    action: self ? 'workspace.left' : 'workspace.member_removed', actorId, targetType: 'user', targetId: userId,
    details: `workspaceId=${workspaceId}; role=${currentRole}`,
  });
}
