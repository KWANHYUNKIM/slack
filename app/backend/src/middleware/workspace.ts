import { Response, NextFunction } from 'express';
import prisma from '../db.js';
import { AuthRequest } from '../types.js';
import { ERR } from '../utils/errorCodes.js';
import { logError } from '../utils/logger.js';
import {
  UserWorkspaceState, isOrgAdminRole, isWorkspaceAdminRole, loadUserWorkspaceState, parseWorkspaceId, pickWorkspace,
} from '../services/workspaceService.js';

// 현재 워크스페이스 해석(E1b, docs/specs/E1-multi-workspace.md 5.2).
// authMiddleware가 사용자 확인 뒤 applyWorkspaceContext를 불러 모든 인증 API에 전역으로 적용된다.

// 사용자별 멤버십 캐시. auth.ts의 토큰 캐시와 같은 5초 TTL이고 테스트에서는 끈다.
// 멤버십·역할·보관을 바꾸는 API는 invalidateWorkspaceCache(또는 보관처럼 여러 사용자에 걸치면 clearWorkspaceCache)를 부른다.
const WORKSPACE_CACHE_TTL = process.env.NODE_ENV === 'test' ? 0 : 5_000;
const stateCache = new Map<number, { state: UserWorkspaceState; expiresAt: number }>();

if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of stateCache) {
      if (entry.expiresAt < now) stateCache.delete(key);
    }
  }, 10 * 60 * 1000).unref();
}

export function invalidateWorkspaceCache(userId: number): void {
  stateCache.delete(userId);
}

export function clearWorkspaceCache(): void {
  stateCache.clear();
}

/** 사용자의 조직 역할과 활성 멤버십(짧은 캐시). 사용자가 없으면 null */
export async function getWorkspaceState(userId: number): Promise<UserWorkspaceState | null> {
  const now = Date.now();
  const cached = stateCache.get(userId);
  if (cached && cached.expiresAt >= now) return cached.state;
  const state = await loadUserWorkspaceState(prisma, userId);
  if (state && WORKSPACE_CACHE_TTL > 0) stateCache.set(userId, { state, expiresAt: now + WORKSPACE_CACHE_TTL });
  return state;
}

/** authMiddleware가 이미 읽은 상태가 있으면 그것을, 없으면 캐시에서 읽는다 */
export async function requestWorkspaceState(req: AuthRequest): Promise<UserWorkspaceState | null> {
  return req.workspaceState ?? getWorkspaceState(req.user!.userId);
}

/**
 * 워크스페이스와 무관한 계정 단위 경로. 이 경로들은 X-Workspace-Id를 보지 않고 req.workspace도 두지 않는다.
 * 그래야 워크스페이스가 하나도 없는 사용자도 로그아웃·초대 수락·참여·푸시 해제·앱 연결 승인을 할 수 있다.
 * - 계정: /auth(로그인·로그아웃·초대 수락), /users/me(프로필·세션·2FA·상태·연결 앱), /tokens(개인 액세스 토큰, D10 조직 단위),
 *   /push(기기 단위 푸시 구독), /oauth(앱 연결 승인 authorize 계열, 토큰은 조직 단위)
 * - 워크스페이스를 경로로 받는 /workspaces, 조직 관리 /org
 * 예외: /users/me/sidebar는 워크스페이스 단위라(E1d) 해석한다.
 */
export function isWorkspaceFreePath(fullPath: string): boolean {
  const under = (prefix: string) => fullPath === prefix || fullPath.startsWith(`${prefix}/`);
  if (['/auth', '/workspaces', '/org', '/tokens', '/push', '/oauth'].some(under)) return true;
  if (under('/users/me')) return !under('/users/me/sidebar');
  return false;
}

/**
 * req.user가 정해진 뒤 현재 워크스페이스를 정한다. 성공하면 true, 응답을 이미 보냈으면 false.
 * req.user.role은 덮어쓰지 않는다(PR #128 리뷰 결정). 기존 라우트(/admin, 채널, 사용자, DM, MCP, 소켓)는 범위가 아직
 * 워크스페이스로 나뉘지 않았으므로(E1c·E1h) 계속 기본 워크스페이스 역할(User.role)을 쓴다. 헤더로 고른 워크스페이스의
 * 역할을 넣으면 다른 워크스페이스 OWNER가 헤더만 바꿔 기본 워크스페이스 관리 API를 쓸 수 있다.
 * 현재 워크스페이스 역할은 req.workspace.role에 두고 새 /workspaces·/org API만 쓴다.
 */
