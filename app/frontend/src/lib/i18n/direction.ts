// 글 방향 결정(순수 함수, i18n-4/i18n-5i). index.ts에서 분리해 node 테스트에서 바로 읽는다.
// 번역 파일이 없는 RTL 언어(ur)도 방향은 rtl이다. 문자열만 영어로 대체된다.

/** 오른쪽에서 왼쪽으로 쓰는 언어 */
export const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

export function getDirection(locale: string): 'ltr' | 'rtl' {
  return RTL_LANGUAGES.has(locale.split('-')[0].toLowerCase()) ? 'rtl' : 'ltr';
}
