import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireOrgAdmin, requireOrgOwner } from '../middleware/adminAuth.js';
import { clearWorkspaceCache, invalidateWorkspaceCache, requestWorkspaceState } from '../middleware/workspace.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { ERR } from '../utils/errorCodes.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { getIO } from '../websocket/index.js';
import {
  MEMBERSHIP_USER_SELECT, WORKSPACE_PUBLIC_SELECT, WORKSPACE_SLUG_RE, activeMemberWhere,
  activeMembershipsOf, isDefaultWorkspaceArchived, isOrgAdminRole, materializeImplicitDefaultMembership, parseWorkspaceId,
  DEFAULT_WORKSPACE_ID, joinWorkspaceDefaultChannels,
} from '../services/workspaceService.js';
import { fillDefaultSlot } from '../services/defaultChannelService.js';
import { workspaceRoom } from '../services/workspaceMemberService.js';

// 조직 관리(E1b, docs/specs/E1-multi-workspace.md 6.1). 서버당 조직은 하나(D1)라 조직 생성 API는 없다.
// 워크스페이스는 하드 삭제 없이 보관만 한다(D6). 조직 설정(/org/settings)과 orgRole 변경은 E1e 이후.
const router = Router();

const ADMIN_STACK = [authMiddleware, requireOrgAdmin];

const slugSchema = z.string().trim().toLowerCase();
const nameSchema = z.string().trim().min(1).max(100);
const discoverabilitySchema = z.enum(['OPEN', 'INVITE_ONLY', 'HIDDEN']);

const createWorkspaceSchema = z.object({
  slug: slugSchema,
  name: nameSchema,
  description: z.string().trim().max(500).optional(),
  discoverability: discoverabilitySchema.optional(),
});

