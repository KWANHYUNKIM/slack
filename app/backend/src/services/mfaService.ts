import crypto from 'crypto';
import prisma from '../db.js';
import { getTotpEncryptionKey, getMfaIssuer } from '../config.js';
import { sealSecret, openSecret } from '../utils/secretBox.js';
import { base32Encode, buildOtpauthUri, verifyTotp } from '../utils/totp.js';
import { createAttemptLimiter } from '../utils/attemptLimiter.js';

// 2단계 인증(E7b). TOTP 비밀은 암호화해 두고, 복구 코드는 해시만 둔다. 라우트(auth, mfa, admin, tokens)가 함께 쓴다.

const SECRET_BYTES = 20; // RFC 4226 권장 160비트
export const RECOVERY_CODE_COUNT = 10;
// 복구 코드는 32글자 알파벳(헷갈리는 l, o, 0, 1 제외) 16자 = 80비트. 해시를 거꾸로 맞춰 보기 어렵게 길게 둔다.
const RECOVERY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const RECOVERY_LENGTH = 16;
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
// 한 mfaToken으로 틀릴 수 있는 횟수. 넘으면 비밀번호부터 다시 해야 한다(계정 잠금 횟수와는 따로 센다).
const MAX_CHALLENGE_ATTEMPTS = 5;

/** 암호화 키가 있어야 2FA를 켜고 TOTP를 확인할 수 있다. */
export function isMfaAvailable(): boolean {
  return getTotpEncryptionKey() !== null;
}

const aadFor = (userId: number) => `mfa:user:${userId}`;

// ---- 조직 정책 ----

// 요청마다 설정 행을 읽지 않게 5초 캐시한다(tokenVersion 캐시와 같은 TTL). 바꾸면 바로 비운다.
const SETTINGS_CACHE_TTL = process.env.NODE_ENV === 'test' ? 0 : 5_000;
let settingsCache: { requireMfa: boolean; cachedUntil: number } | null = null;

export async function getRequireMfa(): Promise<boolean> {
  const now = Date.now();
  if (settingsCache && settingsCache.cachedUntil > now) return settingsCache.requireMfa;
  const row = await prisma.workspaceSetting.findUnique({ where: { id: 1 }, select: { requireMfa: true } });
  settingsCache = { requireMfa: row?.requireMfa ?? false, cachedUntil: now + SETTINGS_CACHE_TTL };
  return settingsCache.requireMfa;
}

export async function setRequireMfa(requireMfa: boolean): Promise<void> {
  await prisma.workspaceSetting.upsert({
    where: { id: 1 },
    create: { id: 1, requireMfa },
    update: { requireMfa },
  });
  settingsCache = null;
}

/**
 * 필수 정책이 실제로 적용되는지. 키가 없으면 아무도 등록할 수 없으니 정책을 걸지 않는다
 * (걸면 관리자까지 모든 API가 막혀 되돌릴 방법이 없다). 대신 서버 시작 때 경고하고 관리자 화면에 표시한다.
 */
export async function isMfaPolicyEnforced(): Promise<boolean> {
  return isMfaAvailable() && (await getRequireMfa());
}

// ---- 등록, 해제 ----

export interface MfaStatus {
  enabled: boolean;
  enabledAt: Date | null;
  recoveryCodesRemaining: number;
  pending: boolean;
}

export async function getMfaStatus(userId: number): Promise<MfaStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mfaEnabledAt: true, mfaPendingSecret: true },
  });
  const remaining = user?.mfaEnabledAt
    ? await prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } })
    : 0;
  return {
    enabled: !!user?.mfaEnabledAt,
    enabledAt: user?.mfaEnabledAt ?? null,
    recoveryCodesRemaining: remaining,
    pending: !!user?.mfaPendingSecret,
  };
}

/** 새 비밀을 만들어 등록 대기로 둔다. 호출 전에 키가 있는지, 이미 켜져 있지 않은지 확인한다. */
export async function startMfaSetup(user: { id: number; email: string }): Promise<{ secret: string; otpauthUri: string }> {
  const key = getTotpEncryptionKey();
  if (!key) throw new Error('MFA key unavailable');
  const raw = crypto.randomBytes(SECRET_BYTES);
  await prisma.user.update({
    where: { id: user.id },
    data: { mfaPendingSecret: sealSecret(raw, key, aadFor(user.id)) },
  });
  const secret = base32Encode(raw);
  return { secret, otpauthUri: buildOtpauthUri(secret, user.email, getMfaIssuer()) };
}

export function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(RECOVERY_LENGTH);
  let s = '';
  for (const b of bytes) s += RECOVERY_ALPHABET[b & 31];
  return s.match(/.{4}/g)!.join('-');
}

