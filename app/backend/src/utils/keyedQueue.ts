import { logError } from './logger.js';

// 응답 뒤에 await 없이 도는 작업을 추적한다. 테스트가 끝나길 기다릴 때(settleBackgroundWork)만 쓴다.
const pending = new Set<Promise<unknown>>();
const noop = () => undefined;

export function trackBackground<T>(p: Promise<T>): Promise<T> {
  pending.add(p);
  // finally를 쓰면 p가 reject될 때 새 promise도 reject되어 처리되지 않은 rejection이 된다.
  const done = () => { pending.delete(p); };
  p.then(done, done);
  return p;
}

export async function settleBackgroundWork(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

/**
 * 키별 직렬 실행 큐. 같은 키의 작업은 들어온 순서대로 하나씩 돌고, 다른 키끼리는 동시에 돈다.
 * 앞 작업이 실패해도 뒤 작업은 그대로 돈다. 모든 작업은 settleBackgroundWork로 기다릴 수 있다.
 */
export class KeyedQueue<K = string> {
  private readonly tails = new Map<K, Promise<void>>();

  /** 작업 결과를 돌려준다. 작업이 실패하면 reject하므로 호출자가 await하거나 catch해야 한다. */
  run<T>(key: K, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(noop, noop); // 체인은 항상 resolve해서 뒤 작업을 막지 않는다
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return trackBackground(result);
  }

  /** 기다리지 않는 작업. 실패는 로그만 남긴다. */
  fire(key: K, task: () => Promise<unknown>, errorMessage: string): void {
    this.run(key, task).catch((err) => logError(errorMessage, err));
  }
}
