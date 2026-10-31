import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Smile } from 'lucide-react';
import { PortalEmojiPicker } from '@/components/ui/emoji-picker';
import { formatTime } from '@/lib/i18n/format';
import { useStatusStore, isStatusActive } from '@/stores/useStatusStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { expiryFor, type Duration } from '@/lib/statusExpiry';

const MAX_TEXT = 100;
const DURATIONS: Duration[] = ['never', 'm30', 'h1', 'h4', 'today', 'week'];

interface StatusDialogProps {
  onClose: () => void;
}

export function StatusDialog({ onClose }: StatusDialogProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const myId = useAuthStore((s) => s.user?.id);
  const current = useStatusStore((s) => (myId === undefined ? undefined : s.byUser[myId]?.customStatus));
  const now = useStatusStore((s) => s.now);
  const existing = isStatusActive(current, now) ? current : null;
  const saveStatus = useStatusStore((s) => s.saveStatus);
  const clearStatus = useStatusStore((s) => s.clearStatus);

  const [emoji, setEmoji] = useState<string | null>(existing?.emoji ?? null);
  const [text, setText] = useState(existing?.text ?? '');
  // 다시 열면 기존 만료를 그대로 유지한다. 바꾸고 싶을 때만 기간을 고른다.
  const [duration, setDuration] = useState<Duration | 'keep'>(existing?.expiresAt ? 'keep' : 'never');
  // 이미 상태에 묶인 방해금지가 있으면 체크된 채로 연다(서버는 본인 응답에만 withStatus를 준다)
  const [pause, setPause] = useState(useStatusStore.getState().myDnd.withStatus === true);
  const [showPicker, setShowPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = !busy && (!!emoji || text.trim().length > 0);

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveStatus({
        emoji,
        text: text.trim() || null,
        // 'keep'이면 expiresAt을 보내지 않아 서버가 기존 만료를 유지한다(과거·임박 시각 재전송으로 400이 나지 않게)
        ...(duration === 'keep' ? {} : { expiresAt: expiryFor(duration) }),
        pauseNotifications: pause,
      });
      onClose();
    } catch {
      setError(t('sidebar:statusDialog.saveError'));
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearStatus();
      onClose();
    } catch {
      setError(t('sidebar:statusDialog.saveError'));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('sidebar:statusDialog.title')}
        data-testid="status-dialog"
        className="w-[440px] max-w-[95vw] rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h3 className="mb-3 text-[17px] font-bold text-slack-primary">{t('sidebar:statusDialog.title')}</h3>

        <div className="relative mb-3 flex items-center gap-2 rounded-md border border-slack-border px-2 py-1.5">
          <button
            type="button"
            data-testid="status-emoji-button"
            aria-label={t('sidebar:statusDialog.emojiLabel')}
            className="flex h-8 w-8 items-center justify-center rounded text-[20px] hover:bg-slack-hover"
            onClick={() => setShowPicker((v) => !v)}
          >
            {emoji ?? <Smile className="h-5 w-5 text-slack-hint" />}
          </button>
          <input
            data-testid="status-text-input"
            aria-label={t('sidebar:statusDialog.textLabel')}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
            placeholder={t('sidebar:statusDialog.textPlaceholder')}
            maxLength={MAX_TEXT}
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          {showPicker && (
            <PortalEmojiPicker
              onEmojiSelect={(e) => { setEmoji(e.native); setShowPicker(false); }}
              onClickOutside={() => setShowPicker(false)}
            />
          )}
        </div>

        <label className="mb-3 block text-[13px] text-slack-secondary">
          {t('sidebar:statusDialog.durationLabel')}
          <select
            data-testid="status-duration-select"
            className="mt-1 block w-full rounded-md border border-slack-border bg-white px-2 py-1.5 text-[14px]"
            value={duration}
            onChange={(e) => setDuration(e.target.value as Duration | 'keep')}
          >
            {existing?.expiresAt && (
              <option value="keep">{t('sidebar:statusDialog.expiresAt', { time: formatTime(existing.expiresAt) })}</option>
            )}
            {DURATIONS.map((d) => (
              <option key={d} value={d}>{t(`sidebar:statusDialog.duration.${d}`)}</option>
            ))}
          </select>
        </label>

        <label className="mb-4 flex items-center gap-2 text-[13px] text-slack-secondary">
          <input
            data-testid="status-pause-checkbox"
            type="checkbox"
            checked={pause}
            onChange={(e) => setPause(e.target.checked)}
          />
          {t('sidebar:statusDialog.pauseCheckbox')}
        </label>

        {error && <p role="alert" className="mb-3 text-[13px] text-red-600">{error}</p>}

        <div className="flex items-center justify-between gap-2">
          {existing ? (
            <button
              type="button"
              data-testid="status-clear-button"
              disabled={busy}
              onClick={handleClear}
              className="text-[14px] font-medium text-slack-secondary hover:underline disabled:opacity-50"
            >
              {t('sidebar:statusDialog.clear')}
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slack-border px-4 py-2 text-[14px] font-medium text-slack-primary hover:bg-slack-hover"
            >
              {t('sidebar:statusDialog.cancel')}
            </button>
            <button
              type="button"
              data-testid="status-save-button"
              disabled={!canSave}
              onClick={handleSave}
              className="rounded-md bg-slack-aubergine px-4 py-2 text-[14px] font-medium text-white disabled:opacity-50"
            >
              {t('sidebar:statusDialog.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