/** 입력 정규화: 소문자, 공백·하이픈 제거. 형식이 아니면 null. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]/g, '');
  if (s.length !== RECOVERY_LENGTH) return null;
  for (const ch of s) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return s;
}

const hashRecoveryCode = (normalized: string) => crypto.createHash('sha256').update(normalized).digest('hex');

export type EnableResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; reason: 'unavailable' | 'no_pending' | 'already_enabled' | 'bad_code' };

/** 등록 대기 비밀로 코드를 확인하고 켠다. 복구 코드 원문은 여기서만 한 번 돌려준다. */
export async function enableMfa(userId: number, code: string, now = Date.now()): Promise<EnableResult> {
  const key = getTotpEncryptionKey();
  if (!key) return { ok: false, reason: 'unavailable' };
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mfaEnabledAt: true, mfaPendingSecret: true },
  });
  if (!user) return { ok: false, reason: 'no_pending' };
  if (user.mfaEnabledAt) return { ok: false, reason: 'already_enabled' };
  if (!user.mfaPendingSecret) return { ok: false, reason: 'no_pending' };
  const secret = openSecret(user.mfaPendingSecret, key, aadFor(userId));
  if (!secret) return { ok: false, reason: 'no_pending' };
  const step = verifyTotp(secret, code, now);
  if (step === null) return { ok: false, reason: 'bad_code' };

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const enabled = await prisma.$transaction(async (tx) => {
    // 동시에 두 번 켜지 않게 대기 비밀이 그대로일 때만 바꾼다
    const { count } = await tx.user.updateMany({
      where: { id: userId, mfaEnabledAt: null, mfaPendingSecret: user.mfaPendingSecret },
      data: {
        mfaSecret: user.mfaPendingSecret,
        mfaPendingSecret: null,
        mfaEnabledAt: new Date(now),
        mfaLastUsedStep: step,
      },
    });
    if (count === 0) return false;
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(normalizeRecoveryCode(c)!) })),
    });
    return true;
  });
  if (!enabled) return { ok: false, reason: 'already_enabled' };
  return { ok: true, recoveryCodes: codes };
}

/**
 * 복구 코드를 새로 만든다(E7c). 기존 코드는 쓴 것과 안 쓴 것 모두 지우고 새 10개로 바꾼다. 원문은 여기서만 한 번 돌려준다.
 * 2FA가 켜져 있을 때만 바꾸고, 지우기와 만들기는 사용자 행을 잠근 한 트랜잭션이라 중간 상태가 보이지 않고 동시 요청도 하나씩 처리된다.
 */
export async function regenerateRecoveryCodes(userId: number): Promise<string[] | null> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const done = await prisma.$transaction(async (tx) => {
    // 사용자 행을 잠가 동시 재발급을 줄 세운다(잠그지 않으면 둘 다 지우고 둘 다 넣어 유효 코드가 20개가 된다)
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: { mfaEnabledAt: true } });
    if (!user?.mfaEnabledAt) return false;
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(normalizeRecoveryCode(c)!) })),
    });
    return true;
  });
  return done ? codes : null;
}

/** 2FA를 끈다(본인 해제, 관리자 초기화 공용). 비밀, 등록 대기, 복구 코드, 로그인 대기를 모두 지운다. */
export async function clearMfa(userId: number): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: null, mfaPendingSecret: null, mfaEnabledAt: null, mfaLastUsedStep: null },
    }),
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    prisma.mfaChallenge.deleteMany({ where: { userId } }),
  ]);
}

// ---- 코드 확인 ----

export type SecondFactorResult =
  | { ok: true; method: 'totp' }
  | { ok: true; method: 'recovery'; remaining: number; consumed: ConsumedRecoveryCode }
  | { ok: false; reason: 'bad_totp' | 'bad_recovery_code' | 'unavailable' | 'not_enabled' };

/**
 * 켜진 2FA의 TOTP를 확인한다. 맞은 창이 마지막으로 받은 창보다 커야 받는다(같은 코드나 앞선 창 코드 재사용 거부).
 * 창 번호 갱신은 조건부 UPDATE 한 번이라 동시에 같은 코드가 와도 하나만 통과한다.
 */
async function verifyEnabledTotp(userId: number, code: string, now: number): Promise<SecondFactorResult> {
  const key = getTotpEncryptionKey();
  if (!key) return { ok: false, reason: 'unavailable' };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mfaSecret: true, mfaEnabledAt: true } });
  if (!user?.mfaEnabledAt || !user.mfaSecret) return { ok: false, reason: 'not_enabled' };
  const secret = openSecret(user.mfaSecret, key, aadFor(userId));
  if (!secret) return { ok: false, reason: 'unavailable' };
  const step = verifyTotp(secret, code, now);
  if (step === null) return { ok: false, reason: 'bad_totp' };
  const { count } = await prisma.user.updateMany({
    where: { id: userId, mfaEnabledAt: { not: null }, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: step } }] },
    data: { mfaLastUsedStep: step },
  });
  return count === 1 ? { ok: true, method: 'totp' } : { ok: false, reason: 'bad_totp' };
}

/** 쓴 복구 코드를 되돌릴 때 쓰는 표시(해시와 쓴 시각). 원문은 담지 않는다. */
export interface ConsumedRecoveryCode { codeHash: string; usedAt: Date }

