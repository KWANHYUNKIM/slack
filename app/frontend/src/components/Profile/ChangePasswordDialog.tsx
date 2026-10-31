import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import * as api from '@/lib/api';
import { ApiError } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { PASSWORD_MAX, changePasswordInputErrorKey, changePasswordFieldErrorKey } from '@/lib/authErrors';
import { useToastStore } from '@/stores/useToastStore';
import { useAuthStore } from '@/stores/useAuthStore';

interface ChangePasswordDialogProps {
  onClose: () => void;
}

const inputClass = 'mt-1 block w-full rounded-md border border-slack-border px-2 py-1.5 text-[14px]';

// 비밀번호 변경: 현재 비밀번호 + 새 비밀번호(가입과 같은 규칙) + 확인.
// 성공하면 다른 기기는 로그아웃되고 이전 토큰이 모두 무효라, 응답의 새 토큰으로 이 기기만 바꿔 로그인을 유지한다.
export function ChangePasswordDialog({ onClose }: ChangePasswordDialogProps) {
  const { t } = useTranslation(['settings', 'auth']);
  const showToast = useToastStore((s) => s.show);
  const replaceSessionToken = useAuthStore((s) => s.replaceSessionToken);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const inputKey = changePasswordInputErrorKey(current, next, confirm);
    if (inputKey) {
      setError(t(inputKey));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.changePassword(current, next);
      replaceSessionToken(res.token);
      showToast(t('settings:changePassword.successToast'));
      onClose();
    } catch (err) {
      const fieldKey = err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? changePasswordFieldErrorKey(err.fields) : null;
      setError(fieldKey ? t(fieldKey) : apiErrorMessage(err, 'settings:changePassword.errors.failed'));
      // 잠금(429)이어도 입력은 남겨 둔다. 틀린 현재 비밀번호만 비워 다시 입력하게 한다.
      if (err instanceof ApiError && err.code === 'AUTH_CURRENT_PASSWORD_INCORRECT') setCurrent('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('settings:changePassword.title')}
        data-testid="change-password-dialog"
        className="flex max-h-[90vh] w-[440px] max-w-[95vw] flex-col overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h3 className="mb-1 flex items-center gap-2 text-[17px] font-bold text-slack-primary">
          <Lock className="h-5 w-5" />
          {t('settings:changePassword.title')}
        </h3>
        <p className="mb-4 text-[13px] text-slack-secondary">{t('settings:changePassword.description')}</p>

        {error && <p role="alert" data-testid="change-password-error" className="mb-3 text-[13px] text-red-600">{error}</p>}

        <form onSubmit={handleSubmit} className="space-y-3">
          <label className="block text-[13px] text-slack-secondary">
            {t('settings:changePassword.currentLabel')}
            <input
              type="password"
              data-testid="change-password-current"
              autoComplete="current-password"
              maxLength={PASSWORD_MAX}
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-[13px] text-slack-secondary">
            {t('settings:changePassword.newLabel')}
            <input
              type="password"
              data-testid="change-password-new"
              autoComplete="new-password"
              maxLength={PASSWORD_MAX}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className={inputClass}
            />
            <span className="mt-1 block text-[12px] text-slack-hint">{t('auth:register.passwordHint')}</span>
          </label>
          <label className="block text-[13px] text-slack-secondary">
            {t('settings:changePassword.confirmLabel')}
            <input
              type="password"
              data-testid="change-password-confirm"
              autoComplete="new-password"
              maxLength={PASSWORD_MAX}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
            />
          </label>
          <p className="text-[12px] text-slack-secondary">{t('settings:changePassword.sessionsNote')}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slack-border px-4 py-2 text-[14px] text-slack-primary hover:bg-slack-hover"
            >
              {t('settings:changePassword.cancel')}
            </button>
            <button
              type="submit"
              data-testid="change-password-submit"
              disabled={busy || !current || !next || !confirm}
              className="rounded-md bg-slack-aubergine px-4 py-2 text-[14px] font-medium text-white disabled:opacity-50"
            >
              {busy ? t('settings:changePassword.submitting') : t('settings:changePassword.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
