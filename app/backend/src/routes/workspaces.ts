import { Router, Response } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../middleware/adminAuth.js';
import { getWorkspaceState } from '../middleware/workspace.js';
import { guestVisibleUserIds } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { ERR } from '../utils/errorCodes.js';
import { STATUS_SELECT, toPublicUser } from '../services/statusService.js';
import { isUserOnline } from '../websocket/index.js';
import {
  DEFAULT_WORKSPACE_ID, WORKSPACE_PUBLIC_SELECT, activeMemberWhere, countWorkspaceOwners, loadUserWorkspaceState,
  parseWorkspaceId, roleRank,
} from '../services/workspaceService.js';
import { addMember, removeMember, updateMemberRole } from '../services/workspaceMemberService.js';

// 워크스페이스와 멤버(E1b, docs/specs/E1-multi-workspace.md 6.1). 경로의 :id가 기준이고 X-Workspace-Id 헤더는 보지 않는다.
// 워크스페이스 생성·수정·보관은 조직 관리 API(/org/workspaces)에 있다.
const router = Router();

const roleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'GUEST']);
const addMemberSchema = z.object({
  userId: z.number().int().positive().max(2_147_483_647),
  role: roleSchema.optional(),
  channelIds: z.array(z.number().int().positive().max(2_147_483_647)).max(100).optional(),
});
const updateMemberSchema = z.object({ role: roleSchema });

const WORKSPACE_NOT_FOUND = { error: 'Workspace not found', code: ERR.WORKSPACE_NOT_FOUND } as const;
const USER_NOT_FOUND = { error: 'User not found', code: ERR.USER_NOT_FOUND } as const;
const ROLE_FORBIDDEN = { error: 'You cannot give or change this role', code: ERR.WORKSPACE_ROLE_FORBIDDEN } as const;
const LAST_OWNER = { error: 'A workspace needs at least one owner', code: ERR.LAST_WORKSPACE_OWNER } as const;

/**
 * 역할을 정하거나 바꿀 수 있는 사람(privileged)인지. 기본 워크스페이스의 역할은 setUserRole로 조직 역할까지 바뀌므로
 * 기존 /admin 규칙과 같게 기본 워크스페이스 OWNER(= 조직 OWNER)만이다. 다른 워크스페이스는 그 워크스페이스 OWNER나 조직 관리자.
 * 그 밖의 관리자는 MEMBER·GUEST만 주고, ADMIN 이상인 사람은 건드리지 못한다.
 */
function isPrivileged(req: AuthRequest): boolean {
  const t = req.targetWorkspace!;
  if (t.id === DEFAULT_WORKSPACE_ID) return t.role === 'OWNER';
  return t.isOrgAdmin || t.role === 'OWNER';
}

function canGrant(req: AuthRequest, role: Role): boolean {
  return isPrivileged(req) || role === 'MEMBER' || role === 'GUEST';
}

function canTouch(req: AuthRequest, targetRole: Role): boolean {
  return isPrivileged(req) || roleRank(targetRole) < roleRank('ADMIN');
}

/** 대상 사용자의 이 워크스페이스 활성 역할. 사용자가 없거나 다른 조직이면 user=null */
async function targetMembership(workspaceId: number, organizationId: number, userId: number) {
  const state = await loadUserWorkspaceState(prisma, userId);
  if (!state || state.organizationId !== organizationId) return { user: null, role: null };
  const m = state.memberships.find((x) => x.workspaceId === workspaceId);
  return { user: state, role: m?.role ?? null };
}

// GET /workspaces - 내 활성 워크스페이스(참여한 순서)
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const state = await getWorkspaceState(req.user!.userId);
    const memberships = state?.memberships ?? [];
    const rows = await prisma.workspace.findMany({
      where: { id: { in: memberships.map((m) => m.workspaceId) } },
      select: WORKSPACE_PUBLIC_SELECT,
    });
    const byId = new Map(rows.map((w) => [w.id, w]));
    const workspaces = memberships.flatMap((m) => {
      const w = byId.get(m.workspaceId);
      return w ? [{ ...w, role: m.role }] : [];
    });
    res.json({ workspaces, defaultWorkspaceId: state?.defaultWorkspaceId ?? null });
  } catch (error) {
    logError('List workspaces error', error);
    res.status(500).json({ error: 'Failed to list workspaces', code: ERR.INTERNAL_ERROR });
  }
});

