// 파일별 다운로드 토큰 캐시(순수 로직). fetch·타이머·시계는 밖에서 주입한다.
//
// - 토큰이 없으면 URL을 만들지 않는다(peek이 ready가 아니다). 컴포넌트가 자리표시자를 그린다.
// - 만료 전(REFRESH_MS)에 곧 만료될 것들을 한 번에 갱신한다. 새 토큰이 올 때까지 기존 토큰을 쓴다.
// - 서버가 토큰을 주지 않은 파일은 DENIED_MS 동안 거부 상태로 두고 다시 묻지 않는다.
// - 진행 중인 id는 집합으로 추적해 같은 id를 두 번 요청하지 않는다.
// - clear()가 세대를 올리고, 세대가 다른 응답은 버린다(로그아웃 뒤 늦게 온 응답).

export const TOKEN_TTL_MS = 5 * 60 * 1000; // 서버 발급 수명(5분)과 같다
export const REFRESH_MS = 3.5 * 60 * 1000; // 발급 3분 30초 뒤 갱신
export const DENIED_MS = 60 * 1000;
export const FAILURE_MS = 10 * 1000; // 네트워크 오류는 짧게만 쉰다
export const BATCH_DELAY_MS = 20;
export const DEFAULT_BATCH_LIMIT = 50;

export interface TokenResponse {
  tokens: Record<string, string>;
  /** 서버가 한 번에 받는 파일 수 */
  limit?: number;
}

export type FetchTokens = (fileIds: number[]) => Promise<TokenResponse | null>;

export interface TimerApi {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export type TokenState =
  | { status: 'ready'; token: string }
  | { status: 'denied' }
  | { status: 'pending' };

interface Entry {
  token?: string;
  issuedAt: number;
  /** 다음 갱신 시각(발급 + REFRESH_MS, 갱신 실패 시 짧게 뒤로 민다) */
  refreshAt?: number;
  /** 거부·실패 상태의 끝 시각 */
  deniedUntil?: number;
}

export interface FileTokenCacheDeps {
  fetchTokens: FetchTokens;
  now?: () => number;
  timers?: TimerApi;
}

export function createFileTokenCache(deps: FileTokenCacheDeps) {
  const now = deps.now ?? (() => Date.now());
  const timers: TimerApi = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  const entries = new Map<number, Entry>();
  const inflight = new Set<number>(); // 요청 대기 + 응답 대기
  const queued = new Set<number>(); // 아직 보내지 않은 것
  const listeners = new Set<() => void>();
  let generation = 0;
  let version = 0;
  let batchLimit = DEFAULT_BATCH_LIMIT;
  let flushHandle: unknown = null;
  let refreshHandle: unknown = null;
  let requestCount = 0;

  function notify() {
    version++;
    listeners.forEach((l) => l());
  }

  function peek(fileId: number): TokenState {
    const e = entries.get(fileId);
    if (!e) return { status: 'pending' };
    const t = now();
    if (e.token !== undefined) {
      if (t - e.issuedAt < TOKEN_TTL_MS) return { status: 'ready', token: e.token };
      return { status: 'pending' };
    }
    if (e.deniedUntil !== undefined && t < e.deniedUntil) return { status: 'denied' };
    return { status: 'pending' };
  }

  function needsRequest(fileId: number): boolean {
    if (inflight.has(fileId)) return false;
    const e = entries.get(fileId);
    if (!e) return true;
    const t = now();
    if (e.token !== undefined) return t - e.issuedAt >= TOKEN_TTL_MS;
    return e.deniedUntil === undefined || t >= e.deniedUntil;
  }

  function enqueue(fileIds: number[]) {
    let added = false;
    for (const id of fileIds) {
      if (!queued.has(id) && !inflight.has(id)) {
        queued.add(id);
        inflight.add(id);
        added = true;
      }
    }
    if (added && flushHandle === null) {
      flushHandle = timers.setTimeout(() => {
        flushHandle = null;
        void flush();
      }, BATCH_DELAY_MS);
    }
  }

  /** 아직 토큰이 없거나 만료된 id만 골라 요청한다. 같은 id는 한 번만 나간다. */
  function ensure(fileIds: number[]) {
    enqueue(fileIds.filter(needsRequest));
  }

  async function flush() {
    const ids = [...queued];
    queued.clear();
    const gen = generation;
    // 서버 한도에 맞춰 나눈다
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += batchLimit) chunks.push(ids.slice(i, i + batchLimit));
    await Promise.all(chunks.map((chunk) => fetchChunk(chunk, gen)));
  }

