import crypto from 'crypto';

// TOTP(RFC 6238)와 HOTP(RFC 4226)를 Node crypto로 직접 구현한다(의존성 없음). 순수 함수만 둔다.

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 시계 오차 허용: 앞뒤 1창(±30초) */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32(패딩 없음). 인증 앱에 수동 입력하는 키 형식이다. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** base32를 푼다. 공백·패딩·소문자를 허용하고, 알파벳 밖 글자가 있으면 null. */
export function base32Decode(input: string): Buffer | null {
  const s = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

/** HOTP(RFC 4226): HMAC(secret, counter) → 동적 절단 → digits 자리 */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: TotpAlgorithm = 'sha1'): string {
  const msg = Buffer.alloc(8);
  // counter는 2^53 안의 정수다. 상위·하위 32비트로 나눠 쓴다.
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** 시각(ms)이 속한 30초 창 번호 */
export function totpStep(nowMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

/** 주어진 시각의 TOTP 코드 */
export function totp(secret: Buffer, nowMs: number, opts: { digits?: number; period?: number; algorithm?: TotpAlgorithm } = {}): string {
  return hotp(secret, totpStep(nowMs, opts.period), opts.digits, opts.algorithm);
}

/**
 * 코드가 맞으면 맞은 창 번호를, 틀리면 null을 돌려준다. ±window 창을 본다.
 * 같은 창의 재사용 막기는 호출한 쪽이 돌려받은 창 번호로 한다(마지막으로 받은 창보다 커야 받는다).
 * 비교는 timingSafeEqual로 한다.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, window = TOTP_WINDOW): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(nowMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  // 일찍 끝내지 않고 모든 창을 비교한다(어느 창에서 맞았는지 시간으로 드러나지 않게)
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), given) && matched === null) matched = step;
  }
  return matched;
}

/** 인증 앱이 읽는 otpauth URI. 발급자와 계정 이름은 URL 인코딩한다. */
export function buildOtpauthUri(secretBase32: string, accountName: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
