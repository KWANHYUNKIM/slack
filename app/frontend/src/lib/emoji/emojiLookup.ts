/**
 * emoji-mart 데이터에서 단축코드를 찾는 순수 함수 모음.
 * 데이터 자체는 emojiData.ts가 번들 청크에서 lazy로 읽어 온다 (규칙 17, 외부 요청 없음).
 */
export interface EmojiMartData {
  emojis: Record<string, { name: string; skins?: { native?: string }[] }>;
  aliases?: Record<string, string>;
}

export interface EmojiIndexEntry {
  id: string;
  native: string;
  name: string;
}

const SHORTCODE_ALIASES: Record<string, string> = {
  mind_blown: 'exploding_head',
};

/** 리액션 단축코드를 네이티브 이모지로 바꾼다. 모르면 입력을 그대로 돌려준다. */
export function shortcodeToNative(data: EmojiMartData | null, emoji: string): string {
  const key = SHORTCODE_ALIASES[emoji] ?? emoji;
  return data?.emojis?.[key]?.skins?.[0]?.native ?? emoji;
}

/** 자동완성용 검색 목록. 별칭도 같은 이모지를 가리키는 항목으로 넣는다. */
export function buildEmojiIndex(data: EmojiMartData): EmojiIndexEntry[] {
  const { emojis, aliases = {} } = data;
  const results: EmojiIndexEntry[] = [];
  for (const [id, entry] of Object.entries(emojis)) {
    const native = entry.skins?.[0]?.native;
    if (!native) continue;
    results.push({ id, native, name: entry.name });
  }
  for (const [alias, target] of Object.entries(aliases)) {
    const entry = emojis[target];
    const native = entry?.skins?.[0]?.native;
    if (!native) continue;
    results.push({ id: alias, native, name: entry.name });
  }
  return results;
}

/** id로 바로 찾는 맵. 같은 id가 있으면 먼저 나온 항목을 쓴다. */
export function buildEmojiMap(index: EmojiIndexEntry[]): Map<string, EmojiIndexEntry> {
  const map = new Map<string, EmojiIndexEntry>();
  for (const e of index) {
    if (!map.has(e.id)) map.set(e.id, e);
  }
  return map;
}
