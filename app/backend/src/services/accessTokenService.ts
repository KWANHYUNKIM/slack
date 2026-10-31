import crypto from 'crypto';
import prisma from '../db.js';
import { logError } from '../utils/logger.js';

// 개인 액세스 토큰(PAT, mcp-1). 형식: `scpat_<publicId>_<secret>`
// - publicId(12자 hex)는 DB 조회 키라 비밀이 아니다. 목록 화면에 접두사로 보여 준다.
// - secret(32바이트 base64url)은 sha256 해시로만 저장하고, 비교는 timingSafeEqual로 한다.
// JWT가 아니므로 일반 authMiddleware(jwt.verify)를 통과하지 못하고, 반대로 /mcp는 이 형식만 받는다.

export const TOKEN_PREFIX = 'scpat_';
const TOKEN_PATTERN = /^scpat_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

/** 읽기 범위. 토큰을 만들 때 범위를 안 주면 이것만 준다(쓰기는 명시적으로 고른 경우에만). */
export const READ_SCOPES = ['channels:read', 'channels:history', 'users:read'] as const;
/** 쓰기 범위(mcp-2). chat:write는 메시지 작성·수정·삭제, reactions:write는 리액션. */
export const WRITE_SCOPES = ['chat:write', 'reactions:write'] as const;
export const ALLOWED_SCOPES: readonly string[] = [...READ_SCOPES, ...WRITE_SCOPES];
export type TokenScope = (typeof READ_SCOPES)[number] | (typeof WRITE_SCOPES)[number];

export const MAX_ACTIVE_TOKENS = 20;

// 요청마다 lastUsedAt을 쓰면 DB 쓰기가 늘어나므로 1분 간격으로만 갱신한다.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function generateToken(): { token: string; publicId: string; tokenHash: string } {
  const publicId = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  return { token: `${TOKEN_PREFIX}${publicId}_${secret}`, publicId, tokenHash: hashSecret(secret) };
}

export function looksLikeAccessToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

/** 목록·응답에 내보내는 모양. 해시와 비밀은 절대 포함하지 않는다. */
export function toTokenView(row: {
  id: number; name: string; publicId: string; scopes: string[];
  expiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    prefix: `${TOKEN_PREFIX}${row.publicId}`,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    expired: !!row.expiresAt && row.expiresAt.getTime() <= Date.now(),
  };
}

export interface VerifiedAccessToken {
  tokenId: number;
  userId: number;
  role: string;
  scopes: string[];
  expiresAt: Date | null;
}

/**
 * 토큰 원문을 검증한다. 형식 오류, 없음, 해시 불일치, 폐기, 만료, 비활성 사용자는 모두 null로
 * 같게 돌려준다(어느 단계에서 실패했는지 밖에서 알 수 없게).
 */
export async function verifyAccessToken(token: string): Promise<VerifiedAccessToken | null> {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const [, publicId, secret] = match;

  const row = await prisma.personalAccessToken.findUnique({
    where: { publicId },
    include: { user: { select: { role: true, deactivatedAt: true } } },
  });
  // 없는 publicId도 해시 비교까지 같은 일을 해서 응답 시간 차이를 줄인다.
  const expected = Buffer.from(row?.tokenHash ?? '0'.repeat(64), 'hex');
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const hashOk = crypto.timingSafeEqual(expected, actual);
  if (!row || !hashOk) return null;

  const now = Date.now();
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= now) return null;
  if (row.user.deactivatedAt) return null;

  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    // 기다려서 처리한다: 응답 뒤에 남은 쓰기가 테스트 정리나 사용자 삭제와 겹치지 않게
    await prisma.personalAccessToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })
      .catch((err) => logError('Update token lastUsedAt failed', err));
  }

  return { tokenId: row.id, userId: row.userId, role: row.user.role, scopes: row.scopes, expiresAt: row.expiresAt };
}