// icon은 업로드 경로만 허용해야 하므로(규칙 17) 업로드 API가 생길 때 받는다
const updateWorkspaceSchema = z.object({
  slug: slugSchema.optional(),
  name: nameSchema.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  discoverability: discoverabilitySchema.optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

const updateOrgSchema = z.object({ name: z.string().trim().min(1).max(100) });

const WORKSPACE_NOT_FOUND = { error: 'Workspace not found', code: ERR.WORKSPACE_NOT_FOUND } as const;
const INVALID_SLUG = { error: 'Invalid workspace URL', code: ERR.INVALID_WORKSPACE_SLUG } as const;

const ORG_WORKSPACE_SELECT = {
  ...WORKSPACE_PUBLIC_SELECT, organizationId: true, archivedAt: true, createdAt: true, createdBy: true,
} satisfies Prisma.WorkspaceSelect;

/**
 * 같은 조직의 slug·이름 충돌을 미리 알려 준다. 없으면 null. 이름 비교는 DB 유니크 인덱스(organizationId, lower(name),
 * 마이그레이션 20261102015000)와 같은 식을 쓴다. 미리 보기일 뿐이고 동시 요청은 인덱스가 막는다(uniqueConflict).
 */
async function findWorkspaceConflict(organizationId: number, slug: string | undefined, name: string | undefined, exceptId?: number) {
  const others = { organizationId, ...(exceptId ? { id: { not: exceptId } } : {}) };
  if (slug !== undefined && (await prisma.workspace.findFirst({ where: { ...others, slug }, select: { id: true } }))) {
    return { error: 'Workspace URL is taken', code: ERR.WORKSPACE_SLUG_TAKEN } as const;
  }
  if (name !== undefined) {
    const taken = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "Workspace"
      WHERE "organizationId" = ${organizationId} AND lower("name") = lower(${name}) AND "id" <> ${exceptId ?? 0}
      LIMIT 1`;
    if (taken.length > 0) return { error: 'Workspace name is taken', code: ERR.WORKSPACE_NAME_TAKEN } as const;
  }
  return null;
}

/**
 * 동시 요청이 먼저 가져간 경우의 유니크 충돌(P2002)을 같은 오류로 바꾼다. slug 유니크가 아니면 이름 유니크
 * (@@unique([organizationId, name]) 또는 함수 인덱스 Workspace_organizationId_lower_name_key)다.
 */
function uniqueConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;
  const target = String((error.meta as { target?: unknown } | undefined)?.target ?? '');
  return target.includes('slug')
    ? { error: 'Workspace URL is taken', code: ERR.WORKSPACE_SLUG_TAKEN }
    : { error: 'Workspace name is taken', code: ERR.WORKSPACE_NAME_TAKEN };
}

/**
 * 워크스페이스별 활성 멤버 수(비활성 계정 제외). 행 기준 groupBy 한 번에, 기본 워크스페이스는 행이 하나도 없는
 * 암묵 멤버(activeMembershipsOf와 같은 규칙)를 더한다.
 */
async function activeMemberCounts(organizationId: number, ids: number[]): Promise<Map<number, number>> {
  const [grouped, implicitDefault] = await Promise.all([
    prisma.workspaceMember.groupBy({
      by: ['workspaceId'],
      where: { workspaceId: { in: ids }, leftAt: null, user: { deactivatedAt: null } },
      _count: { _all: true },
    }),
    ids.includes(DEFAULT_WORKSPACE_ID)
      ? prisma.user.count({ where: { organizationId, deactivatedAt: null, workspaces: { none: {} } } })
      : Promise.resolve(0),
  ]);
  const counts = new Map(grouped.map((g) => [g.workspaceId, g._count._all]));
  if (ids.includes(DEFAULT_WORKSPACE_ID)) counts.set(DEFAULT_WORKSPACE_ID, (counts.get(DEFAULT_WORKSPACE_ID) ?? 0) + implicitDefault);
  return counts;
}

// PATCH /org/workspaces/:id 권한: 조직 관리자 또는 그 워크스페이스 OWNER
// :id 형식 검사는 권한 검사보다 먼저 한다. 잘못된 id는 호출자와 무관하게 400이다
function requireWorkspaceIdParam(req: AuthRequest, res: Response, next: NextFunction): void {
  if (parseWorkspaceId(req.params.id) === null) {
    res.status(400).json({ error: 'Invalid workspace id', code: ERR.INVALID_WORKSPACE_ID });
    return;
  }
  next();
}

async function requireOrgAdminOrWorkspaceOwner(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  if (isOrgAdminRole(req.user?.orgRole)) {
    next();
    return;
  }
  try {
    const id = parseWorkspaceId(req.params.id);
    const state = await requestWorkspaceState(req);
    const role = state?.memberships.find((m) => m.workspaceId === id)?.role;
    if (role === 'OWNER') {
      next();
      return;
    }
    // 멤버가 아니면 존재를 숨긴다
    if (!role) res.status(404).json(WORKSPACE_NOT_FOUND);
    else res.status(403).json({ error: 'Organization admin access required', code: ERR.ORG_ADMIN_REQUIRED });
  } catch (error) {
    logError('Workspace owner check error', error);
    res.status(500).json({ error: 'Internal server error', code: ERR.INTERNAL_ERROR });
  }
}

/** :id를 같은 조직의 워크스페이스로 찾는다. 없으면 응답을 보내고 null */
async function loadOrgWorkspace(req: AuthRequest, res: Response) {
  const id = parseWorkspaceId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'Invalid workspace id', code: ERR.INVALID_WORKSPACE_ID });
    return null;
  }
  const state = await requestWorkspaceState(req);
  const ws = await prisma.workspace.findUnique({ where: { id }, select: ORG_WORKSPACE_SELECT });
  if (!ws || !state || ws.organizationId !== state.organizationId) {
    res.status(404).json(WORKSPACE_NOT_FOUND);
    return null;
  }
  return ws;
}

// GET /org - 조직 정보
router.get('/', ...ADMIN_STACK, async (req: AuthRequest, res: Response) => {
  try {
    const state = await requestWorkspaceState(req);
    const org = await prisma.organization.findUnique({
      where: { id: state!.organizationId },
      select: { id: true, name: true, primaryOwnerId: true, createdAt: true },
    });
    res.json(org);
  } catch (error) {
    logError('Get organization error', error);
    res.status(500).json({ error: 'Failed to get organization', code: ERR.INTERNAL_ERROR });
  }
});

// PATCH /org - 조직 이름(조직 OWNER)
router.patch('/', authMiddleware, requireOrgOwner, async (req: AuthRequest, res: Response) => {
  try {
    const { name } = updateOrgSchema.parse(req.body);
    const state = await requestWorkspaceState(req);
    const org = await prisma.organization.update({
      where: { id: state!.organizationId },
      data: { name },
      select: { id: true, name: true, primaryOwnerId: true, createdAt: true },
    });
    void writeAuditLog({ action: 'org.updated', actorId: req.user!.userId, targetType: 'organization', targetId: org.id, targetName: name });
    res.json(org);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('Update organization error', error);
    res.status(500).json({ error: 'Failed to update organization', code: ERR.INTERNAL_ERROR });
  }
});

// GET /org/workspaces - 보관 포함 전체와 활성 멤버 수
router.get('/workspaces', ...ADMIN_STACK, async (req: AuthRequest, res: Response) => {
  try {
    const state = await requestWorkspaceState(req);
    const rows = await prisma.workspace.findMany({
      where: { organizationId: state!.organizationId },
      select: ORG_WORKSPACE_SELECT,
      orderBy: { id: 'asc' },
    });
    const counts = await activeMemberCounts(state!.organizationId, rows.map((w) => w.id));
    res.json({ workspaces: rows.map((w) => ({ ...w, memberCount: counts.get(w.id) ?? 0 })) });
  } catch (error) {
    logError('List org workspaces error', error);
    res.status(500).json({ error: 'Failed to list workspaces', code: ERR.INTERNAL_ERROR });
  }
});

// POST /org/workspaces - 만들기. 만든 사람이 워크스페이스 OWNER가 된다.
// 기본 채널 general도 함께 만들고 만든 사람을 넣는다(E1c, 채널 이름 유일성이 워크스페이스 단위가 된 뒤).
router.post('/workspaces', ...ADMIN_STACK, async (req: AuthRequest, res: Response) => {
  try {
    const body = createWorkspaceSchema.parse(req.body);
    if (!WORKSPACE_SLUG_RE.test(body.slug)) {
      res.status(400).json(INVALID_SLUG);
      return;
    }
    const actorId = req.user!.userId;
    const state = await requestWorkspaceState(req);
    const organizationId = state!.organizationId;
    const conflict = await findWorkspaceConflict(organizationId, body.slug, body.name);
    if (conflict) {
      res.status(409).json({ error: conflict.error, code: conflict.code });
      return;
    }
    const ws = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: {
          organizationId, slug: body.slug, name: body.name, description: body.description || null,
          discoverability: body.discoverability ?? 'INVITE_ONLY', createdBy: actorId,
        },
        select: ORG_WORKSPACE_SELECT,
      });
      await materializeImplicitDefaultMembership(tx, actorId);
      await tx.workspaceMember.create({ data: { workspaceId: created.id, userId: actorId, role: 'OWNER' } });
      await fillDefaultSlot(tx, 'general', created.id);
      await joinWorkspaceDefaultChannels(tx, created.id, actorId);
      return created;
    });
    // 멤버십이 바뀐 사람은 만든 사람뿐이다
    invalidateWorkspaceCache(actorId);
    const io = getIO();
    if (io) {
      io.in(`user:${actorId}`).socketsJoin(workspaceRoom(ws.id));
      io.to(`user:${actorId}`).emit('workspace:member:added', { workspaceId: ws.id, userId: actorId, role: 'OWNER' });
    }
    void writeAuditLog({
      action: 'workspace.created', actorId, targetType: 'workspace', targetId: ws.id, targetName: ws.name,
      details: `slug=${ws.slug}; discoverability=${ws.discoverability}`,
    });
    res.status(201).json({ ...ws, memberCount: 1 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    const conflict = uniqueConflict(error);
    if (conflict) {
      res.status(409).json({ error: conflict.error, code: conflict.code });
      return;
    }
    logError('Create workspace error', error);
    res.status(500).json({ error: 'Failed to create workspace', code: ERR.INTERNAL_ERROR });
  }
});

// PATCH /org/workspaces/:id - 이름·주소·설명·접근 수준(조직 관리자 또는 그 워크스페이스 OWNER)
router.patch('/workspaces/:id', authMiddleware, requireWorkspaceIdParam, requireOrgAdminOrWorkspaceOwner, async (req: AuthRequest, res: Response) => {
  try {
    const body = updateWorkspaceSchema.parse(req.body);
    if (body.slug !== undefined && !WORKSPACE_SLUG_RE.test(body.slug)) {
      res.status(400).json(INVALID_SLUG);
      return;
    }
    const current = await loadOrgWorkspace(req, res);
    if (!current) return;
    const conflict = await findWorkspaceConflict(current.organizationId, body.slug, body.name, current.id);
    if (conflict) {
      res.status(409).json({ error: conflict.error, code: conflict.code });
      return;
    }
    const ws = await prisma.workspace.update({
      where: { id: current.id },
      data: {
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.discoverability !== undefined ? { discoverability: body.discoverability } : {}),
      },
      select: ORG_WORKSPACE_SELECT,
    });
    getIO()?.to(workspaceRoom(ws.id)).emit('workspace:updated', {
      id: ws.id, slug: ws.slug, name: ws.name, icon: ws.icon, description: ws.description, discoverability: ws.discoverability,
    });
    void writeAuditLog({
      action: 'workspace.updated', actorId: req.user!.userId, targetType: 'workspace', targetId: ws.id, targetName: ws.name,
      details: `fields=${Object.keys(body).join(',')}`,
    });
    res.json(ws);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    const conflict = uniqueConflict(error);
    if (conflict) {
      res.status(409).json({ error: conflict.error, code: conflict.code });
      return;
    }
    logError('Update workspace error', error);
    res.status(500).json({ error: 'Failed to update workspace', code: ERR.INTERNAL_ERROR });
  }
});

// POST /org/workspaces/:id/archive - 보관(D6). 마지막 활성 워크스페이스는 거부. 보관 뒤 그 워크스페이스 API는 404
router.post('/workspaces/:id/archive', authMiddleware, requireWorkspaceIdParam, requireOrgAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const current = await loadOrgWorkspace(req, res);
    if (!current) return;
    // 기본 워크스페이스는 행 없는 사용자의 암묵 소속, 가입·기본 채널 경로가 기대므로 보관하지 않는다
    if (current.id === DEFAULT_WORKSPACE_ID) {
      res.status(409).json({ error: 'The default workspace cannot be archived', code: ERR.DEFAULT_WORKSPACE_ARCHIVE_FORBIDDEN });
      return;
    }
    if (current.archivedAt) {
      res.json(current);
      return;
    }
    const others = await prisma.workspace.count({
      where: { organizationId: current.organizationId, archivedAt: null, id: { not: current.id } },
    });
    if (others === 0) {
      res.status(409).json({ error: 'Cannot archive the last active workspace', code: ERR.LAST_WORKSPACE });
      return;
    }
    const ws = await prisma.workspace.update({ where: { id: current.id }, data: { archivedAt: new Date() }, select: ORG_WORKSPACE_SELECT });
    clearWorkspaceCache();
    const io = getIO();
    if (io) {
      io.to(workspaceRoom(ws.id)).emit('workspace:archived', { id: ws.id });
      io.in(workspaceRoom(ws.id)).socketsLeave(workspaceRoom(ws.id));
    }
    void writeAuditLog({ action: 'workspace.archived', actorId: req.user!.userId, targetType: 'workspace', targetId: ws.id, targetName: ws.name });
    res.json(ws);
  } catch (error) {
    logError('Archive workspace error', error);
    res.status(500).json({ error: 'Failed to archive workspace', code: ERR.INTERNAL_ERROR });
  }
});

// POST /org/workspaces/:id/unarchive - 보관 해제. 남아 있던 활성 멤버의 소켓을 room에 다시 넣고 알린다
router.post('/workspaces/:id/unarchive', authMiddleware, requireWorkspaceIdParam, requireOrgAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const current = await loadOrgWorkspace(req, res);
    if (!current) return;
    if (!current.archivedAt) {
      res.json(current);
      return;
    }
    const ws = await prisma.workspace.update({ where: { id: current.id }, data: { archivedAt: null }, select: ORG_WORKSPACE_SELECT });
    clearWorkspaceCache();
    const io = getIO();
    if (io) {
      const members = await prisma.user.findMany({ where: { AND: [activeMemberWhere(ws.id), { deactivatedAt: null }] }, select: { id: true } });
      if (members.length > 0) io.in(members.map((m) => `user:${m.id}`)).socketsJoin(workspaceRoom(ws.id));
      io.to(workspaceRoom(ws.id)).emit('workspace:unarchived', { id: ws.id });
    }
    void writeAuditLog({ action: 'workspace.unarchived', actorId: req.user!.userId, targetType: 'workspace', targetId: ws.id, targetName: ws.name });
    res.json(ws);
  } catch (error) {
    logError('Unarchive workspace error', error);
    res.status(500).json({ error: 'Failed to unarchive workspace', code: ERR.INTERNAL_ERROR });
  }
});

// GET /org/users - 조직 사용자와 소속 워크스페이스(teams). 커서는 사용자 id
router.get('/users', ...ADMIN_STACK, async (req: AuthRequest, res: Response) => {
  try {
    const state = await requestWorkspaceState(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const cursor = parseIntParam(req.query.cursor as string | undefined);
    const rows = await prisma.user.findMany({
      where: { organizationId: state!.organizationId, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { ...MEMBERSHIP_USER_SELECT, name: true, email: true, avatar: true },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const defaultArchived = page.some((u) => u.workspaces.length === 0) ? await isDefaultWorkspaceArchived(prisma) : false;
    const items = page.map((u) => ({
      id: u.id, name: u.name, email: u.email, avatar: u.avatar, orgRole: u.orgRole, deactivatedAt: u.deactivatedAt,
      teams: activeMembershipsOf(u, defaultArchived).map((m) => ({ workspaceId: m.workspaceId, role: m.role })),
    }));
    res.json({ items, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) {
    logError('List org users error', error);
    res.status(500).json({ error: 'Failed to list users', code: ERR.INTERNAL_ERROR });
  }
});

export default router;