// GET /workspaces/discover - 조직의 공개·초대 전용 워크스페이스(숨김·보관 제외)와 내 참여 여부
router.get('/discover', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const state = await getWorkspaceState(req.user!.userId);
    if (!state) {
      res.status(401).json({ error: 'Invalid token', code: ERR.AUTH_INVALID_TOKEN });
      return;
    }
    const mine = new Set(state.memberships.map((m) => m.workspaceId));
    const rows = await prisma.workspace.findMany({
      where: { organizationId: state.organizationId, archivedAt: null, discoverability: { in: ['OPEN', 'INVITE_ONLY'] } },
      select: WORKSPACE_PUBLIC_SELECT,
      orderBy: { id: 'asc' },
    });
    res.json({ workspaces: rows.map((w) => ({ ...w, isMember: mine.has(w.id) })) });
  } catch (error) {
    logError('Discover workspaces error', error);
    res.status(500).json({ error: 'Failed to list workspaces', code: ERR.INTERNAL_ERROR });
  }
});

// GET /workspaces/:id - 워크스페이스 단건(멤버만, 아니면 404)
router.get('/:id', authMiddleware, requireWorkspaceMember, async (req: AuthRequest, res: Response) => {
  try {
    const t = req.targetWorkspace!;
    const ws = await prisma.workspace.findUnique({ where: { id: t.id }, select: WORKSPACE_PUBLIC_SELECT });
    if (!ws) {
      res.status(404).json(WORKSPACE_NOT_FOUND);
      return;
    }
    res.json({ ...ws, role: t.role });
  } catch (error) {
    logError('Get workspace error', error);
    res.status(500).json({ error: 'Failed to get workspace', code: ERR.INTERNAL_ERROR });
  }
});

// POST /workspaces/:id/join - 공개(OPEN) 워크스페이스 직접 참여. 숨김·보관·없는 곳은 404, 초대 전용은 403
router.post('/:id/join', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseWorkspaceId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid workspace id', code: ERR.INVALID_WORKSPACE_ID });
      return;
    }
    const userId = req.user!.userId;
    const state = await loadUserWorkspaceState(prisma, userId);
    if (!state) {
      res.status(401).json({ error: 'Invalid token', code: ERR.AUTH_INVALID_TOKEN });
      return;
    }
    const ws = await prisma.workspace.findUnique({
      where: { id }, select: { ...WORKSPACE_PUBLIC_SELECT, organizationId: true, archivedAt: true },
    });
    if (!ws || ws.archivedAt || ws.organizationId !== state.organizationId || ws.discoverability === 'HIDDEN') {
      res.status(404).json(WORKSPACE_NOT_FOUND);
      return;
    }
    if (state.memberships.some((m) => m.workspaceId === id)) {
      res.status(409).json({ error: 'Already a member of this workspace', code: ERR.USER_ALREADY_WORKSPACE_MEMBER });
      return;
    }
    if (ws.discoverability !== 'OPEN') {
      res.status(403).json({ error: 'This workspace is invite only', code: ERR.WORKSPACE_NOT_OPEN });
      return;
    }
    // 게스트는 스스로 워크스페이스를 넓히지 못한다(어디서나 게스트이거나, 소속이 없는데 계정 역할이 게스트)
    const isGuestEverywhere = state.memberships.length > 0
      ? state.memberships.every((m) => m.role === 'GUEST')
      : state.userRole === 'GUEST';
    if (isGuestEverywhere) {
      res.status(403).json({ error: 'Guests cannot join workspaces', code: ERR.ACCESS_DENIED });
      return;
    }
    await addMember({ workspaceId: id, userId, role: 'MEMBER', actorId: userId, source: 'join' });
    const { organizationId: _org, archivedAt: _arch, ...publicWs } = ws;
    res.status(201).json({ workspace: { ...publicWs, role: 'MEMBER' } });
  } catch (error) {
    logError('Join workspace error', error);
    res.status(500).json({ error: 'Failed to join workspace', code: ERR.INTERNAL_ERROR });
  }
});

