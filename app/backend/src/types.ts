import { Request } from 'express';

export interface JwtPayload {
  userId: number;
  tokenVersion?: number;
  /** 세션 id(E7). 없으면 세션 도입 전에 발급된 토큰이다. */
  sid?: string;
  role?: string;
  /** 조직이 2FA를 필수로 했는데 아직 등록하지 않았다(E7b). validateAccessToken이 채운다. */
  mfaEnrollmentRequired?: boolean;
  iat?: number;
  exp?: number;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
  channelId?: number;
  // These use `any` because `file` conflicts with Express/multer's Request.file type.
  // The middleware (authorize.ts) attaches Prisma model instances at runtime.
  isChannelMember?: boolean;
  message?: any;
  file?: any;
  dm?: any;
  dmGroupId?: number;
  /** /mcp에서 개인 액세스 토큰으로 인증했을 때만 채워진다 */
  accessToken?: { tokenId: number; scopes: string[] };
}
