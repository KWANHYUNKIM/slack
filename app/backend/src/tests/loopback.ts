import dns from 'dns';
import http from 'http';

// supertest는 서버를 `app.listen(0)`으로 띄우고 `http://127.0.0.1:<port>`로 접속한다.
// host 없이 listen하면 듀얼스택(::)에 바인딩되는데, macOS는 같은 포트를 127.0.0.1에만 바인딩한 다른 프로세스(IDE, 로컬 프록시 등)를
// 허용하고 127.0.0.1 접속은 그쪽으로 보낸다. 그러면 요청이 우리 앱이 아닌 남의 서버에 가서 "WebSockets request was expected" 같은
// 응답이 오거나 응답 없이 30초 타임아웃이 난다(1,500번 호출에 1~2번꼴로 재현). 127.0.0.1에 직접 바인딩하면 포트 충돌 시 커널이 다른 포트를 고른다.
// supertest는 listen 직후 address()를 바로 읽으므로 동기로 바인딩해야 한다. host를 주면 Node가 dns.lookup을 거쳐 비동기가 되므로,
// IP 리터럴 조회만 그 자리에서 동기로 응답하게 한 번 바꿔 끼운다. tests/loopback.test.ts가 이 전제(동기 바인딩, 127.0.0.1)를 검사한다.
const PATCHED = Symbol.for('slackclone.loopbackListen');
const LOOPBACK = '127.0.0.1';

export function bindEphemeralListenToLoopback(): void {
  const proto = http.Server.prototype as unknown as Record<symbol, boolean> & { listen: (...args: unknown[]) => unknown };
  if (proto[PATCHED]) return;
  const original = proto.listen;
  proto.listen = function patchedListen(this: http.Server, ...args: unknown[]) {
    // supertest의 호출 형태만 바꾼다: listen(0). 다른 테스트가 host나 콜백을 주는 호출은 그대로 둔다.
    if (args.length !== 1 || args[0] !== 0) return original.apply(this, args);
    const realLookup = dns.lookup;
    (dns as { lookup: unknown }).lookup = (host: string, ...rest: unknown[]) => {
      if (host !== LOOPBACK) return (realLookup as (...a: unknown[]) => unknown)(host, ...rest);
      const cb = rest[rest.length - 1] as (err: null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
      const opts = rest.length > 1 ? (rest[0] as { all?: boolean } | number | undefined) : undefined;
      // Node 24는 all: true로 조회한다(주소 배열 형태로 응답해야 한다)
      if (opts && typeof opts === 'object' && opts.all) cb(null, [{ address: LOOPBACK, family: 4 }]);
      else cb(null, LOOPBACK, 4);
      return {};
    };
    try {
      return original.call(this, 0, LOOPBACK);
    } finally {
      (dns as { lookup: unknown }).lookup = realLookup;
    }
  };
  proto[PATCHED] = true;
}