// POST /workspaces/:id/leave - 나가기. 마지막 OWNER는 거부
router.post('/:id/leave', authMiddleware, requireWorkspaceMember, async (req: AuthRequest, res: Response) => {
  try {
    const t = req.targetWorkspace!;
    const userId = req.user!.userId;
    if (t.role === 'OWNER' && (await countWorkspaceOwners(prisma, t.id)) <= 1) {
      res.status(409).json(LAST_OWNER);
      return;
    }
    await removeMember({ workspaceId: t.id, userId, currentRole: t.role!, actorId: userId, self: true });
    res.json({ success: true });
  } catch (error) {
    logError('Leave workspace error', error);
    res.status(500).json({ error: 'Failed to leave workspace', code: ERR.INTERNAL_ERROR });
  }
});

// GET /workspaces/:id/members - 멤버 디렉터리. GET /users와 같은 항목에 워크스페이스 역할을 붙인다. 커서는 사용자 id
router.get('/:id/members', authMiddleware, requireWorkspaceMember, async (req: AuthRequest, res: Response) => {
  try {
    const t = req.targetWorkspace!;
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 100) || undefined : undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const cursor = parseIntParam(req.query.cursor as string | undefined);
    // 게스트는 GET /users처럼 채널을 함께 쓰는 사람만 본다
    const visibleUserIds = await guestVisibleUserIds(req.user!.userId, t.role ?? undefined);

    const users = await prisma.user.findMany({
      where: {
        AND: [
          activeMemberWhere(t.id),
          { deactivatedAt: null },
          ...(visibleUserIds ? [{ id: { in: visibleUserIds } }] : []),
          ...(search ? [{ name: { contains: search, mode: 'insensitive' as const } }] : []),
          ...(cursor ? [{ id: { gt: cursor } }] : []),
        ],
      },
      select: {
        id: true, name: true, avatar: true, status: true, role: true, ...STATUS_SELECT,
        workspaces: { where: { workspaceId: t.id }, select: { role: true } },
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;
    const items = page.map(({ role: userRole, workspaces, ...u }) => ({
      ...toPublicUser(u),
      status: isUserOnline(u.id) ? 'online' : u.status,
      isOnline: isUserOnline(u.id),
      role: t.id === DEFAULT_WORKSPACE_ID ? userRole : (workspaces[0]?.role ?? 'MEMBER'),
    }));
    res.json({ items, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) {
    logError('List workspace members error', error);
    res.status(500).json({ error: 'Failed to list members', code: ERR.INTERNAL_ERROR });
  }
});

// POST /workspaces/:id/members - 조직 사용자를 배정(워크스페이스 관리자·조직 관리자, D9). 감사 로그를 남긴다
router.post('/:id/members', authMiddleware, requireWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const t = req.targetWorkspace!;
    const { userId, role = 'MEMBER', channelIds = [] } = addMemberSchema.parse(req.body);
    if (!canGrant(req, role)) {
      res.status(403).json(ROLE_FORBIDDEN);
      return;
    }
    const target = await targetMembership(t.id, t.organizationId, userId);
    if (!target.user || target.user.deactivated) {
      res.status(404).json(USER_NOT_FOUND);
      return;
    }
    if (target.role) {
      res.status(409).json({ error: 'User is already a member of this workspace', code: ERR.USER_ALREADY_WORKSPACE_MEMBER });
      return;
    }
    // 기본 워크스페이스에 다시 넣으면 역할이 setUserRole로 바뀐다. 지금 역할이 ADMIN 이상인 사람은 권한 있는 사람만 다시 넣는다
    if (t.id === DEFAULT_WORKSPACE_ID && !canTouch(req, target.user.userRole)) {
      res.status(403).json(ROLE_FORBIDDEN);
      return;
    }
    const uniqueChannelIds = [...new Set(channelIds)];
    if (uniqueChannelIds.length > 0) {
      // 이 워크스페이스에 보이는 공개·미보관 채널만 받는다(비공개 채널은 채널 멤버가 직접 초대한다)
      const valid = await prisma.channel.count({
        where: { id: { in: uniqueChannelIds }, isPrivate: false, archivedAt: null, workspaces: { some: { workspaceId: t.id } } },
      });
      if (valid !== uniqueChannelIds.length) {
        res.status(400).json({ error: 'Invalid channel ids', code: ERR.INVALID_CHANNEL_ID });
        return;
      }
    }
    await addMember({ workspaceId: t.id, userId, role, actorId: req.user!.userId, source: 'assign', channelIds: uniqueChannelIds });
    res.status(201).json({ workspaceId: t.id, userId, role });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('Add workspace member error', error);
    res.status(500).json({ error: 'Failed to add member', code: ERR.INTERNAL_ERROR });
  }
});

/** :userId 파싱과 대상 활성 멤버 확인. 실패하면 응답을 보내고 null */
async function loadTargetMember(req: AuthRequest, res: Response): Promise<{ userId: number; role: Role } | null> {
  const t = req.targetWorkspace!;
  const userId = parseIntParam(req.params.userId);
  if (userId === null) {
    res.status(400).json({ error: 'Invalid user id', code: ERR.VALIDATION_FAILED });
    return null;
  }
  const target = await targetMembership(t.id, t.organizationId, userId);
  if (!target.user || !target.role) {
    res.status(404).json(USER_NOT_FOUND);
    return null;
  }
  return { userId, role: target.role };
}

// PATCH /workspaces/:id/members/:userId - 역할 변경
router.patch('/:id/members/:userId', authMiddleware, requireWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const t = req.targetWorkspace!;
    const { role } = updateMemberSchema.parse(req.body);
    const target = await loadTargetMember(req, res);
    if (!target) return;
    if (target.userId === req.user!.userId) {
      res.status(400).json({ error: 'Cannot modify your own role', code: ERR.BAD_REQUEST });
      return;
    }
    if (!canGrant(req, role) || !canTouch(req, target.role)) {
      res.status(403).json(ROLE_FORBIDDEN);
      return;
    }
    if (target.role === role) {
      res.json({ workspaceId: t.id, userId: target.userId, role });
      return;
    }
    if (target.role === 'OWNER' && (await countWorkspaceOwners(prisma, t.id)) <= 1) {
      res.status(409).json(LAST_OWNER);
      return;
    }
    await updateMemberRole({ workspaceId: t.id, userId: target.userId, role, previousRole: target.role, actorId: req.user!.userId });
    res.json({ workspaceId: t.id, userId: target.userId, role });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('Update workspace member error', error);
    res.status(500).json({ error: 'Failed to update member', code: ERR.INTERNAL_ERROR });
  }
});

