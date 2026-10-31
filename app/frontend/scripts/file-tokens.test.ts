import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFileTokenCache, buildFileUrl, REFRESH_MS, TOKEN_TTL_MS, DENIED_MS, BATCH_DELAY_MS,
  type FetchTokens, type TokenResponse,
} from '../src/lib/fileTokens.ts';

// 가짜 시계와 타이머: advance(ms)로 시간을 흘리고 만료된 타이머와 마이크로태스크를 처리한다.
function harness(opts: { accessible?: (id: number) => boolean; limit?: number; manual?: boolean } = {}) {
  let time = 1_000_000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const calls: number[][] = [];
  const pendingResolvers: Array<() => void> = [];
  const fetchTokens: FetchTokens = (ids) => {
    calls.push(ids);
    const respond = (): TokenResponse => ({
      tokens: Object.fromEntries(ids.filter((i) => (opts.accessible ?? (() => true))(i)).map((i) => [String(i), `tok${i}-${++seq}`])),
      limit: opts.limit ?? 50,
    });
    if (!opts.manual) return Promise.resolve(respond());
    return new Promise((resolve) => pendingResolvers.push(() => resolve(respond())));
  };
  let timerId = 0;
  const cache = createFileTokenCache({
    fetchTokens,
    now: () => time,
    timers: {
      setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { at: time + ms, fn }); return id; },
      clearTimeout: (h) => { timers.delete(h as number); },
    },
  });
  async function advance(ms: number) {
    const target = time + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = Math.max(time, next[1].at);
      timers.delete(next[0]);
      next[1].fn();
      await new Promise((r) => setImmediate(r));
    }
    time = target;
    await new Promise((r) => setImmediate(r));
  }
  return { cache, calls, advance, resolveAll: async () => { while (pendingResolvers.length) pendingResolvers.shift()!(); await new Promise((r) => setImmediate(r)); }, now: () => time };
}

test('토큰이 없으면 URL은 null이고, 도착하면 파일별 토큰 URL이 된다', async () => {
  const h = harness();
  assert.equal(buildFileUrl(1, h.cache.peek(1)), null);
  h.cache.ensure([1]);
  await h.advance(BATCH_DELAY_MS + 1);
  const url = buildFileUrl(1, h.cache.peek(1));
  assert.match(url!, /^\/files\/1\/download\?token=tok1-/);
  assert.match(buildFileUrl(1, h.cache.peek(1), { download: true })!, /\?dl=1&token=/);
});

test('같은 id를 여러 번 ensure해도 요청은 한 번이다', async () => {
  const h = harness({ manual: true });
  h.cache.ensure([1, 2]);
  h.cache.ensure([2, 3]);
  await h.advance(BATCH_DELAY_MS + 1);
  h.cache.ensure([1, 2, 3]); // 응답 대기 중 다시 호출
  await h.advance(BATCH_DELAY_MS + 1);
  assert.deepEqual(h.calls, [[1, 2, 3]]);
  await h.resolveAll();
  assert.equal(h.calls.length, 1);
  assert.equal(h.cache.peek(3).status, 'ready');
});

test('120개 파일은 3묶음(50·50·20)으로 중복 없이 요청된다', async () => {
  const h = harness();
  const ids = Array.from({ length: 120 }, (_, i) => i + 1);
  h.cache.ensure(ids);
  h.cache.ensure(ids);
  await h.advance(BATCH_DELAY_MS + 1);
  assert.deepEqual(h.calls.map((c) => c.length), [50, 50, 20]);
  assert.equal(new Set(h.calls.flat()).size, 120);
  assert.equal(h.cache.getRequestCount(), 3);
  assert.equal(h.cache.peek(120).status, 'ready');
});

test('서버가 limit을 내려 주면 다음 묶음 크기가 따라간다', async () => {
  const h = harness({ limit: 10 });
  h.cache.ensure([1]);
  await h.advance(BATCH_DELAY_MS + 1);
  assert.equal(h.cache.getBatchLimit(), 10);
  h.cache.ensure(Array.from({ length: 25 }, (_, i) => 100 + i));
  await h.advance(BATCH_DELAY_MS + 1);
  assert.deepEqual(h.calls.slice(1).map((c) => c.length), [10, 10, 5]);
});

