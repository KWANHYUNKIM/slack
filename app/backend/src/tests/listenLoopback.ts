import type { Server } from 'http';
import type { AddressInfo } from 'net';

export const LOOPBACK_HOST = '127.0.0.1';

// 테스트 서버를 127.0.0.1에 명시적으로 바인딩하고 실제 포트를 돌려준다.
// host를 생략하면 듀얼스택(::)에 잡혀, macOS에서 같은 포트를 127.0.0.1에만 잡은 다른 프로세스가 요청을 가로챌 수 있다(tests/loopback.ts 참고).
// 접속 URL도 `http://127.0.0.1:<port>`로 맞춘다. localhost는 IPv6(::1)로 풀려 같은 문제가 생길 수 있다.
export function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}
