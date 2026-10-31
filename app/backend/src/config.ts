import crypto from 'crypto';

function resolveJwtSecret(): string {
  if (process.env.JWT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      if (process.env.JWT_SECRET.length < 32) {
        throw new Error('JWT_SECRET must be at least 32 characters in production');
      }
      if (process.env.JWT_SECRET.includes('change-in-production')) {
        throw new Error('JWT_SECRET contains default placeholder — set a strong secret');
      }
    }
    return process.env.JWT_SECRET;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable is required in production');
  }
  const ephemeral = crypto.randomBytes(32).toString('hex');
  console.warn('WARNING: JWT_SECRET not set. Using random ephemeral secret — tokens will not survive restarts.');
  return ephemeral;
}

export const JWT_SECRET = resolveJwtSecret();

// 내장 STUN / 허들 ICE 설정. dotenv가 app.ts에서 늦게 로드되므로 호출 시점에 env를 읽는다.
export function getStunConfig() {
  const port = Number.parseInt(process.env.STUN_PORT ?? '', 10);
  const explicit = process.env.STUN_ENABLED;
  return {
    // 테스트 환경에서는 기본 꺼짐(UDP 포트 충돌 방지)
    enabled: explicit !== undefined ? explicit.toLowerCase() !== 'false' : process.env.NODE_ENV !== 'test',
    // 0은 임의 포트(테스트용). 광고는 설정값이 아니라 실제로 바인드된 포트로 한다.
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 3478,
    host: process.env.STUN_HOST || '0.0.0.0',
    // 클라이언트에 광고할 공인 호스트. production에서는 Host 헤더를 믿지 않고 이 값만 쓴다.
    publicHost: (process.env.STUN_PUBLIC_HOST || '').trim(),
  };
}

export function getTurnConfig() {
  const urls = (process.env.TURN_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^turns?:[^\s]+$/i.test(u));
  return {
    urls,
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  };
}

// 감사 로그 보존 일수. 비우거나 0이면 무기한 보관한다(기본값).
// 기본을 무기한으로 둔 이유: 삭제는 되돌릴 수 없고, 법적 보존 기간은 조직마다 달라서 운영자가 정하게 한다.
export function getAuditRetentionDays(): number {
  const days = Number.parseInt(process.env.AUDIT_LOG_RETENTION_DAYS ?? '', 10);
  return Number.isInteger(days) && days > 0 ? days : 0;
}

// 세션 정책(E7). 환경 변수는 호출 시점에 읽는다(테스트가 바꿔 가며 확인한다).
// 최대 수명 기본 7일: 기존 JWT 만료(7d)와 같아서 이번 변경으로 로그인 유지 기간이 달라지지 않는다.
// 유휴 만료 기본 96시간: 주말(약 72시간)을 건너뛰고 월요일에 돌아와도 유지되고, 일주일 방치된 기기는 잘린다.
export function getSessionMaxAgeDays(): number {
  const days = Number.parseFloat(process.env.SESSION_MAX_AGE_DAYS ?? '');
  return Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 7;
}

export function getSessionIdleTimeoutHours(): number {
  const hours = Number.parseFloat(process.env.SESSION_IDLE_TIMEOUT_HOURS ?? '');
  return Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 365) : 96;
}

// 2FA 비밀 암호화 키(E7b). 32바이트를 hex(64자) 또는 base64로 받는다. 호출 시점에 읽는다(테스트가 바꿔 가며 확인한다).
// 없거나 형식이 틀리면 null이고, 그때 2FA 등록·TOTP 확인·필수 정책은 꺼진다(이미 켠 사용자는 복구 코드로만 로그인한다).
// 요청마다(인증 미들웨어가 정책 판단에 부른다) 정규식과 Buffer를 만들지 않게, 환경 변수 원문이 같으면 이전 결과를 쓴다.
let warnedTotpKey = false;
let cachedTotpKey: { raw: string | undefined; key: Buffer | null } | null = null;
export function getTotpEncryptionKey(): Buffer | null {
  const env = process.env.TOTP_ENCRYPTION_KEY;
  if (cachedTotpKey && cachedTotpKey.raw === env) return cachedTotpKey.key;
  const key = parseTotpKey((env ?? '').trim());
  cachedTotpKey = { raw: env, key };
  return key;
}

function parseTotpKey(raw: string): Buffer | null {
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) key = b;
  }
  if (!key && !warnedTotpKey && process.env.NODE_ENV !== 'test') {
    warnedTotpKey = true;
    console.warn(raw
      ? 'WARNING: TOTP_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64). Two-factor authentication is disabled.'
      : 'WARNING: TOTP_ENCRYPTION_KEY not set. Two-factor authentication is disabled.');
  }
  return key;
}

// 인증 앱에 보이는 발급자 이름. 영문·숫자·공백·하이픈만 쓴다(otpauth URI 라벨의 ':' 구분과 겹치지 않게).
export function getMfaIssuer(): string {
  const v = (process.env.MFA_ISSUER ?? '').trim();
  return /^[A-Za-z0-9 ._-]{1,40}$/.test(v) ? v : 'slawk';
}
