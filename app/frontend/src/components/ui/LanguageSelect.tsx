import { useTranslation } from 'react-i18next';
import { SELECTABLE_LOCALES, changeLocale, isBetaLocale } from '@/lib/i18n';

/** 로캘 코드의 자기 언어 이름(ar → العربية). 못 구하면 코드를 그대로 쓴다. */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** 언어 선택. 각 언어 이름은 그 언어로 표기한다. */
export function LanguageSelect({ className }: { className?: string }) {
  const { t, i18n } = useTranslation('settings');
  const listed = SELECTABLE_LOCALES.some((l) => l.code === i18n.language);
  // 번역 파일이 없는 RTL 언어(ur 등)가 켜져 있으면 목록에 없다. 그 언어를 별도 항목으로 보여 줘야
  // 사용자가 en이나 ko를 골랐을 때 change가 발생하고 빠져나올 수 있다.
  const current = listed ? i18n.language : i18n.language || 'en';
  const pendingName = listed ? '' : languageName(i18n.language);
  const currentIsBeta = isBetaLocale(current);

  return (
    <label className={className}>
      <span className="block text-[13px] font-bold text-slack-text mb-1">
        {t('language.label')}
        {currentIsBeta && (
          <span
            data-testid="language-beta-badge"
            className="ms-2 rounded border border-slack-border px-1 text-[11px] font-normal text-slack-text"
          >
            {t('language.beta')}
          </span>
        )}
      </span>
      <select
        value={current}
        onChange={(e) => void changeLocale(e.target.value)}
        aria-label={t('language.label')}
        data-testid="language-select"
        className="w-full rounded border border-slack-border px-2 py-1.5 text-[14px] bg-white"
      >
        {!listed && (
          <option value={current} lang={current} data-testid="language-pending-option">
            {t('language.pending', { name: pendingName })}
          </option>
        )}
        {SELECTABLE_LOCALES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {isBetaLocale(l.code) ? t('language.betaOption', { name: l.name }) : l.name}
          </option>
        ))}
      </select>
    </label>
  );
}
