import dgram from 'dgram';
import crypto from 'crypto';
import {
  STUN_MAGIC_COOKIE, STUN_MAX_PACKET_SIZE,
  decodeBindingRequest, decodeBindingSuccess, encodeBindingRequest, encodeBindingSuccess,
} from '../stun/stunMessage.js';
import { RateLimiter, rateLimitKey, startStunServer } from '../stun/stunServer.js';

describe('STUN message encode/decode', () => {
  const txid = crypto.randomBytes(12);

  it('round-trips an IPv4 XOR-MAPPED-ADDRESS', () => {
    const res = encodeBindingSuccess(txid, '192.0.2.1', 32853)!;
    expect(res.length).toBe(32);
    const decoded = decodeBindingSuccess(res)!;
    expect(decoded).toMatchObject({ address: '192.0.2.1', port: 32853, family: 'IPv4' });
    expect(decoded.transactionId.equals(txid)).toBe(true);
  });

  it('XORs IPv4 with the magic cookie (RFC 5769 style)', () => {
    const res = encodeBindingSuccess(txid, '192.0.2.1', 32853)!;
    expect(res.readUInt16BE(26)).toBe(32853 ^ 0x2112);
    expect(res.readUInt32BE(28)).toBe((0xc0000201 ^ STUN_MAGIC_COOKIE) >>> 0);
  });

  it('round-trips an IPv6 XOR-MAPPED-ADDRESS (cookie + transaction id key)', () => {
    const res = encodeBindingSuccess(txid, '2001:db8:1234:5678:11:2233:4455:6677', 32853)!;
    expect(res.length).toBe(44);
    const decoded = decodeBindingSuccess(res)!;
    expect(decoded).toMatchObject({ address: '2001:db8:1234:5678:11:2233:4455:6677', port: 32853, family: 'IPv6' });
    // 실제로 transaction id까지 XOR 됐는지 확인
    expect(res[28 + 4]).toBe(0x12 ^ txid[0]);
  });

  it('expands compressed IPv6 and encodes IPv4-mapped as IPv4', () => {
    expect(decodeBindingSuccess(encodeBindingSuccess(txid, '::1', 1000)!)!.address).toBe('0:0:0:0:0:0:0:1');
    const mapped = decodeBindingSuccess(encodeBindingSuccess(txid, '::ffff:10.1.2.3', 1000)!)!;
    expect(mapped).toMatchObject({ address: '10.1.2.3', family: 'IPv4' });
  });

  it('returns null for an invalid address', () => {
    expect(encodeBindingSuccess(txid, 'not-an-ip', 1)).toBeNull();
  });

  it('decodes a valid Binding Request', () => {
    const req = decodeBindingRequest(encodeBindingRequest(txid))!;
    expect(req.transactionId.equals(txid)).toBe(true);
  });

  it('ignores a wrong magic cookie', () => {
    const pkt = encodeBindingRequest(txid);
    pkt.writeUInt32BE(0xdeadbeef, 4);
    expect(decodeBindingRequest(pkt)).toBeNull();
  });

  it('ignores wrong message type, bad length, truncated and oversize packets', () => {
    const ok = encodeBindingRequest(txid);
    const wrongType = Buffer.from(ok); wrongType.writeUInt16BE(0x0101, 0);
    expect(decodeBindingRequest(wrongType)).toBeNull();
    const badLen = Buffer.from(ok); badLen.writeUInt16BE(8, 2);
    expect(decodeBindingRequest(badLen)).toBeNull();
    expect(decodeBindingRequest(ok.subarray(0, 19))).toBeNull();
    expect(decodeBindingRequest(Buffer.alloc(0))).toBeNull();

    const big = Buffer.alloc(STUN_MAX_PACKET_SIZE + 4);
    ok.copy(big);
    big.writeUInt16BE(big.length - 20, 2);
    expect(decodeBindingRequest(big)).toBeNull();
  });

  it('ignores an attribute that overruns the message', () => {
    const pkt = Buffer.alloc(28);
    encodeBindingRequest(txid).copy(pkt);
    pkt.writeUInt16BE(8, 2);
    pkt.writeUInt16BE(0x8022, 20);
    pkt.writeUInt16BE(200, 22);
    expect(decodeBindingRequest(pkt)).toBeNull();
  });

  it('keeps the response small relative to the request (no amplification beyond ~2.2x)', () => {
    const req = encodeBindingRequest(txid);
    expect(encodeBindingSuccess(txid, '1.2.3.4', 1)!.length / req.length).toBeLessThanOrEqual(1.6);
    expect(encodeBindingSuccess(txid, '2001:db8::1', 1)!.length / req.length).toBeLessThanOrEqual(2.2);
  });
});

describe('STUN rate limit', () => {
  it('allows up to max per second per key, then drops, then resets', () => {
    const rl = new RateLimiter(3);
    const t = 1_000_000;
    expect([1, 2, 3, 4, 5].map(() => rl.allow('a', t))).toEqual([true, true, true, false, false]);
    expect(rl.allow('b', t)).toBe(true);
    expect(rl.allow('a', t + 1000)).toBe(true);
  });

  it('caps tracked keys', () => {
    const rl = new RateLimiter(1, 2);
    expect(rl.allow('a', 0)).toBe(true);
    expect(rl.allow('b', 0)).toBe(true);
    expect(rl.allow('c', 0)).toBe(false);
    expect(rl.size).toBe(2);
  });

  it('groups IPv6 by /64', () => {
    expect(rateLimitKey('2001:db8:0:1::5')).toBe(rateLimitKey('2001:db8:0:1:ffff::9'));
    expect(rateLimitKey('2001:db8:0:2::5')).not.toBe(rateLimitKey('2001:db8:0:1::5'));
    expect(rateLimitKey('10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('STUN server over local UDP', () => {
  function query(port: number, packet: Buffer, wait = 300): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const c = dgram.createSocket('udp4');
      const timer = setTimeout(() => { c.close(); resolve(null); }, wait);
      c.on('message', (m) => { clearTimeout(timer); c.close(); resolve(m); });
      c.send(packet, port, '127.0.0.1');
    });
  }

  it('answers a Binding Request with our own address, ignores garbage and rate-limits', async () => {
    const server = await startStunServer({ port: 0, host: '127.0.0.1', maxRequestsPerSecond: 3 });
    try {
      const txid = crypto.randomBytes(12);
      const res = await query(server.port, encodeBindingRequest(txid));
      const decoded = decodeBindingSuccess(res!)!;
      expect(decoded.address).toBe('127.0.0.1');
      expect(decoded.transactionId.equals(txid)).toBe(true);
      expect(decoded.port).toBeGreaterThan(0);

      const bad = encodeBindingRequest(txid);
      bad.writeUInt32BE(1, 4);
      expect(await query(server.port, bad)).toBeNull();

      // 이 시점까지 요청 2개(또는 창 경계라면 새 창) 사용: 연속 전송하면 3개 초과분은 응답 없음
      let answered = 0;
      for (let i = 0; i < 6; i++) {
        if (await query(server.port, encodeBindingRequest(crypto.randomBytes(12)), 100)) answered++;
      }
      expect(answered).toBeLessThan(6);
    } finally {
      await server.close();
    }
  });
});
