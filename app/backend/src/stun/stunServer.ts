import dgram from 'dgram';
import net from 'net';
import { decodeBindingRequest, encodeBindingSuccess, ipv4ToBytes, ipv6ToBytes, isV4Mapped } from './stunMessage.js';

export interface StunServerOptions {
  port: number;
  host: string;
  /** IP(IPv6는 /64)당 초당 허용 요청 수. 넘으면 응답 없이 버린다. */
  maxRequestsPerSecond?: number;
  /** rate limit 표가 추적할 최대 IP 수. 가득 차면 가장 오래된 항목부터 내보낸다. */
  maxTrackedIps?: number;
}

/**
 * 고정 창 방식의 IP별 rate limiter. 반사 증폭 공격에 서버가 쓰이지 않게 한다.
 * Map의 삽입 순서를 LRU로 쓴다: 접근할 때마다 맨 뒤로 옮기고, 가득 차면 맨 앞(가장 오래된 것)을 내보낸다.
 * 새 IP를 거부하면 스푸핑 패킷으로 표를 채워 정상 사용자를 막을 수 있어서 거부하지 않는다.
 */
export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private max: number, private maxKeys = 10_000) {}

  allow(key: string, now = Date.now()): boolean {
    let entry = this.hits.get(key);
    if (entry) this.hits.delete(key);
    if (!entry || now - entry.windowStart >= 1000) {
      entry = { windowStart: now, count: 0 };
    }
    entry.count++;
    this.hits.set(key, entry);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return entry.count <= this.max;
  }

  sweep(now = Date.now()): void {
    for (const [k, v] of this.hits) if (now - v.windowStart >= 1000) this.hits.delete(k);
  }

  get size(): number { return this.hits.size; }
}

/** IPv4-mapped(::ffff:a.b.c.d)는 IPv4로 정규화하고, 나머지 IPv6는 /64 단위로 묶는다. */
export function rateLimitKey(address: string): string {
  const addr = address.split('%')[0];
  if (net.isIPv6(addr)) {
    const b = ipv6ToBytes(addr);
    if (b) {
      if (isV4Mapped(b)) return Array.from(b.subarray(12)).join('.');
      return b.subarray(0, 8).toString('hex');
    }
  }
  if (ipv4ToBytes(addr)) return addr;
  return addr;
}

/** 패킷 한 개의 처리: 형식 검증 -> rate limit -> 응답 생성. 응답하지 않을 패킷은 null. */
export function handleStunPacket(msg: Buffer, address: string, port: number, limiter: RateLimiter): Buffer | null {
  // 형식 검증을 먼저 해서, 검증하지 않은 패킷이 rate limit 표를 채우지 못하게 한다
  const req = decodeBindingRequest(msg);
  if (!req) return null;
  if (!limiter.allow(rateLimitKey(address))) return null;
  return encodeBindingSuccess(req.transactionId, address, port);
}

export interface StunServer {
  socket: dgram.Socket;
  port: number;
  close: () => Promise<void>;
}

// 실제로 바인드된 포트. 설정이 아니라 이 값을 기준으로 /huddles/config가 STUN을 광고한다.
let listeningPort: number | null = null;
export function getStunListeningPort(): number | null { return listeningPort; }

export function startStunServer(opts: StunServerOptions): Promise<StunServer> {
  const limiter = new RateLimiter(opts.maxRequestsPerSecond ?? 20, opts.maxTrackedIps ?? 10_000);
  const socket = dgram.createSocket({ type: net.isIPv6(opts.host) ? 'udp6' : 'udp4' });
  const sweeper = setInterval(() => limiter.sweep(), 5_000);
  sweeper.unref();

  socket.on('message', (msg, rinfo) => {
    const res = handleStunPacket(msg, rinfo.address, rinfo.port, limiter);
    if (res) socket.send(res, rinfo.port, rinfo.address, () => {});
  });

  return new Promise((resolve, reject) => {
    const onBindError = (err: Error) => {
      clearInterval(sweeper);
      socket.close();
      reject(err);
    };
    socket.once('error', onBindError);
    socket.bind(opts.port, opts.host, () => {
      socket.off('error', onBindError);
      // 이후 소켓 오류로 프로세스가 죽지 않게 하고, 광고도 내린다
      socket.on('error', (err) => {
        console.error('STUN socket error:', err.message);
        listeningPort = null;
      });
      const port = socket.address().port;
      listeningPort = port;
      resolve({
        socket,
        port,
        close: () => new Promise<void>((done) => {
          clearInterval(sweeper);
          if (listeningPort === port) listeningPort = null;
          socket.close(() => done());
        }),
      });
    });
  });
}
