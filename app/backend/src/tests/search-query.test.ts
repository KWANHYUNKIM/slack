import { parseSearchQuery, dateRangeOf, findHighlights, parseDateOnly, termVariants, MAX_TERMS } from '../utils/searchQuery.js';

// 파트 08: 검색 질의 파서 단위 테스트(순수 함수, DB 불필요)

describe('parseSearchQuery', () => {
  it('splits plain words into AND terms', () => {
    expect(parseSearchQuery('hello world').terms).toEqual(['hello', 'world']);
  });

  it('keeps a quoted phrase as one term', () => {
    expect(parseSearchQuery('"hello world" foo').terms).toEqual(['hello world', 'foo']);
  });

  it('parses from: with and without @', () => {
    expect(parseSearchQuery('from:@kim').filters.from).toEqual(['kim']);
    expect(parseSearchQuery('from:kim').filters.from).toEqual(['kim']);
  });

  it('parses quoted operator values with spaces', () => {
    const p = parseSearchQuery('from:"Kim Min" in:"#my channel" budget');
    expect(p.filters.from).toEqual(['Kim Min']);
    expect(p.filters.in).toEqual(['my channel']);
    expect(p.terms).toEqual(['budget']);
  });

  it('allows several in: values and removes duplicates', () => {
    const p = parseSearchQuery('in:#a in:#b in:#a');
    expect(p.filters.in).toEqual(['a', 'b']);
  });

  it('parses date operators', () => {
    const p = parseSearchQuery('before:2026-10-01 after:2026-09-01 on:2026-09-15');
    expect(p.filters).toMatchObject({ before: '2026-10-01', after: '2026-09-01', on: '2026-09-15' });
    expect(p.terms).toEqual([]);
  });

  it('treats malformed dates as plain words (documented: no error)', () => {
    expect(parseSearchQuery('before:yesterday').terms).toEqual(['before:yesterday']);
    expect(parseSearchQuery('after:2026-13-01').terms).toEqual(['after:2026-13-01']);
    expect(parseSearchQuery('on:2026-02-31').terms).toEqual(['on:2026-02-31']);
  });

  it('parses has: and is: and ignores case of the operator', () => {
    const p = parseSearchQuery('HAS:File has:link has:pin has:reaction is:thread is:saved');
    expect(p.filters.has).toEqual(['file', 'link', 'pin', 'reaction']);
    expect(p.filters.is).toEqual(['thread', 'saved']);
  });

  it('treats unknown operators and unknown values as plain words', () => {
    expect(parseSearchQuery('foo:bar').terms).toEqual(['foo:bar']);
    expect(parseSearchQuery('has:video').terms).toEqual(['has:video']);
    expect(parseSearchQuery('is:weird').terms).toEqual(['is:weird']);
  });

  it('treats an operator with an empty value as a plain word', () => {
    expect(parseSearchQuery('from:').terms).toEqual(['from:']);
    expect(parseSearchQuery('in:#').terms).toEqual(['in:#']);
  });

  it('does not interpret a quoted token as an operator', () => {
    const p = parseSearchQuery('"from:kim"');
    expect(p.filters.from).toEqual([]);
    expect(p.terms).toEqual(['from:kim']);
  });

  it('handles Korean words and operators', () => {
    const p = parseSearchQuery('from:@김민수 회의록 in:#일반');
    expect(p.filters.from).toEqual(['김민수']);
    expect(p.filters.in).toEqual(['일반']);
    expect(p.terms).toEqual(['회의록']);
  });

  it('normalizes the query to NFC', () => {
    const nfd = '한글'.normalize('NFD');
    expect(nfd).not.toBe('한글');
    expect(parseSearchQuery(nfd).terms).toEqual(['한글']);
  });

  it('returns empty result for blank input', () => {
    const p = parseSearchQuery('   ');
    expect(p.terms).toEqual([]);
    expect(p.filters.from).toEqual([]);
  });

  it('caps the number of terms', () => {
    const p = parseSearchQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '));
    expect(p.terms.length).toBe(MAX_TERMS);
  });

  it('tolerates an unterminated quote', () => {
    expect(parseSearchQuery('"abc def').terms).toEqual(['abc def']);
  });

  it('is fast on pathological input (no ReDoS)', () => {
    const start = Date.now();
    parseSearchQuery('a:'.repeat(100) + '"'.repeat(50));
    parseSearchQuery(' '.repeat(190) + 'x');
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('dateRangeOf', () => {
  it('after is exclusive of that day, before is exclusive too', () => {
    const r = dateRangeOf({ after: '2026-09-01', before: '2026-10-01' });
    expect(r.gte?.toISOString()).toBe('2026-09-02T00:00:00.000Z');
    expect(r.lt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('on covers exactly one UTC day', () => {
    const r = dateRangeOf({ on: '2026-09-15' });
    expect(r.gte?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(r.lt?.toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });

  it('parseDateOnly rejects impossible dates', () => {
    expect(parseDateOnly('2026-02-29')).toBeNull();
    expect(parseDateOnly('2028-02-29')).not.toBeNull();
  });
});

describe('findHighlights and termVariants', () => {
  it('finds case-insensitive matches and merges overlaps', () => {
    expect(findHighlights('Hello hello', ['hello'])).toEqual([[0, 5], [6, 11]]);
    expect(findHighlights('abcd', ['ab', 'bc'])).toEqual([[0, 3]]);
  });

  it('matches NFD stored content with an NFC term', () => {
    const content = '오늘 회의록'.normalize('NFD');
    const hl = findHighlights(content, ['회의록']);
    expect(hl.length).toBe(1);
    expect(content.slice(hl[0][0], hl[0][1])).toBe('회의록'.normalize('NFD'));
  });

  it('returns both forms for Hangul and one for ASCII', () => {
    expect(termVariants('한글').length).toBe(2);
    expect(termVariants('abc')).toEqual(['abc']);
  });
});
