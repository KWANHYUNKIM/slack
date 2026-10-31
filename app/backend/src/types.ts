import { Request } from 'express';
import type { Role } from '@prisma/client';
import type { UserWorkspaceState } from './services/workspaceService.js';

/** 요청의 현재 워크스페이스(E1b). middleware/workspace.ts의 resolveWorkspace가 채운다. */
export interface WorkspaceContext {
  id: number;
  organizationId: number;
  /**
   * 이 워크스페이스에서의 역할. req.user.role(기본 워크스페이스 역할 = User.role)과 별개다.
   * 새 /workspaces·/org API, 현재 워크스페이스 안의 목록·생성(GET/POST /channels, GET /users의 게스트 제한), /admin의 채널·초대와
   * /webhooks 관리 권한(requireCurrentWorkspaceAdmin)만 쓴다(E1c).
   * id로 오는 채널·사용자는 이 값이 아니라 리소스의 워크스페이스에서 역할을 고른다(services/workspaceScopeService.ts).
   */
  role: Role;
}

/** 경로의 :id 워크스페이스에 대한 요청자의 권한(requireWorkspaceMember·requireWorkspaceAdmin이 채운다) */
export interface TargetWorkspaceAccess {
  id: number;
  organizationId: number;
  /** 요청자가 이 워크스페이스의 활성 멤버가 아니면 null(조직 관리자일 때만 가능) */
  role: Role | null;
  isOrgAdmin: boolean;
}

export interface JwtPayload {
  userId: number;
  tokenVersion?: number;
  /** 세션 id(E7). 없으면 세션 도입 전에 발급된 토큰이다. */
  sid?: string;
  role?: string;
  /** 조직이 2FA를 필수로 했는데 아직 등록하지 않았다(E7b). validateAccessToken이 채운다. */
  mfaEnrollmentRequired?: boolean;
  /** 조직 역할(E1b). resolveWorkspace가 채운다. 토큰 payload에는 없다. */
  orgRole?: string;
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
  workspace?: WorkspaceContext;
  /** authMiddleware가 읽은 사용자 멤버십 상태(E1b). 같은 요청에서 다시 조회하지 않으려고 둔다 */
  workspaceState?: UserWorkspaceState;
  targetWorkspace?: TargetWorkspaceAccess;
  channelId?: number;
  // These use `any` because `file` conflicts with Express/multer's Request.file type.
  // The middleware (authorize.ts) attaches Prisma model instances at runtime.
  isChannelMember?: boolean;
  message?: any;
  file?: any;
  dm?: any;
  dmGroupId?: number;
  /**
   * /mcp에서 개인 액세스 토큰이나 OAuth 액세스 토큰(mcp-4)으로 인증했을 때만 채워진다.
   * kind가 없으면 PAT다. rateKey는 rate limit 버킷(PAT는 토큰, OAuth는 연결 계열 단위).
   */
  accessToken?: { tokenId: number; scopes: string[]; kind?: 'pat' | 'oauth'; rateKey?: string; oauthClientId?: number };
}
