// 로캘 결정 순서(순수 함수, i18n-4). 브라우저·i18next 없이 테스트할 수 있게 index.ts에서 분리했다.
// 1) 사용자가 명시적으로 고른 값(stored)이면 번역 파일이 없는 RTL 언어여도 그대로 쓴다.
// 2) navigator.languages를 먼저 번역 파일이 있는 언어만 찾고, 못 찾으면 한 번 더 훑어 번역 없는 RTL 언어를 허용한다.
//    (['ar-EG', 'ko-KR']이면 ko. 번역이 있는 언어를 우선한다)
// 3) 그래도 없으면 fallback.

export interface PickLocaleInput {
  stored: string | null;
  languages: readonly string[];
  /** 번역 파일이 있는 로캘로만 맞춘다 */
  match: (tag: string) => string | null;
  /** match에 더해 번역 파일이 없는 RTL 언어도 허용한다 */
  resolve: (tag: string) => string | null;
  fallback: string;
}

export function pickLocale({ stored, languages, match, resolve, fallback }: PickLocaleInput): string {
  if (stored) {
    const chosen = resolve(stored);
    if (chosen) return chosen;
  }
  for (const tag of languages) {
    const matched = match(tag);
    if (matched) return matched;
  }
  for (const tag of languages) {
    const resolved = resolve(tag);
    if (resolved) return resolved;
  }
  return fallback;
}
