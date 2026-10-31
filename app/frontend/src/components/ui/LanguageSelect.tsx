import { useTranslation } from 'react-i18next';
import { SELECTABLE_LOCALES, changeLocale } from '@/lib/i18n';

/** 언어 선택. 각 언어 이름은 그 언어로 표기한다. */
export function LanguageSelect({ className }: { className?: string }) {
  const { t, i18n } = useTranslation('settings');
  const current = SELECTABLE_LOCALES.some((l) => l.code === i18n.language)
    ? i18n.language
    : 'en';

  return (
    <label className={className}>
      <span className="block text-[13px] font-bold text-slack-text mb-1">
        {t('language.label')}
      </span>
      <select
        value={current}
        onChange={(e) => void changeLocale(e.target.value)}
        aria-label={t('language.label')}
        data-testid="language-select"
        className="w-full rounded border border-slack-border px-2 py-1.5 text-[14px] bg-white"
      >
        {SELECTABLE_LOCALES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
