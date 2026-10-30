import { useCallback } from 'react';
import { Clock, Calendar } from 'lucide-react';

interface ScheduleMenuProps {
  onSchedule: (date: Date) => void;
  onCustom: () => void;
  isScheduling: boolean;
}

export function ScheduleMenu({ onSchedule, onCustom, isScheduling }: ScheduleMenuProps) {
  const getPresetOptions = useCallback(() => {
    const now = new Date();
    const opts: { label: string; date: Date }[] = [];

    const in20 = new Date(now.getTime() + 20 * 60 * 1000);
    opts.push({ label: 'In 20 minutes', date: in20 });

    const in1h = new Date(now.getTime() + 60 * 60 * 1000);
    opts.push({ label: 'In 1 hour', date: in1h });

    const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    opts.push({ label: 'In 3 hours', date: in3h });

    const tomorrow9am = new Date(now);
    tomorrow9am.setDate(tomorrow9am.getDate() + 1);
    tomorrow9am.setHours(9, 0, 0, 0);
    opts.push({ label: 'Tomorrow at 9:00 AM', date: tomorrow9am });

    return opts;
  }, []);

  return (
    <div
      data-testid="schedule-menu"
      className="absolute bottom-full right-0 mb-1 w-56 rounded-lg border border-slack-border bg-white shadow-lg z-50 overflow-hidden"
    >
      <div className="px-3 py-2 text-[11px] font-semibold text-slack-secondary uppercase tracking-wider border-b border-slack-border-light">
        Schedule message
      </div>
      {getPresetOptions().map((opt) => (
        <button
          key={opt.label}
          onClick={() => onSchedule(opt.date)}
          disabled={isScheduling}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-slack-primary hover:bg-slack-hover transition-colors"
        >
          <Clock className="h-3.5 w-3.5 text-slack-secondary flex-shrink-0" />
          <div>
            <div className="font-medium">{opt.label}</div>
            <div className="text-[11px] text-slack-secondary">
              {opt.date.toLocaleString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </div>
          </div>
        </button>
      ))}
      <div className="border-t border-slack-border-light">
        <button
          onClick={onCustom}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-slack-primary hover:bg-slack-hover transition-colors"
        >
          <Calendar className="h-3.5 w-3.5 text-slack-secondary flex-shrink-0" />
          <span className="font-medium">Custom time...</span>
        </button>
      </div>
    </div>
  );
}
