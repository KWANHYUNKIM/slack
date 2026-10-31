// 언어 등급 (docs/architecture/i18n.md 3절)
// 1등급: 사람이 검수한 번역. 누락 키가 있으면 CI 실패.
// 2등급: 기계 번역 초안. 언어 설정에 "베타"를 표시하고, 누락 키는 경고만 하며 영어로 대체한다.
// 3등급: 번역 파일이 없는 로캘. 영어로 대체한다.

export const TIER1_LOCALES = ['en', 'ko'] as const;
// 2등급 31개 전부 번역 파일이 있다(i18n-5i 완료). 아직 파일이 없는 RTL(ur)만 영어로 대체된다.

/** 2등급 31개 (i18n.md 3절 표 순서). 번역 파일은 이 중 일부만 있을 수 있다. */
export const TIER2_LOCALES = [
  'ja',
  'zh-Hans',
  'zh-Hant',
  'es',
  'fr',
  'de',
  'pt-BR',
  'it',
  'ru',
  'uk',
  'pl',
  'nl',
  'tr',
  'ar',
  'he',
  'fa',
  'hi',
  'bn',
  'th',
  'vi',
  'id',
  'ms',
  'fil',
  'sv',
  'da',
  'nb',
  'fi',
  'cs',
  'el',
  'hu',
  'ro',
] as const;

export function isTier1Locale(code: string): boolean {
  return (TIER1_LOCALES as readonly string[]).includes(code);
}

/** 언어 설정에 "베타"를 붙일 로캘인지 (2등급) */
export function isBetaLocale(code: string): boolean {
  return (TIER2_LOCALES as readonly string[]).includes(code);
}
