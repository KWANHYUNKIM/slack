import crypto from 'crypto';

// 짧은 비밀(TOTP 시드)을 AES-256-GCM으로 감싼다. 형식: v1.<iv>.<tag>.<암호문> (각각 base64url).
// aad로 사용자 id 같은 문맥을 묶어, 암호문을 다른 행으로 옮겨 붙여도 풀리지 않게 한다.

const VERSION = 'v1';
const IV_BYTES = 12;

export function sealSecret(plain: Buffer, key: Buffer, aad: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** 형식이 틀리거나 키·aad가 맞지 않으면(위변조 포함) null */
export function openSecret(sealed: string, key: Buffer, aad: string): Buffer | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ct = Buffer.from(parts[3], 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return null;
  }
}
