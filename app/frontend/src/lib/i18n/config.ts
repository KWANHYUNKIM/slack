// i18next 초기 설정과 로캘 상수. 브라우저 API와 import.meta.glob을 쓰지 않아 node 테스트에서도 그대로 읽는다.
import type { InitOptions } from 'i18next';

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

/** 언어 선택 UI에 보이는 로캘. 이름은 항상 그 언어로 쓴다. 2등급(베타)은 isBetaLocale로 판단한다. */
export const SELECTABLE_LOCALES = [
  { code: 'ko', name: '한국어' },
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'zh-Hans', name: '简体中文' },
  { code: 'zh-Hant', name: '繁體中文' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'it', name: 'Italiano' },
  { code: 'ru', name: 'Русский' },
  { code: 'uk', name: 'Українська' },
  { code: 'pl', name: 'Polski' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'sv', name: 'Svenska' },
  { code: 'da', name: 'Dansk' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'fil', name: 'Filipino' },
] as const;

/**
 * i18next 초기 설정. 호출할 때마다 새 객체를 만든다(resources 객체를 i18next가 직접 고치므로 공유하지 않는다).
 * fallbackLng: 선택한 로캘에 키가 없으면 en으로 대체한다. 2등급 파일이 일부 빠져 있어도 화면이 깨지지 않는다.
 */
export function createI18nInitOptions(): InitOptions {
  return {
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: false,
    ns: [...NAMESPACES],
    defaultNS: 'common',
    resources: {},
    partialBundledLanguages: true,
    interpolation: { escapeValue: false },
    returnNull: false,
  };
}
