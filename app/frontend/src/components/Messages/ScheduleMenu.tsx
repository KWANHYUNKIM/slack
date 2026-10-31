import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/i18n/format';
import { Clock, Calendar } from 'lucide-react';

interface ScheduleMenuProps {
  onSchedule: (date: Date) => void;
  onCustom: () => void;
  isScheduling: boolean;
}

const SCHEDULE_PREVIEW: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

export function ScheduleMenu({ onSchedule, onCustom, isScheduling }: ScheduleMenuProps) {
  const { t } = useTranslation('messages');
  const getPresetOptions = useCallback(() => {
    const now = new Date();
    const opts: { label: string; date: Date }[] = [];

    const in20 = new Date(now.getTime() + 20 * 60 * 1000);
    opts.push({ label: t('schedule.in20'), date: in20 });

    const in1h = new Date(now.getTime() + 60 * 60 * 1000);
    opts.push({ label: t('schedule.in1h'), date: in1h });

    const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    opts.push({ label: t('schedule.in3h'), date: in3h });

    const tomorrow9am = new Date(now);
    tomorrow9am.setDate(tomorrow9am.getDate() + 1);
    tomorrow9am.setHours(9, 0, 0, 0);
    opts.push({ label: t('schedule.tomorrow9'), date: tomorrow9am });

    return opts;
  }, [t]);

  return (
    <div
      data-testid="schedule-menu"
      className="absolute bottom-full end-0 mb-1 w-56 rounded-lg border border-slack-border bg-white shadow-lg z-50 overflow-hidden"
    >
      <div className="px-3 py-2 text-[11px] font-semibold text-slack-secondary uppercase tracking-wider border-b border-slack-border-light">
        {t('schedule.menuTitle')}
      </div>
      {getPresetOptions().map((opt) => (
        <button
          key={opt.label}
          onClick={() => onSchedule(opt.date)}
          disabled={isScheduling}
          className="flex w-full items-center gap-2 px-3 py-2 text-start text-[13px] text-slack-primary hover:bg-slack-hover transition-colors"
        >
          <Clock className="h-3.5 w-3.5 text-slack-secondary flex-shrink-0" />
          <div>
            <div className="font-medium">{opt.label}</div>
            <div className="text-[11px] text-slack-secondary">
              {formatDateTime(opt.date, SCHEDULE_PREVIEW)}
            </div>
          </div>
        </button>
      ))}
      <div className="border-t border-slack-border-light">
        <button
          onClick={onCustom}
          className="flex w-full items-center gap-2 px-3 py-2 text-start text-[13px] text-slack-primary hover:bg-slack-hover transition-colors"
        >
          <Calendar className="h-3.5 w-3.5 text-slack-secondary flex-shrink-0" />
          <span className="font-medium">{t('schedule.custom')}</span>
        </button>
      </div>
    </div>
  );
}
