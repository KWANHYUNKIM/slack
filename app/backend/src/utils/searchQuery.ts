// 검색 질의 파서(순수 함수). 연산자 이름(from:, in:, before: ...)은 번역하지 않는 고정 문법이다.
// 정규식 대신 한 글자씩 읽는 토크나이저를 써서 ReDoS 여지를 없앤다.

export const MAX_QUERY_LENGTH = 200;
export const MAX_TERMS = 10;
export const MAX_FILTER_VALUES = 5;

export type HasKind = 'file' | 'link' | 'pin' | 'reaction';
export type IsKind = 'thread' | 'saved';

export interface DateRange {
  /** 포함 하한(UTC) */
  gte?: Date;
  /** 미포함 상한(UTC) */
  lt?: Date;
}

export interface ParsedFilters {
  from: string[];
  in: string[];
  before?: string;
  after?: string;
  on?: string;
  has: HasKind[];
  is: IsKind[];
}

export interface ParsedQuery {
  /** 연산자를 뺀 키워드(AND). 따옴표 구문은 하나의 키워드다. NFC 정규화됨 */
  terms: string[];
  filters: ParsedFilters;
}

const HAS_VALUES: readonly string[] = ['file', 'link', 'pin', 'reaction'];
const IS_VALUES: readonly string[] = ['thread', 'saved'];

/** 질의와 본문 비교를 위해 NFC로 맞춘다. */
export function nfc(s: string): string {
  return s.normalize('NFC');
}

/** 한글이 NFD로 저장된 본문도 찾을 수 있게 NFC와 NFD 두 형태를 돌려준다. */
export function termVariants(term: string): string[] {
  const a = nfc(term);
  const b = a.normalize('NFD');
  return a === b ? [a] : [a, b];
}

interface Token { text: string; /** 토큰이 따옴표로 시작한 구문이면 true(연산자로 해석하지 않는다) */ phrase: boolean }

/** 공백으로 나누되 큰따옴표 구간은 한 토큰으로 묶는다. `from:"Kim Min"` 형태도 지원한다. */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let cur = '';
  let phrase = false;
  let inQuote = false;
  const push = () => {
    if (cur.length > 0) tokens.push({ text: cur, phrase });
    cur = '';
    phrase = false;
  };
  for (const ch of input) {
    if (ch === '"') {
      if (inQuote) {
        inQuote = false;
      } else {
        if (cur.length === 0) phrase = true;
        inQuote = true;
      }
    } else if (!inQuote && /\s/u.test(ch)) {
      push();
    } else {
      cur += ch;
    }
  }
  push();
  return tokens;
}

/** YYYY-MM-DD 실제 달력 날짜만 허용한다. 형식 오류나 없는 날짜는 null. */
export function parseDateOnly(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

function pushUnique<T>(arr: T[], v: T) {
  if (!arr.includes(v) && arr.length < MAX_FILTER_VALUES) arr.push(v);
}

/**
 * 질의를 연산자와 키워드로 나눈다.
 * - 알 수 없는 연산자, 값이 빈 연산자, 형식이 틀린 날짜는 오류 없이 일반 키워드로 취급한다(문서화된 결정).
 * - before/after/on은 마지막 값이 이긴다.
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const filters: ParsedFilters = { from: [], in: [], has: [], is: [] };
  const terms: string[] = [];

  for (const tok of tokenize(nfc(raw).slice(0, MAX_QUERY_LENGTH))) {
    const text = tok.text;
    const idx = text.indexOf(':');
    if (!tok.phrase && idx > 0) {
      const key = text.slice(0, idx).toLowerCase();
      const value = text.slice(idx + 1);
      let consumed = false;
      if (value.length > 0) {
        switch (key) {
          case 'from': {
            const v = value.replace(/^@/, '');
            if (v) { pushUnique(filters.from, v); consumed = true; }
            break;
          }
          case 'in': {
            const v = value.replace(/^#/, '');
            if (v) { pushUnique(filters.in, v); consumed = true; }
            break;
          }
          case 'before':
          case 'after':
          case 'on':
            if (parseDateOnly(value)) { filters[key] = value; consumed = true; }
            break;
          case 'has': {
            const v = value.toLowerCase();
            if (HAS_VALUES.includes(v)) { pushUnique(filters.has, v as HasKind); consumed = true; }
            break;
          }
          case 'is': {
            const v = value.toLowerCase();
            if (IS_VALUES.includes(v)) { pushUnique(filters.is, v as IsKind); consumed = true; }
            break;
          }
        }
      }
      if (consumed) continue;
    }
    if (terms.length < MAX_TERMS) terms.push(text);
  }
  return { terms, filters };
}

/** 날짜 필터를 UTC 기준 [gte, lt) 구간으로 합친다. after:D는 D 다음 날 0시부터, before:D는 D 0시 전까지. */
export function dateRangeOf(f: Pick<ParsedFilters, 'before' | 'after' | 'on'>): DateRange {
  const range: DateRange = {};
  const day = 24 * 60 * 60 * 1000;
  const tighten = (key: 'gte' | 'lt', value: Date) => {
    const cur = range[key];
    if (!cur) range[key] = value;
    else range[key] = key === 'gte' ? (cur > value ? cur : value) : (cur < value ? cur : value);
  };
  const after = f.after ? parseDateOnly(f.after) : null;
  const before = f.before ? parseDateOnly(f.before) : null;
  const on = f.on ? parseDateOnly(f.on) : null;
  if (after) tighten('gte', new Date(after.getTime() + day));
  if (before) tighten('lt', before);
  if (on) {
    tighten('gte', on);
    tighten('lt', new Date(on.getTime() + day));
  }
  return range;
}

/** 본문에서 키워드가 일치한 구간 [start, end) 목록. 겹치면 합친다. 대소문자 무시, NFC/NFD 둘 다 본다. */
export function findHighlights(content: string, terms: string[], max = 50): Array<[number, number]> {
  if (!content || terms.length === 0) return [];
  const lower = content.toLowerCase();
  // toLowerCase로 길이가 달라지는 문자가 있으면 오프셋이 어긋나므로 원문 그대로 비교한다.
  const sameLength = lower.length === content.length;
  const hay = sameLength ? lower : content;
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    for (const v of termVariants(term)) {
      const needle = sameLength ? v.toLowerCase() : v;
      if (!needle) continue;
      let from = 0;
      while (ranges.length < max * 4) {
        const i = hay.indexOf(needle, from);
        if (i === -1) break;
        ranges.push([i, i + needle.length]);
        from = i + needle.length;
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged.slice(0, max);
}
