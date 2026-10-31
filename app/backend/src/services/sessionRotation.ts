import type { Request } from 'express';
import prisma from '../db.js';
import { invalidateTokenCache } from '../middleware/auth.js';
import { kickUserExcept } from '../websocket/index.js';
import { revokeUserSessions, createSessionToken } from './sessionService.js';

/**
 * 비밀번호 변경, 2FA 켜기·끄기처럼 계정 보안이 바뀐 뒤 세션을 교체한다.
 * 순서: tokenVersion 증가(필요하면 비밀번호도 함께) → 세션 폐기 → 캐시 무효화 → 소켓 끊기 → 이 기기에 새 세션 토큰.
 * tokenVersion을 올리므로 sid 없는 옛 토큰도 막힌다. 소켓은 이 기기(currentSid)의 것만 남기고 sid 없는 소켓까지 모두 끊는다.
 * 이 기기의 소켓도 옛 sid라 프런트가 새 토큰으로 다시 붙는다. currentSid가 없으면 전부 끊는다.
 */
export async function rotateSessions(
  req: Request,
  userId: number,
  currentSid: string | undefined,
  data: { password?: string } = {},
): Promise<{ token: string; revokedOthers: number }> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { ...data, tokenVersion: { increment: 1 } },
    select: { id: true, tokenVersion: true },
  });
  const revoked = await revokeUserSessions(userId);
  invalidateTokenCache(userId);
  kickUserExcept(userId, currentSid);
  const { token } = await createSessionToken(updated, req);
  return { token, revokedOthers: revoked.filter((sid) => sid !== currentSid).length };
}
