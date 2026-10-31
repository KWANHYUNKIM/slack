import dgram from 'dgram';
import net from 'net';
import { decodeBindingRequest, encodeBindingSuccess, ipv6ToBytes } from './stunMessage.js';

export interface StunServerOptions {
  port: number;
  host: string;
  /** IP(IPv6는 /64)당 초당 허용 요청 수. 넘으면 응답 없이 버린다. */
  maxRequestsPerSecond?: number;
}

/** 고정 창 방식의 IP별 rate limiter. 반사 증폭 공격에 서버가 쓰이지 않게 한다. */
export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private max: number, private maxKeys = 10_000) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= 1000) {
      if (!entry && this.hits.size >= this.maxKeys) this.sweep(now);
      // 정리 후에도 가득 차면 새 IP는 거부한다(메모리 상한)
      if (!entry && this.hits.size >= this.maxKeys) return false;
      this.hits.set(key, { windowStart: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }

  sweep(now = Date.now()): void {
    for (const [k, v] of this.hits) if (now - v.windowStart >= 1000) this.hits.delete(k);
  }

  get size(): number { return this.hits.size; }
}

/** IPv6는 /64 단위로 묶어 주소를 바꿔 가며 제한을 피하지 못하게 한다. */
export function rateLimitKey(address: string): string {
  if (net.isIPv6(address.split('%')[0])) {
    const b = ipv6ToBytes(address);
    if (b) return b.subarray(0, 8).toString('hex');
  }
  return address;
}

export interface StunServer {
  socket: dgram.Socket;
  port: number;
  close: () => Promise<void>;
}

export function startStunServer(opts: StunServerOptions): Promise<StunServer> {
  const limiter = new RateLimiter(opts.maxRequestsPerSecond ?? 20);
  const socket = dgram.createSocket({ type: net.isIPv6(opts.host) ? 'udp6' : 'udp4' });
  const sweeper = setInterval(() => limiter.sweep(), 5_000);
  sweeper.unref();

  socket.on('message', (msg, rinfo) => {
    // 제한을 먼저 검사해 쓰레기 패킷 폭주에도 파싱 비용을 아낀다
    if (!limiter.allow(rateLimitKey(rinfo.address))) return;
    const req = decodeBindingRequest(msg);
    if (!req) return;
    const res = encodeBindingSuccess(req.transactionId, rinfo.address, rinfo.port);
    if (!res) return;
    socket.send(res, rinfo.port, rinfo.address, () => {});
  });
  // 소켓 오류로 프로세스가 죽지 않게 한다
  socket.on('error', (err) => console.error('STUN socket error:', err.message));

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(opts.port, opts.host, () => {
      socket.off('error', reject);
      resolve({
        socket,
        port: socket.address().port,
        close: () => new Promise<void>((done) => {
          clearInterval(sweeper);
          socket.close(() => done());
        }),
      });
    });
  });
}
