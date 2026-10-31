import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types.js';
import { ERR } from '../utils/errorCodes.js';
import { isOrgAdminRole } from '../services/workspaceService.js';

// requireAdmin·requireOwner는 현재 워크스페이스 역할(호환 심으로 req.user.role)을 본다(E1b).
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'OWNER') {
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