// DELETE /workspaces/:id/members/:userId - 제거. 행은 남기고 leftAt을 채운다(채널 정리는 E1c)
router.delete('/:id/members/:userId', authMiddleware, requireWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const t = req.targetWorkspace!;
    const target = await loadTargetMember(req, res);
    if (!target) return;
    const org = await prisma.organization.findUnique({ where: { id: t.organizationId }, select: { primaryOwnerId: true } });
    if (org?.primaryOwnerId === target.userId) {
      res.status(403).json({ error: 'The primary owner cannot be removed', code: ERR.CANNOT_REMOVE_PRIMARY_OWNER });
      return;
    }
    if (!canTouch(req, target.role)) {
      res.status(403).json(ROLE_FORBIDDEN);
      return;
    }
    if (target.role === 'OWNER' && (await countWorkspaceOwners(prisma, t.id)) <= 1) {
      res.status(409).json(LAST_OWNER);
      return;
    }
    await removeMember({
      workspaceId: t.id, userId: target.userId, currentRole: target.role, actorId: req.user!.userId,
      self: target.userId === req.user!.userId,
    });
    res.json({ success: true });
  } catch (error) {
    logError('Remove workspace member error', error);
    res.status(500).json({ error: 'Failed to remove member', code: ERR.INTERNAL_ERROR });
  }
});

export default router;
