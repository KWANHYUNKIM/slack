// 실패 횟수 기반 잠금(로그인, 비밀번호 변경, 2FA 코드 확인이 함께 쓴다). 메모리 맵이라 크기 상한을 둔다.
// 규칙: 실패가 max번 쌓이면 lockMs 동안 잠그고 카운터를 0으로 되돌린다. 잠금이 풀리거나 lockMs 동안 활동이 없으면 항목을 지운다.

interface Entry { count: number; lockedUntil: number; lastAttempt: number }

export interface AttemptLimiter<K> {
  isLocked(key: K, now?: number): boolean;
  /** 실패 한 번을 센다. 이번 실패로 잠기기 시작했으면 true(그 순간 한 번만 감사 로그를 남길 수 있게). */
  recordFailure(key: K, now?: number): boolean;
  /**
   * 검증 전에 시도 한 번을 먼저 센다(동시 요청이 몰려도 한도를 넘겨 검증되지 않게). 잠겨 있으면 false.
   * 성공하면 호출한 쪽이 clear()로 비운다. 반환값 locked는 이번 시도로 잠기기 시작했는지다.
   */
  tryAcquire(key: K, now?: number): { ok: boolean; locked: boolean };
  clear(key: K): void;
  /** 테스트와 정리용 */
  size(): number;
}

export function createAttemptLimiter<K>(opts: { max: number; lockMs: number; maxEntries: number }): AttemptLimiter<K> {
  const entries = new Map<K, Entry>();

  const expired = (e: Entry, now: number) =>
    (e.lockedUntil > 0 && e.lockedUntil < now) || (e.lockedUntil === 0 && now - e.lastAttempt > opts.lockMs);

  const sweep = (now: number) => {
    for (const [k, e] of entries) if (expired(e, now)) entries.delete(k);
  };

  setInterval(() => sweep(Date.now()), 5 * 60 * 1000).unref();

  const isLocked = (key: K, now = Date.now()) => {
    const e = entries.get(key);
    return !!e && e.lockedUntil > now;
  };

  const recordFailure = (key: K, now = Date.now()): boolean => {
    let e = entries.get(key);
    if (!e) {
      if (entries.size >= opts.maxEntries) sweep(now);
      // 그래도 가득 차면 새 키는 세지 않는다(메모리가 무한히 늘지 않게 하는 쪽을 택한다. 기존 동작과 같다)
      if (entries.size >= opts.maxEntries) return false;
      e = { count: 0, lockedUntil: 0, lastAttempt: now };
      entries.set(key, e);
    }
    if (e.lockedUntil > 0 && e.lockedUntil <= now) e.lockedUntil = 0;
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
    tryAcquire(key, now = Date.now()) {
      if (isLocked(key, now)) return { ok: false, locked: false };
      return { ok: true, locked: recordFailure(key, now) };
    },
    clear: (key) => { entries.delete(key); },
    size: () => entries.size,
  };
}
