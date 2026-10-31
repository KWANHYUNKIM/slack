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
