import { useEffect } from 'react';
import { AlarmClock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useReminderStore } from '@/stores/useReminderStore';

const TOAST_MS = 6000;

/** 리마인더를 만들었을 때, 시각이 되었을 때 잠깐 뜨는 안내. AppLayout에 한 번만 둔다. */
export function ReminderToast() {
  const { t } = useTranslation('messages');
  const toast = useReminderStore((s) => s.toast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => useReminderStore.getState().dismissToast(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;
  return (
    <div
      role="status"
      data-testid="reminder-toast"
      className="fixed bottom-4 start-1/2 z-[10000] flex max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-lg bg-slack-primary px-4 py-2 text-[13px] text-white shadow-lg rtl:translate-x-1/2"
    >
      <AlarmClock className="h-4 w-4 flex-shrink-0" />
      <span className="min-w-0 break-words">{t(`reminder.toast.${toast.key}`, { text: toast.text ?? '' })}</span>
      <button onClick={() => useReminderStore.getState().dismissToast()} aria-label={t('reminder.dismiss')}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