test('접근 못 하는 파일은 거부로 캐시되고 60초 동안 다시 요청하지 않는다', async () => {
  const h = harness({ accessible: (id) => id !== 2 });
  h.cache.ensure([1, 2, 3]);
  await h.advance(BATCH_DELAY_MS + 1);
  assert.equal(h.cache.peek(2).status, 'denied');
  assert.equal(buildFileUrl(2, h.cache.peek(2)), null);
  for (let i = 0; i < 20; i++) { h.cache.ensure([2]); await h.advance(1000); }
  assert.equal(h.calls.length, 1, '20초 동안 재요청 없음');
  await h.advance(DENIED_MS);
  assert.equal(h.cache.peek(2).status, 'pending');
  h.cache.ensure([2]);
  await h.advance(BATCH_DELAY_MS + 1);
  assert.equal(h.calls.length, 2);
});

test('만료 전에 갱신하고, 갱신 응답이 오기 전까지 기존 토큰 URL이 유지된다', async () => {
  const h = harness({ manual: true });
  h.cache.ensure([1, 2]);
  await h.advance(BATCH_DELAY_MS + 1);
  await h.resolveAll();
  const first1 = (h.cache.peek(1) as { token: string }).token;
  assert.equal(h.calls.length, 1);

  await h.advance(REFRESH_MS + BATCH_DELAY_MS + 1); // 갱신 요청이 나갔지만 아직 응답 전
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].sort(), [1, 2], '곧 만료될 것들을 한 번에 묶는다');
  assert.equal((h.cache.peek(1) as { token: string }).token, first1, '응답 전에도 기존 토큰');
  // 만료 시각 직전까지도 비지 않는다
  await h.advance(TOKEN_TTL_MS - REFRESH_MS - 2000);
  assert.equal(h.cache.peek(1).status, 'ready');

  let notified = 0;
  h.cache.subscribe(() => notified++);
  await h.resolveAll();
  assert.notEqual((h.cache.peek(1) as { token: string }).token, first1, '새 토큰으로 교체');
  assert.equal(notified, 1, '묶음 하나당 notify 한 번');
});

test('갱신이 실패해도 토큰이 살아 있는 동안은 유지되고 짧게 쉬었다 다시 시도한다', async () => {
  let fail = false;
  let time = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let tid = 0;
  let n = 0;
  const cache = createFileTokenCache({
    fetchTokens: async (ids) => {
      if (fail) throw new Error('offline');
      return { tokens: Object.fromEntries(ids.map((i) => [String(i), `t${++n}`])) };
    },
    now: () => time,
    timers: {
      setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, { at: time + ms, fn }); return id; },
      clearTimeout: (h) => { timers.delete(h as number); },
    },
  });
  const advance = async (ms: number) => {
    const target = time + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at; timers.delete(next[0]); next[1].fn();
      await new Promise((r) => setImmediate(r));
    }
    time = target; await new Promise((r) => setImmediate(r));
  };
  cache.ensure([1]);
  await advance(BATCH_DELAY_MS + 1);
  const first = (cache.peek(1) as { token: string }).token;
  fail = true;
  await advance(REFRESH_MS);
  assert.equal((cache.peek(1) as { token: string }).token, first);
  fail = false;
  await advance(15_000);
  assert.notEqual((cache.peek(1) as { token: string }).token, first, '재시도로 교체');
});

test('로그아웃(clear) 뒤 늦게 도착한 응답은 버린다', async () => {
  const h = harness({ manual: true });
  h.cache.ensure([1]);
  await h.advance(BATCH_DELAY_MS + 1);
  h.cache.clear();
  await h.resolveAll();
  assert.equal(h.cache.peek(1).status, 'pending');
  assert.equal(h.cache.getGeneration(), 1);
  // 다시 로그인하면 새로 요청할 수 있다
  h.cache.ensure([1]);
  await h.advance(BATCH_DELAY_MS + 1);
  await h.resolveAll();
  assert.equal(h.cache.peek(1).status, 'ready');
});

test('접근 불가 파일이 섞인 목록도 요청 수가 묶음 수로 제한된다', async () => {
  const h = harness({ accessible: (id) => id % 2 === 0 });
  const ids = Array.from({ length: 100 }, (_, i) => i + 1);
  for (let round = 0; round < 10; round++) {
    h.cache.ensure(ids);
    await h.advance(2000);
  }
  assert.equal(h.cache.getRequestCount(), 2, '100개/50 = 2회, 거부된 절반도 다시 묻지 않는다');
});
