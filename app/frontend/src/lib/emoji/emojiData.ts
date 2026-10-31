import { useEffect, useState } from 'react';
import type { EmojiMartData } from './emojiLookup';

/**
 * emoji-mart 데이터를 같은 출처의 lazy 청크로 읽는다 (규칙 17).
 * Picker, 리액션, :단축코드: 변환이 모두 이 한 곳을 거치므로 emoji-mart가 CDN으로 받으러 가지 않는다.
 */
let cached: EmojiMartData | null = null;
let pending: Promise<EmojiMartData> | null = null;

export function loadEmojiData(): Promise<EmojiMartData> {
  pending ??= import('@emoji-mart/data').then((m) => {
    cached = m.default as unknown as EmojiMartData;
    return cached;
  });
  return pending;
}

/** 데이터가 로드되면 돌려주고, 그 전에는 null. */
export function useEmojiData(): EmojiMartData | null {
  const [data, setData] = useState<EmojiMartData | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    loadEmojiData().then(
      (d) => alive && setData(d),
      (err) => console.warn('emoji data load failed', err),
    );
    return () => {
      alive = false;
    };
  }, []);
  return data;
}
