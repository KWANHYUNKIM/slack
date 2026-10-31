import i18n from 'i18next';
import ICU from 'i18next-icu';
import { pickLocale } from './pickLocale';
import { initReactI18next } from 'react-i18next';
import {
  FALLBACK_LOCALE,
  LOCALE_STORAGE_KEY,
  NAMESPACES,
  createI18nInitOptions,
} from './config';

export {
  FALLBACK_LOCALE,
  LOCALE_STORAGE_KEY,
  NAMESPACES,
  SELECTABLE_LOCALES,
  type Namespace,
} from './config';
export { isBetaLocale } from './tiers';

import { getDirection, RTL_LANGUAGES } from './direction';

export { getDirection };

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
  // 기본 언어 파일이 없으면 같은 언어의 지역 변형을 쓴다(pt, pt-PT → pt-BR)
  for (const code of availableLocales) {
    if (code.toLowerCase().startsWith(`${base}-`)) return code;
  }
  return null;
}

/**
 * matchLocale에 더해, 번역 파일이 아직 없는 RTL 언어(ar, he, fa, ur)는 기본 언어 코드를 그대로 쓴다.
 * 문자열은 en으로 대체되고, 방향(rtl)과 Intl 서식은 선택한 언어를 따른다(i18n-4).
 */
function resolveLocale(tag: string): string | null {
  const matched = matchLocale(tag);
  if (matched) return matched;
  const base = tag ? tag.split('-')[0].toLowerCase() : '';
  return RTL_LANGUAGES.has(base) ? base : null;
}

/** 사용자 설정(localStorage) → navigator.languages → en 순서로 로캘을 정한다. */
export function detectLocale(): string {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // localStorage를 못 쓰는 환경이면 다음 단계로 넘어간다
  }
  return pickLocale({
    stored,
    languages: navigator.languages ?? [],
    match: matchLocale,
    resolve: resolveLocale,
    fallback: FALLBACK_LOCALE,
  });
}

async function loadNamespaces(locale: string) {
  await Promise.all(
    NAMESPACES.map(async (ns) => {
      if (i18n.hasResourceBundle(locale, ns)) return;
      const loader = localeFiles[`../../locales/${locale}/${ns}.json`];
      if (!loader) return;
      try {
        const mod = await loader();
        i18n.addResourceBundle(locale, ns, mod.default, true, true);
      } catch (err) {
        // 청크를 못 받으면 해당 네임스페이스는 en으로 대체된다
        console.warn(`i18n: failed to load ${locale}/${ns}`, err);
      }
    }),
  );
}

function applyDocumentLocale(locale: string) {
  document.documentElement.lang = locale;
  document.documentElement.dir = getDirection(locale);
}

/** 로캘을 바꾼다. 번역 파일을 읽은 뒤 적용하고, 선택을 localStorage에 저장한다. */
let changeSeq = 0;

export async function changeLocale(locale: string) {
  const seq = ++changeSeq;
  const target = resolveLocale(locale) ?? FALLBACK_LOCALE;
  try {
    await loadNamespaces(target);
    // 더 늦게 요청된 변경이 있으면 이 요청은 버린다
    if (seq !== changeSeq) return;
    await i18n.changeLanguage(target);
    if (seq !== changeSeq) return;
  } catch (err) {
    console.warn('i18n: changeLocale failed', err);
    return;
  }
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
    try {
      await initInner();
    } catch (err) {
      // 초기화가 실패해도 en으로 대체해 앱은 뜨게 한다
      console.warn('i18n: init failed, falling back to en', err);
      try {
        await i18n.changeLanguage(FALLBACK_LOCALE);
      } catch {
        // 무시: 키가 그대로 보일 뿐 앱은 동작한다
      }
      applyDocumentLocale(FALLBACK_LOCALE);
    }
  })();
  return initPromise;
}

async function initInner() {
  {
    const locale = detectLocale();
    await i18n
      .use(ICU)
      .use(initReactI18next)
      .init({ ...createI18nInitOptions(), lng: locale });
    await Promise.all([loadNamespaces(FALLBACK_LOCALE), loadNamespaces(locale)]);
    // 번역을 읽은 뒤 이벤트를 다시 보내 구독 중인 컴포넌트가 새로 그리게 한다
    await i18n.changeLanguage(locale);
    applyDocumentLocale(locale);
    i18n.on('languageChanged', applyDocumentLocale);
  }
}

export const t = i18n.t.bind(i18n);

/** 번역 키(예: 'huddle:errors.micDenied')면 번역하고, 키가 아닌 문자열은 그대로 돌려준다. */
export function translateIfKey(value: string): string {
  return i18n.exists(value) ? i18n.t(value) : value;
}
export default i18n;
