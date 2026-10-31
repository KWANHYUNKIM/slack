import net from 'net';

// RFC 5389 STUN 메시지 인코딩/디코딩. Binding Request만 다룬다.
export const STUN_MAGIC_COOKIE = 0x2112a442;
export const STUN_HEADER_SIZE = 20;
export const BINDING_REQUEST = 0x0001;
export const BINDING_SUCCESS = 0x0101;
export const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
// 정상 Binding Request는 수십 바이트다. 이보다 큰 패킷은 처리하지 않고 버린다.
export const STUN_MAX_PACKET_SIZE = 548;

export interface StunRequest {
  transactionId: Buffer; // 12 bytes
}

/** 잘못된 패킷이면 null. 응답하지 않고 무시하는 쪽에서 쓴다. */
export function decodeBindingRequest(buf: Buffer): StunRequest | null {
  if (buf.length < STUN_HEADER_SIZE || buf.length > STUN_MAX_PACKET_SIZE) return null;
  const type = buf.readUInt16BE(0);
  // 상위 2비트는 0이어야 하고(STUN 구분), 메서드는 Binding Request만 허용
  if (type !== BINDING_REQUEST) return null;
  const length = buf.readUInt16BE(2);
  if (length % 4 !== 0 || length !== buf.length - STUN_HEADER_SIZE) return null;
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null;

  // 속성 길이가 메시지를 벗어나지 않는지만 확인한다(내용은 쓰지 않는다)
  let offset = STUN_HEADER_SIZE;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return null;
    const attrLen = buf.readUInt16BE(offset + 2);
    const padded = (attrLen + 3) & ~3;
    offset += 4 + padded;
    if (offset > buf.length) return null;
  }
  return { transactionId: Buffer.from(buf.subarray(8, 20)) };
}

export function encodeBindingRequest(transactionId: Buffer): Buffer {
  const buf = Buffer.alloc(STUN_HEADER_SIZE);
  buf.writeUInt16BE(BINDING_REQUEST, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(buf, 8, 0, 12);
  return buf;
}

/** IPv6 문자열을 16바이트로. 잘못된 문자열이면 null. IPv4-mapped(::ffff:a.b.c.d)도 처리한다. */
export function ipv6ToBytes(address: string): Buffer | null {
  const addr = address.split('%')[0]; // zone id 제거
  if (!net.isIPv6(addr)) return null;
  let head = addr;
  let tailV4: number[] = [];
  const lastColon = addr.lastIndexOf(':');
  const last = addr.slice(lastColon + 1);
  if (last.includes('.')) {
    tailV4 = last.split('.').map(Number);
    head = addr.slice(0, lastColon + 1) + '0:0';
  }
  const [left, right] = head.split('::');
  const l = left ? left.split(':') : [];
  const r = right !== undefined && right ? right.split(':') : [];
  const missing = 8 - l.length - r.length;
  const groups = head.includes('::') ? [...l, ...Array(missing).fill('0'), ...r] : l;
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  if (tailV4.length === 4) tailV4.forEach((b, i) => { out[12 + i] = b; });
  return out;
}

export function ipv4ToBytes(address: string): Buffer | null {
  if (!net.isIPv4(address)) return null;
  return Buffer.from(address.split('.').map(Number));
}

export function isV4Mapped(b: Buffer): boolean {
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return false;
  return b[10] === 0xff && b[11] === 0xff;
}

/** Binding Success Response (XOR-MAPPED-ADDRESS 하나만). 주소가 잘못되면 null. */
export function encodeBindingSuccess(transactionId: Buffer, address: string, port: number): Buffer | null {
  let ip: Buffer | null = ipv4ToBytes(address);
  if (!ip) {
    const v6 = ipv6ToBytes(address);
    if (!v6) return null;
    ip = isV4Mapped(v6) ? Buffer.from(v6.subarray(12)) : v6;
  }
  const family = ip.length === 4 ? 0x01 : 0x02;
  const attrLen = 4 + ip.length;
  const buf = Buffer.alloc(STUN_HEADER_SIZE + 4 + attrLen);
  buf.writeUInt16BE(BINDING_SUCCESS, 0);
  buf.writeUInt16BE(4 + attrLen, 2);
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(buf, 8, 0, 12);

  buf.writeUInt16BE(ATTR_XOR_MAPPED_ADDRESS, 20);
  buf.writeUInt16BE(attrLen, 22);
  buf[24] = 0;
  buf[25] = family;
  buf.writeUInt16BE((port ^ (STUN_MAGIC_COOKIE >>> 16)) & 0xffff, 26);
  // XOR 키: magic cookie(4바이트) + transaction id(12바이트)
  const key = buf.subarray(4, 20);
  for (let i = 0; i < ip.length; i++) buf[28 + i] = ip[i] ^ key[i];
  return buf;
}

export interface StunResponse {
  transactionId: Buffer;
  address: string;
  port: number;
  family: 'IPv4' | 'IPv6';
}

/** Binding Success Response에서 XOR-MAPPED-ADDRESS를 푼다(테스트와 클라이언트용). */
export function decodeBindingSuccess(buf: Buffer): StunResponse | null {
  if (buf.length < STUN_HEADER_SIZE) return null;
  if (buf.readUInt16BE(0) !== BINDING_SUCCESS) return null;
  if (buf.readUInt32BE(4) !== STUN_MAGIC_COOKIE) return null;
  if (buf.readUInt16BE(2) !== buf.length - STUN_HEADER_SIZE) return null;
  const key = buf.subarray(4, 20);
  let offset = STUN_HEADER_SIZE;
  while (offset + 4 <= buf.length) {
    const type = buf.readUInt16BE(offset);
    const len = buf.readUInt16BE(offset + 2);
    const v = offset + 4;
    if (v + len > buf.length) return null;
    if (type === ATTR_XOR_MAPPED_ADDRESS && len >= 8) {
      const family = buf[v + 1];
      const port = (buf.readUInt16BE(v + 2) ^ (STUN_MAGIC_COOKIE >>> 16)) & 0xffff;
      const size = family === 0x01 ? 4 : family === 0x02 ? 16 : 0;
      if (!size || len < 4 + size) return null;
      const raw = Buffer.alloc(size);
      for (let i = 0; i < size; i++) raw[i] = buf[v + 4 + i] ^ key[i];
      const address = size === 4
        ? Array.from(raw).join('.')
        : Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(':');
      return { transactionId: Buffer.from(buf.subarray(8, 20)), address, port, family: size === 4 ? 'IPv4' : 'IPv6' };
    }
    offset = v + ((len + 3) & ~3);
  }
  return null;
}
