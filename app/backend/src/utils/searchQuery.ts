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

export interface IgnoredToken {
  token: string;
  /** limit: 개수 상한 초과, short: 키워드가 2자 미만 */
  reason: 'limit' | 'short';
}

export interface ParsedQuery {
  /** 연산자를 뺀 키워드(AND). 따옴표 구문은 하나의 키워드다. NFC 정규화됨. 2자 미만 키워드는 들어 있지 않다 */
  terms: string[];
  filters: ParsedFilters;
  /** 무시된 토큰(상한 초과 연산자 값, 너무 짧은 키워드, 상한 초과 키워드) */
  ignored: IgnoredToken[];
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

/** 연산자 값 상한을 넘으면 버리지 않고 ignored에 남긴다(칩에 "초과로 무시됨" 표시용). */
function pushUnique<T>(arr: T[], v: T, ignored: IgnoredToken[], token: string) {
  if (arr.includes(v)) return;
  if (arr.length < MAX_FILTER_VALUES) arr.push(v);
  else ignored.push({ token, reason: 'limit' });
}

/** 키워드 한 글자(코드포인트 기준)는 검색어로 쓰지 않는다. */
export const MIN_TERM_LENGTH = 2;

/**
 * 질의를 연산자와 키워드로 나눈다.
 * - 알 수 없는 연산자, 값이 빈 연산자, 형식이 틀린 날짜는 오류 없이 일반 키워드로 취급한다(문서화된 결정).
 * - before/after/on은 마지막 값이 이긴다.
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const filters: ParsedFilters = { from: [], in: [], has: [], is: [] };
  const terms: string[] = [];
  const ignored: IgnoredToken[] = [];

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
            if (v) { pushUnique(filters.from, v, ignored, text); consumed = true; }
            break;
          }
          case 'in': {
            const v = value.replace(/^#/, '');
            if (v) { pushUnique(filters.in, v, ignored, text); consumed = true; }
            break;
          }
          case 'before':
          case 'after':
          case 'on':
            if (parseDateOnly(value)) { filters[key] = value; consumed = true; }
            break;
          case 'has': {
            const v = value.toLowerCase();
            if (HAS_VALUES.includes(v)) { pushUnique(filters.has, v as HasKind, ignored, text); consumed = true; }
            break;
          }
          case 'is': {
            const v = value.toLowerCase();
            if (IS_VALUES.includes(v)) { pushUnique(filters.is, v as IsKind, ignored, text); consumed = true; }
            break;
          }
        }
      }
      if (consumed) continue;
    }
    if ([...text].length < MIN_TERM_LENGTH) ignored.push({ token: text, reason: 'short' });
    else if (terms.length < MAX_TERMS) terms.push(text);
    else ignored.push({ token: text, reason: 'limit' });
  }
  return { terms, filters, ignored };
}

/**
 * 날짜 필터를 tz 기준 [gte, lt) 구간으로 합친다(tz가 잘못되면 UTC).
 * after:D는 D 다음 날 0시부터, before:D는 D 0시 전까지, on:D는 그날 하루.
 */
export function dateRangeOf(f: Pick<ParsedFilters, 'before' | 'after' | 'on'>, timeZone?: string): DateRange {
  const tz = resolveTimeZone(timeZone);
  const range: DateRange = {};
  const day = 24 * 60 * 60 * 1000;
  const tighten = (key: 'gte' | 'lt', value: Date) => {
    const cur = range[key];
    if (!cur) range[key] = value;
    else range[key] = key === 'gte' ? (cur > value ? cur : value) : (cur < value ? cur : value);
  };
  // 날짜 문자열의 달력 날짜에 dayShift일을 더한 날의 tz 0시
  const dayStart = (s: string, dayShift: number): Date | null => {
    const base = parseDateOnly(s);
    if (!base) return null;
    const shifted = new Date(base.getTime() + dayShift * day);
    return startOfZonedDay(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), tz);
  };
  const after = f.after ? dayStart(f.after, 1) : null;
  const before = f.before ? dayStart(f.before, 0) : null;
  const onStart = f.on ? dayStart(f.on, 0) : null;
  const onEnd = f.on ? dayStart(f.on, 1) : null;
  if (after) tighten('gte', after);
  if (before) tighten('lt', before);
  if (onStart && onEnd) { tighten('gte', onStart); tighten('lt', onEnd); }
  return range;
}

/** IANA 시간대 이름이 유효하면 그대로, 아니면(빈 값 포함) 'UTC'. */
export function resolveTimeZone(tz: string | undefined | null): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** 그 순간 tz의 UTC 오프셋(ms). 동쪽이 양수. */
function tzOffsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** tz 달력의 y-m-d 0시 0분에 해당하는 UTC 시각. 서머타임 경계는 오프셋을 한 번 더 보정해 맞춘다. */
export function startOfZonedDay(y: number, m: number, d: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(guess, tz);
  return new Date(guess - tzOffsetMs(first, tz));
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
