// 실패 횟수 기반 잠금(로그인, 비밀번호 변경, 2FA 코드 확인이 함께 쓴다). 메모리 맵이라 크기 상한을 둔다.
// 규칙: 실패가 max번 쌓이면 lockMs 동안 잠그고 카운터를 0으로 되돌린다. 잠금이 풀리거나 lockMs 동안 활동이 없으면 항목을 지운다.

interface Entry {
  count: number;
  lockedUntil: number;
  lastAttempt: number;
  /** reserve()로 잡고 아직 release()하지 않은(검증 중인) 시도 수 */
  pending: number;
}

export type AttemptOutcome = 'success' | 'failure' | 'neutral';

export interface AttemptLimiter<K> {
  isLocked(key: K, now?: number): boolean;
  /** 실패 한 번을 센다. 이번 실패로 잠기기 시작했으면 true(그 순간 한 번만 감사 로그를 남길 수 있게). */
  recordFailure(key: K, now?: number): boolean;
  /**
   * 검증 전에 자리를 하나 잡는다. 잠겨 있거나 (실패 수 + 검증 중인 수)가 한도에 닿았으면 false.
   * 동시 요청이 몰려도 한도를 넘겨 검증하지 않게 하되, 실패는 결과가 나온 뒤에만 센다(맞는 코드가 잠금을 만들지 않게).
   */
  reserve(key: K, now?: number): boolean;
  /** reserve()한 자리를 돌려준다. failure면 실패로 세고 이번에 잠기기 시작했는지를, success면 실패 수를 비운다. */
  release(key: K, outcome: AttemptOutcome, now?: number): boolean;
  clear(key: K): void;
  /** 테스트와 정리용 */
  size(): number;
}

export function createAttemptLimiter<K>(opts: { max: number; lockMs: number; maxEntries: number }): AttemptLimiter<K> {
  const entries = new Map<K, Entry>();

  const expired = (e: Entry, now: number) =>
    e.pending === 0 &&
    ((e.lockedUntil > 0 && e.lockedUntil < now) || (e.lockedUntil === 0 && now - e.lastAttempt > opts.lockMs));

  const sweep = (now: number) => {
    for (const [k, e] of entries) if (expired(e, now)) entries.delete(k);
  };

  setInterval(() => sweep(Date.now()), 5 * 60 * 1000).unref();

  const isLocked = (key: K, now = Date.now()) => {
    const e = entries.get(key);
    return !!e && e.lockedUntil > now;
  };

  /** 항목을 꺼내거나 만든다. 가득 차서 만들 수 없으면 null(세지 않는다. 메모리가 무한히 늘지 않게 하는 쪽을 택한다). */
  const entryFor = (key: K, now: number): Entry | null => {
    let e = entries.get(key);
    if (!e) {
      if (entries.size >= opts.maxEntries) sweep(now);
      if (entries.size >= opts.maxEntries) return null;
      e = { count: 0, lockedUntil: 0, lastAttempt: now, pending: 0 };
      entries.set(key, e);
    }
    if (e.lockedUntil > 0 && e.lockedUntil <= now) e.lockedUntil = 0;
    return e;
  };

  const dropIfIdle = (key: K, e: Entry) => {
    if (e.pending === 0 && e.count === 0 && e.lockedUntil === 0) entries.delete(key);
  };

  const recordFailure = (key: K, now = Date.now()): boolean => {
    const e = entryFor(key, now);
    if (!e) return false;
    e.count++;
    e.lastAttempt = now;
    if (e.count >= opts.max) {
      e.lockedUntil = now + opts.lockMs;
      e.count = 0;
      return true;
    }
    return false;
  };

  return {
    isLocked,
    recordFailure,
    reserve(key, now = Date.now()) {
      if (isLocked(key, now)) return false;
      const e = entryFor(key, now);
      if (!e) return true;
      if (e.count + e.pending >= opts.max) return false;
      e.pending++;
      e.lastAttempt = now;
      return true;
    },
    release(key, outcome, now = Date.now()) {
      const e = entries.get(key);
      if (e && e.pending > 0) e.pending--;
      if (outcome === 'failure') return recordFailure(key, now);
      if (e) {
        if (outcome === 'success') e.count = 0;
        dropIfIdle(key, e);
      }
      return false;
    },
    clear: (key) => { entries.delete(key); },
    size: () => entries.size,
  };
}
