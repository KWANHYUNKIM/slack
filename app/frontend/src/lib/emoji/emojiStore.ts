import { replaceShortcodes, type EmojiMartData } from './emojiLookup.ts';

/**
 * 이모지 데이터 로더 상태. React와 무관한 순수 로직이라 node --test로 검증한다.
 * loader는 같은 출처의 lazy 청크를 읽는 함수다 (규칙 17).
 */
export function createEmojiDataStore(loader: () => Promise<EmojiMartData>) {
  let cached: EmojiMartData | null = null;
  let pending: Promise<EmojiMartData> | null = null;
  const listeners = new Set<() => void>();

  /** 로드한다. 실패하면 pending을 비워 다음 호출에서 다시 시도한다. */
  function load(): Promise<EmojiMartData> {
    if (cached) return Promise.resolve(cached);
    pending ??= loader().then(
      (d) => {
        cached = d;
        listeners.forEach((l) => l());
        return d;
      },
      (err) => {
        pending = null;
        throw err;
      },
    );
    return pending;
  }

  /** 제한 시간 안에 못 받거나 실패하면 null. 전송 경로처럼 기다리면 안 되는 곳에서 쓴다. */
  async function loadWithin(ms: number): Promise<EmojiMartData | null> {
    if (cached) return cached;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    try {
      return await Promise.race([load().catch(() => null), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 전송 직전 변환. 데이터가 없으면 짧게 기다리고, 끝내 없으면 원문 그대로 돌려준다. */
  async function convertForSend(text: string, ms = 1500): Promise<string> {
    if (!text.includes(':')) return text;
    const data = await loadWithin(ms);
    return data ? replaceShortcodes(text, data) : text;
  }

  return {
    load,
    loadWithin,
    convertForSend,
    getSnapshot: () => cached,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
