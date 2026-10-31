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
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 3478,
    host: process.env.STUN_HOST || '0.0.0.0',
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
