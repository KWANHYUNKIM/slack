import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SHORTCUTS, shortcutKeys, type ShortcutDef } from '@/lib/shortcuts';
import { useSwitcherStore } from '@/stores/useSwitcherStore';
import { isMacPlatform } from '@/hooks/useGlobalShortcuts';

const GROUPS: ShortcutDef['group'][] = ['navigation', 'general'];

/** `?`로 여는 단축키 도움말(06). 표의 내용은 lib/shortcuts.ts의 SHORTCUTS에서 온다. */
export function ShortcutsHelpModal() {
  const { t } = useTranslation('common');
  const open = useSwitcherStore((s) => s.helpOpen);
  const close = useSwitcherStore((s) => s.closeHelp);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      const el = returnFocusRef.current;
      if (el && document.contains(el)) el.focus();
    };
  }, [open]);

  if (!open) return null;
  const isMac = isMacPlatform();

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        data-testid="shortcuts-help"
        className="max-h-[80vh] w-full max-w-[520px] overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          } else if (e.key === 'Tab') {
            e.preventDefault(); // 포커스 가능한 요소가 닫기 버튼 하나뿐이다
            closeRef.current?.focus();
          }
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="shortcuts-title" className="text-[17px] font-bold text-slack-primary">{t('shortcuts.title')}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            aria-label={t('actions.close')}
            className="rounded-md border border-slack-border px-3 py-1 text-[13px] text-slack-primary hover:bg-slack-hover"
          >
            {t('actions.close')}
          </button>
        </div>
        {GROUPS.map((group) => (
          <table key={group} className="mb-4 w-full text-[14px]">
            <caption className="pb-1 text-start text-[12px] font-semibold text-slack-hint">{t(`shortcuts.groups.${group}`)}</caption>
            <tbody>
              {SHORTCUTS.filter((d) => d.group === group).map((d) => (
                <tr key={d.id} className="border-t border-slack-border-light">
                  <th scope="row" className="py-2 pe-3 text-start font-normal text-slack-primary">{t(d.labelKey)}</th>
                  <td className="py-2 text-end">
                    {shortcutKeys(d, isMac).map((k, i) => (
                      <kbd key={i} className="ms-1 rounded border border-slack-border bg-gray-50 px-1.5 py-0.5 font-sans text-[12px] text-slack-primary">
                        {k}
                      </kbd>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}
