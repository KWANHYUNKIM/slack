import { useMemo, useState } from 'react';
import { Clock, Calendar } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/i18n/format';
import { parseLocalDateTime, reminderPresets } from '@/lib/remind';

interface ReminderMenuProps {
  onPick: (remindAt: Date) => void;
}

const PREVIEW: Intl.DateTimeFormatOptions = { weekday: 'short', hour: 'numeric', minute: '2-digit' };

/** 시간 선택 목록: 20분 / 1시간 / 3시간 / 내일 / 다음 주 / 사용자 지정. 메시지 더 보기 메뉴 안에 펼쳐진다. */
export function ReminderMenu({ onPick }: ReminderMenuProps) {
  const { t } = useTranslation('messages');
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState('');
  const presets = useMemo(() => reminderPresets(), []);
  const customDate = parseLocalDateTime(custom);

  return (
    <div data-testid="reminder-menu" className="border-t border-slack-border-light py-1">
      {presets.map((p) => (
        <button
          key={p.key}
          data-testid={`reminder-preset-${p.key}`}
          onClick={() => onPick(p.date)}
          className="flex w-full items-center gap-2 px-4 py-1.5 text-start text-[13px] text-slack-primary hover:bg-slack-hover"
        >
          <Clock className="h-3.5 w-3.5 flex-shrink-0 text-slack-secondary" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{t(`reminder.preset.${p.key}`)}</span>
            <span className="block text-[11px] text-slack-secondary">{formatDateTime(p.date, PREVIEW)}</span>
          </span>
        </button>
      ))}
      <button
        data-testid="reminder-custom-toggle"
        onClick={() => setShowCustom((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-1.5 text-start text-[13px] font-medium text-slack-primary hover:bg-slack-hover"
      >
        <Calendar className="h-3.5 w-3.5 flex-shrink-0 text-slack-secondary" />
        {t('reminder.preset.custom')}
      </button>
      {showCustom && (
        <div className="space-y-1 px-4 pb-2">
          <input
            data-testid="reminder-custom-input"
            type="datetime-local"
            aria-label={t('reminder.customLabel')}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            className="w-full rounded border border-slack-border px-2 py-1 text-[12px]"
          />
          <button
            data-testid="reminder-custom-submit"
            disabled={customDate === null}
            onClick={() => customDate && customDate.getTime() > Date.now() && onPick(customDate)}
            className="w-full rounded bg-slack-btn px-2 py-1 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('reminder.set')}
          </button>
        </div>
      )}
    </div>
  );
}