export async function applyWorkspaceContext(req: AuthRequest, res: Response): Promise<boolean> {
  const state = await getWorkspaceState(req.user!.userId);
  if (!state) {
    res.status(401).json({ error: 'Invalid token', code: ERR.AUTH_INVALID_TOKEN });
    return false;
  }
  req.workspaceState = state;
  req.user!.orgRole = state.orgRole;
  if (isWorkspaceFreePath(req.baseUrl + req.path)) return true;

  const picked = pickWorkspace(state, req.headers['x-workspace-id']);
  if (!picked.ok) {
    const error = picked.code === 'INVALID_WORKSPACE_ID' ? 'Invalid workspace id'
      : picked.code === 'NO_WORKSPACE' ? 'You are not a member of any workspace' : 'Workspace not found';
    res.status(picked.status).json({ error, code: ERR[picked.code] });
    return false;
  }
  req.workspace = { id: picked.workspaceId, organizationId: state.organizationId, role: picked.role };
  res.setHeader('X-Workspace-Id', String(picked.workspaceId));
  return true;
}

/** authMiddleware 없이 따로 걸 때 쓰는 미들웨어 형태 */
export async function resolveWorkspace(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (await applyWorkspaceContext(req, res)) next();
  } catch (error) {
    logError('Resolve workspace error', error);
    res.status(500).json({ error: 'Internal server error', code: ERR.INTERNAL_ERROR });
  }
}

const WORKSPACE_NOT_FOUND = { error: 'Workspace not found', code: ERR.WORKSPACE_NOT_FOUND } as const;

/**
 * 경로 :id 워크스페이스 접근(헤더가 아니라 경로가 기준). 보관되지 않은 같은 조직의 워크스페이스이고
 * 요청자가 활성 멤버이거나(admin=false), 워크스페이스 관리자이거나 조직 관리자여야 한다(admin=true).
 * 멤버가 아닌 사람에게는 존재를 숨기려고 404를 준다(D7). 멤버지만 관리자가 아니면 403.
 */
function requireTargetWorkspace(admin: boolean) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = parseWorkspaceId(req.params.id);
      if (id === null) {
        res.status(400).json({ error: 'Invalid workspace id', code: ERR.INVALID_WORKSPACE_ID });
        return;
      }
      const state = await requestWorkspaceState(req);
      if (!state) {
        res.status(401).json({ error: 'Invalid token', code: ERR.AUTH_INVALID_TOKEN });
        return;
      }
      const membership = state.memberships.find((m) => m.workspaceId === id);
      const isOrgAdmin = isOrgAdminRole(state.orgRole);
      if (!membership && !(admin && isOrgAdmin)) {
        res.status(404).json(WORKSPACE_NOT_FOUND);
        return;
      }
      if (!membership) {
        // 조직 관리자는 멤버가 아니어도 관리 API를 쓴다. 대신 워크스페이스가 실제로 있고 보관되지 않았는지 본다.
        const ws = await prisma.workspace.findUnique({ where: { id }, select: { organizationId: true, archivedAt: true } });
        if (!ws || ws.archivedAt || ws.organizationId !== state.organizationId) {
          res.status(404).json(WORKSPACE_NOT_FOUND);
          return;
        }
      }
      const role = membership?.role ?? null;
      if (admin && !isOrgAdmin && !isWorkspaceAdminRole(role)) {
        res.status(403).json({ error: 'Workspace admin access required', code: ERR.WORKSPACE_ADMIN_REQUIRED });
        return;
      }
      req.targetWorkspace = { id, organizationId: state.organizationId, role, isOrgAdmin };
      next();
    } catch (error) {
      logError('Workspace access error', error);
      res.status(500).json({ error: 'Internal server error', code: ERR.INTERNAL_ERROR });
    }
  };
}

export const requireWorkspaceMember = requireTargetWorkspace(false);
export const requireWorkspaceAdmin = requireTargetWorkspace(true);