/**
 * 복구 코드를 한 번 쓴다. 조건부 UPDATE 한 번이라 같은 코드를 동시에 보내도 하나만 통과한다.
 * 남은 개수를 돌려주고, 없거나 이미 쓴 코드면 실패. 키가 없어도 된다(해시 비교).
 */
async function consumeRecoveryCode(userId: number, input: string, now: number): Promise<SecondFactorResult> {
  const normalized = normalizeRecoveryCode(input);
  if (!normalized) return { ok: false, reason: 'bad_recovery_code' };
  const codeHash = hashRecoveryCode(normalized);
  const usedAt = new Date(now);
  const { count } = await prisma.mfaRecoveryCode.updateMany({ where: { userId, codeHash, usedAt: null }, data: { usedAt } });
  if (count !== 1) return { ok: false, reason: 'bad_recovery_code' };
  const remaining = await prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  return { ok: true, method: 'recovery', remaining, consumed: { codeHash, usedAt } };
}

/** 방금 쓴 복구 코드를 되돌린다(로그인 대기를 다른 요청이 먼저 닫은 경우). 그 사이 다른 곳에서 다시 쓰였으면 건드리지 않는다. */
export async function restoreRecoveryCode(userId: number, consumed: ConsumedRecoveryCode): Promise<void> {
  await prisma.mfaRecoveryCode.updateMany({
    where: { userId, codeHash: consumed.codeHash, usedAt: consumed.usedAt },
    data: { usedAt: null },
  });
}

/** 숫자 6자리면 TOTP, 그 밖에는 복구 코드로 본다. */
export async function verifySecondFactor(userId: number, code: string, now = Date.now()): Promise<SecondFactorResult> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) return verifyEnabledTotp(userId, trimmed, now);
  return consumeRecoveryCode(userId, trimmed, now);
}

// ---- 로그인한 사용자의 코드 확인 시도 제한(등록 확인, 해제, 토큰 발급 재인증) ----
// 비밀번호 변경과 같은 규칙: 사용자당 5번 틀리면 15분 막는다. 훔친 세션으로 코드를 맞혀 보는 것을 막는다.

const verifyAttempts = createAttemptLimiter<number>({ max: 5, lockMs: 15 * 60 * 1000, maxEntries: 10_000 });

export const isMfaVerifyLocked = (userId: number): boolean => verifyAttempts.isLocked(userId);
export const recordMfaVerifyFailure = (userId: number): void => { verifyAttempts.recordFailure(userId); };
export const clearMfaVerifyFailures = (userId: number): void => verifyAttempts.clear(userId);

// ---- 로그인 2단계 대기(mfaToken) ----

const hashChallengeToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** 비밀번호를 통과한 사용자에게 5분짜리 mfaToken을 준다. 원문은 응답에만 있고 DB에는 해시만 둔다. 정리는 스케줄러가 한다. */
export async function createMfaChallenge(user: { id: number; tokenVersion: number }, now = Date.now()): Promise<{ mfaToken: string; expiresAt: Date }> {
  const mfaToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now + MFA_CHALLENGE_TTL_MS);
  await prisma.mfaChallenge.create({
    data: { id: hashChallengeToken(mfaToken), userId: user.id, tokenVersion: user.tokenVersion, expiresAt },
  });
  return { mfaToken, expiresAt };
}

/** 살아 있는(만료·사용·시도 초과가 아닌) 대기를 찾는다. 읽기만 한다. 시도 확보는 claimMfaChallengeAttempt가 한다. */
export async function findMfaChallenge(mfaToken: string, now = Date.now()) {
  if (mfaToken.length < 20 || mfaToken.length > 100) return null;
  const row = await prisma.mfaChallenge.findUnique({ where: { id: hashChallengeToken(mfaToken) } });
  if (!row || row.usedAt || row.expiresAt.getTime() <= now || row.attempts >= MAX_CHALLENGE_ATTEMPTS) return null;
  return row;
}

/**
 * 코드 검증 전에 시도 슬롯 하나를 원자적으로 확보한다. 그 순간 대기가 살아 있어야(미사용, 미만료, 시도 5회 미만) true.
 * 동시에 50건이 와도 대기 하나당 5건만 검증까지 간다.
 */
export async function claimMfaChallengeAttempt(id: string, now = Date.now()): Promise<boolean> {
  const { count } = await prisma.mfaChallenge.updateMany({
    where: { id, usedAt: null, expiresAt: { gt: new Date(now) }, attempts: { lt: MAX_CHALLENGE_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  return count === 1;
}

/**
 * 대기를 닫는다(성공 또는 무효 처리). 아직 안 닫혔을 때만 true라 같은 대기로 세션이 두 개 생기지 않는다.
 * 시도 수와 만료는 보지 않는다(슬롯을 확보한 시점에 이미 확인했다).
 */
export async function consumeMfaChallenge(id: string, now = Date.now()): Promise<boolean> {
  const { count } = await prisma.mfaChallenge.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date(now) } });
  return count === 1;
}

/** 스케줄러가 부른다. 만료됐거나 이미 닫힌 대기를 지운다. 지운 행 수를 돌려준다. */
export async function purgeMfaChallenges(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.mfaChallenge.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
  });
  return count;
}
