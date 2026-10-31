import type { SearchParsedFilters } from '@/lib/api';

// 검색 질의 보조 함수. 해석(파싱)은 서버가 하고 응답의 parsedFilters를 쓴다.
// 여기서는 칩 목록, 칩 제거로 질의 다시 만들기, 하이라이트 조각 나누기만 한다.

export interface FilterChip {
  key: 'from' | 'in' | 'before' | 'after' | 'on' | 'has' | 'is';
  value: string;
  /** 칩에 보이는 글자(연산자 이름은 번역하지 않는 고정 문법) */
  label: string;
}

export function chipsOf(f: SearchParsedFilters | undefined): FilterChip[] {
  if (!f) return [];
  const chips: FilterChip[] = [];
  f.from.forEach((v) => chips.push({ key: 'from', value: v, label: `from:@${v}` }));
  f.in.forEach((v) => chips.push({ key: 'in', value: v, label: `in:#${v}` }));
  (['before', 'after', 'on'] as const).forEach((k) => {
    const v = f[k];
    if (v) chips.push({ key: k, value: v, label: `${k}:${v}` });
  });
  f.has.forEach((v) => chips.push({ key: 'has', value: v, label: `has:${v}` }));
  f.is.forEach((v) => chips.push({ key: 'is', value: v, label: `is:${v}` }));
  return chips;
}

/** 공백으로 나누되 큰따옴표 구간은 한 토큰으로 묶는다(서버 파서와 같은 규칙). 원문 글자를 그대로 돌려준다. */
function splitRaw(input: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
    } else if (!inQuote && /\s/u.test(ch)) {
      if (cur) tokens.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** 칩 하나에 해당하는 토큰을 질의에서 뺀 새 질의. */
export function removeChip(query: string, chip: FilterChip): string {
  const norm = (s: string) => s.replace(/"/g, '').normalize('NFC').toLowerCase();
  return splitRaw(query)
    .filter((tok) => {
      const idx = tok.indexOf(':');
      if (idx <= 0) return true;
      const key = tok.slice(0, idx).toLowerCase();
      if (key !== chip.key) return true;
      const value = norm(tok.slice(idx + 1)).replace(/^[@#]/, '');
      return value !== norm(chip.value);
    })
    .join(' ');
}

/** 연산자 토큰을 모두 뺀 질의(칩을 따로 보여 줄 때 키워드만 남긴다). */
export function stripFilters(query: string, chips: FilterChip[]): string {
  return chips.reduce((q, chip) => removeChip(q, chip), query);
}

export interface HighlightPart { text: string; mark: boolean }

/** 서버가 준 [시작, 끝) 구간으로 본문을 조각낸다. HTML이 아니라 조각 목록이라 XSS 위험이 없다. */
export function splitHighlights(text: string, ranges: Array<[number, number]> | undefined): HighlightPart[] {
  if (!ranges || ranges.length === 0) return [{ text, mark: false }];
  const parts: HighlightPart[] = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start < pos || end > text.length || start >= end) continue;
    if (start > pos) parts.push({ text: text.slice(pos, start), mark: false });
    parts.push({ text: text.slice(start, end), mark: true });
    pos = end;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), mark: false });
  return parts;
}