  async function fetchChunk(chunk: number[], gen: number) {
    let res: TokenResponse | null = null;
    requestCount++;
    try {
      res = await deps.fetchTokens(chunk);
    } catch {
      res = null;
    }
    if (gen !== generation) return; // 로그아웃 등으로 세대가 바뀌었다: 응답을 버린다(inflight는 clear가 비웠다)
    const t = now();
    for (const id of chunk) {
      inflight.delete(id);
      const prev = entries.get(id);
      if (res === null) {
        // 실패: 기존 토큰이 아직 유효하면 유지하고, 아니면 잠깐 쉰다
        if (!prev || prev.token === undefined || t - prev.issuedAt >= TOKEN_TTL_MS) {
          entries.set(id, { issuedAt: t, deniedUntil: t + FAILURE_MS });
        } else {
          prev.refreshAt = t + FAILURE_MS;
        }
        continue;
      }
      const token = res.tokens[String(id)];
      if (token) entries.set(id, { token, issuedAt: t, refreshAt: t + REFRESH_MS });
      else entries.set(id, { issuedAt: t, deniedUntil: t + DENIED_MS });
    }
    if (res?.limit && res.limit > 0) batchLimit = res.limit;
    scheduleRefresh();
    notify(); // 묶음 하나당 한 번
  }

  /** 가장 먼저 갱신해야 할 토큰 시각에 타이머 하나만 건다. */
  function scheduleRefresh() {
    if (refreshHandle !== null) {
      timers.clearTimeout(refreshHandle);
      refreshHandle = null;
    }
    let earliest = Infinity;
    for (const [id, e] of entries) {
      if (e.token !== undefined && !inflight.has(id)) earliest = Math.min(earliest, e.refreshAt ?? e.issuedAt + REFRESH_MS);
    }
    if (earliest === Infinity) return;
    const gen = generation;
    refreshHandle = timers.setTimeout(() => {
      refreshHandle = null;
      if (gen !== generation) return;
      const t = now();
      const due: number[] = [];
      for (const [id, e] of entries) {
        // 같은 타이머로 곧(몇 초 안에) 만료될 것까지 묶는다. 갱신 중에도 기존 토큰은 그대로 유효하다.
        if (e.token !== undefined && (e.refreshAt ?? e.issuedAt + REFRESH_MS) <= t + BATCH_DELAY_MS && !inflight.has(id)) due.push(id);
      }
      enqueue(due); // 응답(성공이든 실패든)이 오면 fetchChunk가 다음 갱신 타이머를 건다
    }, Math.max(0, earliest - now()));
  }

  function clear() {
    generation++;
    entries.clear();
    inflight.clear();
    queued.clear();
    if (flushHandle !== null) timers.clearTimeout(flushHandle);
    if (refreshHandle !== null) timers.clearTimeout(refreshHandle);
    flushHandle = null;
    refreshHandle = null;
    notify();
  }

  return {
    peek,
    ensure,
    clear,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getVersion: () => version,
    getGeneration: () => generation,
    /** 테스트용: 지금까지 서버로 보낸 요청 수 */
    getRequestCount: () => requestCount,
    getBatchLimit: () => batchLimit,
  };
}

export type FileTokenCache = ReturnType<typeof createFileTokenCache>;

/**
 * 파일 id로 다운로드 URL을 만든다. 토큰이 없으면 null이라 호출한 쪽이 자리표시자를 그려야 한다.
 */
export function buildFileUrl(fileId: number, state: TokenState, { download = false }: { download?: boolean } = {}): string | null {
  if (state.status !== 'ready') return null;
  const params = download ? `dl=1&token=${state.token}` : `token=${state.token}`;
  return `/files/${fileId}/download?${params}`;
}
