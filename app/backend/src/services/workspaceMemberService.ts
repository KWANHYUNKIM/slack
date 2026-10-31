import { Prisma, Role } from '@prisma/client';
import prisma from '../db.js';
import { getIO } from '../websocket/index.js';
import { invalidateTokenCache } from '../middleware/auth.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { logError } from '../utils/logger.js';
import { joinDefaultChannels } from './defaultChannelService.js';
import {
  DEFAULT_WORKSPACE_ID, changeWorkspaceRole, joinWorkspace, joinWorkspaceDefaultChannels, leaveWorkspace,
} from './workspaceService.js';

// 워크스페이스 멤버십 변경(E1b)의 공통 경로: DB 쓰기 → 캐시 비우기 → 소켓 room 가입·탈퇴와 workspace:* 이벤트 → 감사 로그.
// 배정(/workspaces/:id/members), 초대 수락(/auth/invite/:code/accept), 공개 워크스페이스 참여·나가기가 함께 쓴다.

export function workspaceRoom(workspaceId: number): string {
  return `ws:${workspaceId}`;
}

export type MemberAddSource = 'assign' | 'invite' | 'join';

/** 대상 사용자의 모든 소켓을 room에 넣고 본인과 워크스페이스 멤버에게 알린다. 배열 대상이라 본인은 한 번만 받는다 */
function announceAdded(workspaceId: number, userId: number, role: Role): void {
  const io = getIO();
  if (!io) return;
  io.in(`user:${userId}`).socketsJoin(workspaceRoom(workspaceId));
  io.to([`user:${userId}`, workspaceRoom(workspaceId)]).emit('workspace:member:added', { workspaceId, userId, role });
}

function announceRemoved(workspaceId: number, userId: number): void {
  const io = getIO();
  if (!io) return;
  io.to([`user:${userId}`, workspaceRoom(workspaceId)]).emit('workspace:member:removed', { workspaceId, userId });
  io.in(`user:${userId}`).socketsLeave(workspaceRoom(workspaceId));
}

function announceUpdated(workspaceId: number, userId: number, role: Role): void {
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

export async function updateMemberRole(params: {
  workspaceId: number; userId: number; role: Role; previousRole: Role; actorId: number;
}): Promise<void> {
  const { workspaceId, userId, role, previousRole, actorId } = params;
  await prisma.$transaction((tx) => changeWorkspaceRole(tx, { workspaceId, userId, role }));
  invalidateTokenCache(userId);
  announceUpdated(workspaceId, userId, role);
  void writeAuditLog({
    action: 'workspace.member_role_changed', actorId, targetType: 'user', targetId: userId,
    details: `workspaceId=${workspaceId}; from=${previousRole}; to=${role}`,
  });
}

export async function removeMember(params: {
  workspaceId: number; userId: number; currentRole: Role; actorId: number; self: boolean;
}): Promise<void> {
  const { workspaceId, userId, currentRole, actorId, self } = params;
  await prisma.$transaction((tx) => leaveWorkspace(tx, { workspaceId, userId, currentRole }));
  invalidateTokenCache(userId);
  announceRemoved(workspaceId, userId);
  void writeAuditLog({
    action: self ? 'workspace.left' : 'workspace.member_removed', actorId, targetType: 'user', targetId: userId,
    details: `workspaceId=${workspaceId}; role=${currentRole}`,
  });
}
