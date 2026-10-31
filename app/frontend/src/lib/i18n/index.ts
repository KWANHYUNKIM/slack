import i18n from 'i18next';
import ICU from 'i18next-icu';
import { initReactI18next } from 'react-i18next';

/** 네임스페이스 목록 (docs/conventions/i18n.md 1절) */
export const NAMESPACES = [
  'common',
  'auth',
  'sidebar',
  'messages',
  'channels',
  'activity',
  'admin',
  'settings',
  'huddle',
  'errors',
  'desktop',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const LOCALE_STORAGE_KEY = 'locale';
export const FALLBACK_LOCALE = 'en';

/** 언어 선택 UI에 보이는 로캘. 이름은 항상 그 언어로 쓴다. 2등급 언어는 i18n-5에서 추가한다. */
export const SELECTABLE_LOCALES = [
  { code: 'ko', name: '한국어' },
  { code: 'en', name: 'English' },
] as const;

/** 오른쪽에서 왼쪽으로 쓰는 언어 */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

export function getDirection(locale: string): 'ltr' | 'rtl' {
  return RTL_LANGUAGES.has(locale.split('-')[0].toLowerCase()) ? 'rtl' : 'ltr';
}

// 번역 JSON은 번들에 포함하고 로캘별로 지연 로딩한다 (외부 CDN 금지, 규칙 17)
const localeFiles = import.meta.glob<{ default: Record<string, unknown> }>('../../locales/*/*.json');

/** 번역 파일이 있는 로캘 목록 */
const availableLocales = new Set(
  Object.keys(localeFiles).map((path) => path.split('/').slice(-2)[0]),
);

/** 'ko-KR' 같은 태그를 번역 파일이 있는 가장 가까운 로캘로 바꾼다. 없으면 null. */
export function matchLocale(tag: string): string | null {
  if (!tag) return null;
  if (availableLocales.has(tag)) return tag;
  const lower = tag.toLowerCase();
  for (const code of availableLocales) {
    if (code.toLowerCase() === lower) return code;
  }
  const base = lower.split('-')[0];
  // zh-TW, zh-HK는 번체, 그 밖의 zh는 간체
  if (base === 'zh') {
    const traditional = /-(tw|hk|mo|hant)/.test(lower);
    const code = traditional ? 'zh-Hant' : 'zh-Hans';
    return availableLocales.has(code) ? code : null;
  }
  for (const code of availableLocales) {
    if (code.toLowerCase() === base) return code;
  }
  return null;
}

/** 사용자 설정(localStorage) → navigator.languages → en 순서로 로캘을 정한다. */
export function detectLocale(): string {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    const matched = stored ? matchLocale(stored) : null;
    if (matched) return matched;
  } catch {
    // localStorage를 못 쓰는 환경이면 다음 단계로 넘어간다
  }
  for (const tag of navigator.languages ?? []) {
    const matched = matchLocale(tag);
    if (matched) return matched;
  }
  return FALLBACK_LOCALE;
}

async function loadNamespaces(locale: string) {
  await Promise.all(
    NAMESPACES.map(async (ns) => {
      if (i18n.hasResourceBundle(locale, ns)) return;
      const loader = localeFiles[`../../locales/${locale}/${ns}.json`];
      if (!loader) return;
      const mod = await loader();
      i18n.addResourceBundle(locale, ns, mod.default, true, true);
    }),
  );
}

function applyDocumentLocale(locale: string) {
  document.documentElement.lang = locale;
  document.documentElement.dir = getDirection(locale);
}

/** 로캘을 바꾼다. 번역 파일을 읽은 뒤 적용하고, 선택을 localStorage에 저장한다. */
export async function changeLocale(locale: string) {
  const target = matchLocale(locale) ?? FALLBACK_LOCALE;
  await loadNamespaces(target);
  await i18n.changeLanguage(target);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, target);
  } catch {
    // 저장 실패는 무시한다 (이번 세션에서만 적용)
  }
}

let initPromise: Promise<void> | null = null;

/** 앱 시작 전에 한 번 호출한다. */
export function initI18n(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const locale = detectLocale();
    await i18n
      .use(ICU)
      .use(initReactI18next)
      .init({
        lng: locale,
        fallbackLng: FALLBACK_LOCALE,
        supportedLngs: false,
        ns: [...NAMESPACES],
        defaultNS: 'common',
        resources: {},
        partialBundledLanguages: true,
        interpolation: { escapeValue: false },
        returnNull: false,
      });
    await Promise.all([loadNamespaces(FALLBACK_LOCALE), loadNamespaces(locale)]);
    // 번역을 읽은 뒤 이벤트를 다시 보내 구독 중인 컴포넌트가 새로 그리게 한다
    await i18n.changeLanguage(locale);
    applyDocumentLocale(locale);
    i18n.on('languageChanged', applyDocumentLocale);
  })();
  return initPromise;
}

export const t = i18n.t.bind(i18n);
export default i18n;
