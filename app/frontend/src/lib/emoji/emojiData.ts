import { useEffect, useSyncExternalStore } from 'react';
import { createEmojiDataStore } from './emojiStore.ts';
import type { EmojiMartData } from './emojiLookup.ts';

/**
 * emoji-mart 데이터를 같은 출처의 lazy 청크로 읽는다 (규칙 17).
 * Picker, 리액션, :단축코드: 변환이 모두 이 한 곳을 거치므로 emoji-mart가 CDN으로 받으러 가지 않는다.
 */
const store = createEmojiDataStore(() =>
  import('@emoji-mart/data').then((m) => m.default as unknown as EmojiMartData),
);

export const loadEmojiData = store.load;
/** 전송 직전 :단축코드:를 이모지로 바꾼다. 데이터가 늦으면 원문 그대로 보낸다. */
export const convertShortcodesForSend = store.convertForSend;

/** 로그인 직후 한가한 때 미리 읽어 깜박임을 줄인다. 실패해도 쓰는 시점에 다시 시도한다. */
export function preloadEmojiData(): () => void {
  const run = () => void store.load().catch(() => {});
  if (typeof requestIdleCallback === 'function') {
    const id = requestIdleCallback(run, { timeout: 3000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(run, 500);
  return () => clearTimeout(id);
}

/** 데이터가 로드되면 돌려주고, 그 전에는 null. 이미 로드된 뒤 마운트해도 바로 값을 받는다. */
export function useEmojiData(): EmojiMartData | null {
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (!data) store.load().catch((err) => console.warn('emoji data load failed', err));
  }, [data]);
  return data;
}
