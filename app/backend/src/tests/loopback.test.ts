import http from 'http';
import net from 'net';

// tests/loopback.ts 의 전제를 고정한다. supertest가 쓰는 listen(0)이 127.0.0.1에 동기로 바인딩되어야
// 같은 포트를 127.0.0.1에만 잡은 다른 프로세스가 우리 요청을 가로채지 못한다.
describe('supertest ephemeral listen', () => {
  it('binds listen(0) synchronously on 127.0.0.1', () => {
    const server = http.createServer((_req, res) => res.end('ok')).listen(0);
    try {
      const addr = server.address() as net.AddressInfo | null;
      expect(addr).not.toBeNull();
      expect(addr!.address).toBe('127.0.0.1');
      expect(addr!.port).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });

  it('cannot share its port with another 127.0.0.1 listener (the foreign-server hijack)', async () => {
    const server = http.createServer((_req, res) => res.end('ours')).listen(0);
    const port = (server.address() as net.AddressInfo).port;
    try {
      const rival = net.createServer();
      const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
        rival.once('error', (e) => resolve(e as NodeJS.ErrnoException));
        rival.listen(port, '127.0.0.1', () => resolve(null));
      });
      rival.close();
      expect(err?.code).toBe('EADDRINUSE');
    } finally {
      server.close();
    }
  });

  it('leaves explicit listen calls alone', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', () => resolve()));
    expect((server.address() as net.AddressInfo).address).toBe('0.0.0.0');
    server.close();
  });
});
