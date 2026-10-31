import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types.js';
import { ERR } from '../utils/errorCodes.js';
import { DEFAULT_WORKSPACE_ID, isOrgAdminRole, isWorkspaceAdminRole } from '../services/workspaceService.js';

// requireAdmin·requireOwner는 req.user.role(기본 워크스페이스 역할 = User.role)을 본다. 헤더로 고른 워크스페이스 역할은
// 쓰지 않는다(다른 워크스페이스 OWNER가 헤더만 바꿔 기본 워크스페이스 관리 API를 쓰는 권한 상승 방지). 범위는 E1c·E1h에서 생긴다.
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'OWNER') {
    res.status(403).json({ error: 'Admin access required', code: ERR.ADMIN_REQUIRED });
    return;
  }
  next();
}

// /admin(채널·사용자·초대·웹훅 관리)은 기본 워크스페이스 범위다(E1c, 조직 단위 관리 화면 분리는 E1h).
// requireAdmin에 더해 기본 워크스페이스의 활성 관리자 멤버십을 본다. 기본 워크스페이스 역할은 User.role이라 결과는 같지만,
// 기본 워크스페이스 멤버가 아닌 조직 관리자(User.role이 ADMIN이어도)는 여기를 쓰지 못하고 /org를 쓴다(스펙 5.2).
export function requireDefaultWorkspaceAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const membership = req.workspaceState?.memberships.find((m) => m.workspaceId === DEFAULT_WORKSPACE_ID);
  if (!isWorkspaceAdminRole(membership?.role) || (req.user?.role !== 'ADMIN' && req.user?.role !== 'OWNER')) {
    res.status(403).json({ error: 'Admin access required', code: ERR.ADMIN_REQUIRED });
    return;
  }
  next();
}

export function requireOwner(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'OWNER') {
    res.status(403).json({ error: 'Owner access required', code: ERR.OWNER_REQUIRED });
    return;
  }
  next();
}

// 조직 관리(E1b). 조직 역할은 authMiddleware(applyWorkspaceContext)가 req.user.orgRole에 채운다.
// 워크스페이스 역할과 별개 축이라 조직 소유자라도 멤버가 아닌 워크스페이스의 일반 API는 쓰지 못한다(스펙 1.2, R10).
export function requireOrgAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!isOrgAdminRole(req.user?.orgRole)) {
    res.status(403).json({ error: 'Organization admin access required', code: ERR.ORG_ADMIN_REQUIRED });
    return;
  }
  next();
}

export function requireOrgOwner(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.orgRole !== 'OWNER') {
    res.status(403).json({ error: 'Organization owner access required', code: ERR.ORG_OWNER_REQUIRED });
    return;
  }
  next();
}

// 경로 :id 워크스페이스의 멤버·관리자(조직 관리자 포함) 검사. 멤버가 아니면 404로 존재를 숨긴다.
export { requireWorkspaceAdmin, requireWorkspaceMember } from './workspace.js';
