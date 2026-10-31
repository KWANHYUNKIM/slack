// 퍼지 매칭(06 빠른 전환기). 순수 함수만 둔다(node:test로 검증: scripts/switcher.test.mjs).
// 글자가 연속이 아니어도 순서만 맞으면 일치하고, 앞쪽·단어 시작·연속 일치에 가중을 준다.
// 한국어 초성 검색은 범위 밖이다.

/** 비교용 정규화: 전각/호환 문자를 접고 소문자로 만든다(채널 이름 규칙과 같은 NFKC). */
export function normalizeForSearch(input: string): string {
  return input.normalize('NFKC').toLowerCase().trim();
}

const SEPARATORS = new Set([' ', '-', '_', '.', '/']);

/**
 * 점수가 높을수록 잘 맞는다. 일치하지 않으면 null.
 * 빈 검색어는 0점(모두 일치)으로 본다.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = normalizeForSearch(query);
  if (q.length === 0) return 0;
  const s = normalizeForSearch(text);
  if (s.length === 0) return null;

  // 1) 연속 부분 문자열: 앞쪽일수록, 이름이 짧을수록 높다
  const at = s.indexOf(q);
  if (at !== -1) {
    const wordStart = at === 0 || SEPARATORS.has(s[at - 1]);
    return 1000 - at * 10 + (at === 0 ? 200 : 0) + (wordStart ? 100 : 0) - (s.length - q.length);
  }

  // 2) 순서만 맞는 부분열: 왼쪽부터 탐욕적으로 맞추고 연속·단어 시작에 가점, 벌어진 간격에 감점
  const qChars = [...q];
  const sChars = [...s];
  let score = 400;
  let pos = 0;
  let prev = -2;
  for (const ch of qChars) {
    const idx = sChars.indexOf(ch, pos);
    if (idx === -1) return null;
    if (idx === prev + 1) score += 30;
    else score -= Math.min(idx - prev - 1, 20);
    if (idx === 0 || SEPARATORS.has(sChars[idx - 1])) score += 40;
    prev = idx;
    pos = idx + 1;
  }
  return score - (sChars.length - qChars.length);
}
