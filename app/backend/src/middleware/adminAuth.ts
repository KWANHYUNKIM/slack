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

// /admin의 권한(E1c). req.user.role(기본 워크스페이스 역할)은 헤더로 바뀌지 않고, 아래 판정은 모두 멤버십에서 읽는다.
// 기본 워크스페이스 역할 변경·사용자 목록·소유권 이전: 기본 워크스페이스의 활성 관리자 멤버십(역할은 User.role과 같다).
// 기본 워크스페이스 멤버가 아닌 조직 관리자(User.role이 ADMIN이어도)는 여기를 쓰지 못하고 /org를 쓴다(스펙 5.2).
export function requireDefaultWorkspaceAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const membership = req.workspaceState?.memberships.find((m) => m.workspaceId === DEFAULT_WORKSPACE_ID);
  if (!isWorkspaceAdminRole(membership?.role)) {
    res.status(403).json({ error: 'Admin access required', code: ERR.ADMIN_REQUIRED });
    return;
  }
  next();
}

// 현재 워크스페이스(req.workspace)의 채널·초대·웹훅 관리: 그 워크스페이스의 관리자이거나 조직 관리자.
export function requireCurrentWorkspaceAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.workspace || (!isWorkspaceAdminRole(req.workspace.role) && !isOrgAdminRole(req.user?.orgRole))) {
    res.status(403).json({ error: 'Admin access required', code: ERR.ADMIN_REQUIRED });
    return;
  }
  next();
}

// 계정 단위 작업(비활성화·재활성화·세션·2FA 초기화·보안 설정)은 조직 단위다: 조직 관리자, 또는 기본 워크스페이스 관리자
// (E1h 전까지 기존 관리자 호환). 조직 소유자는 기본 워크스페이스를 떠나도 쓸 수 있다.
export function requireAccountAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const defaultRole = req.workspaceState?.memberships.find((m) => m.workspaceId === DEFAULT_WORKSPACE_ID)?.role;
  if (!isOrgAdminRole(req.user?.orgRole) && !isWorkspaceAdminRole(defaultRole)) {
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
