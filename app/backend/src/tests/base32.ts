// 테스트 전용: setup 응답의 base32 키를 풀어 인증 앱처럼 TOTP를 만든다. 운영 코드는 base32를 풀 일이 없다.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32(RFC 4648)를 푼다. 공백·패딩·소문자를 허용하고, 알파벳 밖 글자가 있으면 null. */
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
