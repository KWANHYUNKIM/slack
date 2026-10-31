import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Moon, MoonStar, Smile } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatTime } from '@/lib/i18n/format';
import { useAuthStore } from '@/stores/useAuthStore';
import { useStatusStore, useCustomStatus, isDndActive } from '@/stores/useStatusStore';
import { StatusDialog } from './StatusDialog';

interface UserMenuStatusProps {
  /** 항목을 눌러 메뉴를 닫을 때 부른다 */
  onDone: () => void;
}

/** 아바타 메뉴 안의 상태 입력칸과 알림 일시 중지 하위 메뉴 */
export function UserMenuStatus({ onDone }: UserMenuStatusProps) {
  const { t } = useTranslation('sidebar');
  const myId = useAuthStore((s) => s.user?.id);
  const status = useCustomStatus(myId);
  const myDnd = useStatusStore((s) => s.myDnd);
  const now = useStatusStore((s) => s.now);
  const pauseNotifications = useStatusStore((s) => s.pauseNotifications);
  const resumeNotifications = useStatusStore((s) => s.resumeNotifications);
  const [showDialog, setShowDialog] = useState(false);
  const [showPause, setShowPause] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dndOn = isDndActive(myDnd, now);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
      setShowPause(false);
      onDone();
    } catch {
      setError(t('userMenu.pauseError'));
    }
  };

  const untilTomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };

  const options: Array<{ key: string; input: { minutes?: number; until?: string } }> = [
    { key: 'm30', input: { minutes: 30 } },
    { key: 'h1', input: { minutes: 60 } },
    { key: 'h2', input: { minutes: 120 } },
    { key: 'tomorrow', input: { until: untilTomorrow() } },
  ];

  return (
    <>
      <Button
        variant="menu-item"
        data-testid="status-open-button"
        onClick={() => setShowDialog(true)}
      >
        {status?.emoji ? <span className="w-4 text-center">{status.emoji}</span> : <Smile className="h-4 w-4" />}
        <span className="truncate">{status?.text || t('userMenu.updateStatus')}</span>
      </Button>

      {dndOn ? (
        <Button
          variant="menu-item"
          data-testid="dnd-resume-button"
          onClick={() => run(resumeNotifications)}
        >
          <MoonStar className="h-4 w-4" />
          <span className="flex flex-col items-start">
            <span>{t('userMenu.resumeNotifications')}</span>
            <span className="text-[11px] text-slack-hint">
              {myDnd.until ? t('userMenu.pausedUntil', { time: formatTime(myDnd.until) }) : t('userMenu.pausedIndefinitely')}
            </span>
          </span>
        </Button>
      ) : (
        <>
          <Button
            variant="menu-item"
            data-testid="dnd-open-button"
            aria-expanded={showPause}
            onClick={() => setShowPause((v) => !v)}
          >
            <Moon className="h-4 w-4" />
            {t('userMenu.pauseNotifications')}
          </Button>
          {showPause && (
            <div className="ps-6" data-testid="dnd-options">
              {options.map((o) => (
                <Button
                  key={o.key}
                  variant="menu-item"
                  data-testid={`dnd-option-${o.key}`}
                  onClick={() => run(() => pauseNotifications(o.input))}
                >
                  {t(`userMenu.pause.${o.key}`)}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className="px-4 py-1 text-[12px] text-red-600">{error}</p>}

      {showDialog && (
        <StatusDialog
          onClose={() => {
            setShowDialog(false);
            onDone();
          }}
        />
      )}
    </>
  );
}
