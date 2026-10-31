/**
 * emoji-mart UI 번역을 번들에서 읽는다.
 * Picker에 i18n을 직접 넘기면 emoji-mart가 jsdelivr CDN에서 받아 오지 않는다 (규칙 17).
 */
const emojiI18nFiles = import.meta.glob<{ default: Record<string, unknown> }>(
  '../../../node_modules/@emoji-mart/data/i18n/*.json',
);

/** 앱 로캘을 emoji-mart 로캘 코드로 바꾼다. 없으면 en. */
export function toEmojiMartLocale(locale: string): string {
  const base = locale.split('-')[0].toLowerCase();
  const candidates = [locale, base, locale === 'zh-Hant' ? 'zh' : base];
  for (const code of candidates) {
    if (emojiI18nFiles[`../../../node_modules/@emoji-mart/data/i18n/${code}.json`]) return code;
  }
  return 'en';
}

export async function loadEmojiMartI18n(locale: string): Promise<{
  locale: string;
  i18n: Record<string, unknown>;
}> {
  const code = toEmojiMartLocale(locale);
  const loader = emojiI18nFiles[`../../../node_modules/@emoji-mart/data/i18n/${code}.json`];
  const mod = await loader();
  return { locale: code, i18n: mod.default };
}
