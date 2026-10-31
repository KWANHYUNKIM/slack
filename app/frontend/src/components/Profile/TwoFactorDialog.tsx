import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import * as api from '@/lib/api';
import type { MfaStatus } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { formatDateTime, DATE_TIME_MEDIUM } from '@/lib/i18n/format';
import { useToastStore } from '@/stores/useToastStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { TwoFactorSetup } from './TwoFactorSetup';

interface TwoFactorDialogProps {
  onClose: () => void;
}

// 2단계 인증 설정(E7b): 상태 보기, 등록(복구 코드 표시·다운로드), 해제(비밀번호 + 코드).
export function TwoFactorDialog({ onClose }: TwoFactorDialogProps) {
  const { t } = useTranslation('settings');
  const showToast = useToastStore((s) => s.show);
  const replaceSessionToken = useAuthStore((s) => s.replaceSessionToken);
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.getMfaStatus());
      setError(null);
    } catch {
      setError(t('twoFactor.errors.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.disableMfa(password, code.trim());
      // 끄면 이전 토큰이 모두 무효가 되므로 새 토큰으로 바꾼다
      replaceSessionToken(res.token);
      setDisabling(false);
      setPassword('');
      setCode('');
      showToast(t('twoFactor.disabledToast'));
      await load();
    } catch (err) {
      setError(apiErrorMessage(err, 'settings:twoFactor.errors.disableFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('twoFactor.title')}
        data-testid="two-factor-dialog"
        className="flex max-h-[90vh] w-[560px] max-w-[95vw] flex-col overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h3 className="mb-1 flex items-center gap-2 text-[17px] font-bold text-slack-primary">
          <ShieldCheck className="h-5 w-5" />
          {t('twoFactor.title')}
          {status && (
            <span
              data-testid="mfa-status"
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${status.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}
            >
              {status.enabled ? t('twoFactor.statusOn') : t('twoFactor.statusOff')}
            </span>
          )}
        </h3>
        <p className="mb-4 text-[13px] text-slack-secondary">{t('twoFactor.description')}</p>

        {error && <p role="alert" className="mb-3 text-[13px] text-red-600">{error}</p>}

        {!status ? (
          !error && <p className="text-[13px] text-slack-hint">{t('twoFactor.loading')}</p>
        ) : status.enabled ? (
          <div>
            <p className="text-[13px] text-slack-primary">
              {status.enabledAt && t('twoFactor.enabledSince', { date: formatDateTime(status.enabledAt, DATE_TIME_MEDIUM) })}
            </p>
            <p data-testid="mfa-recovery-remaining" className="mb-3 text-[13px] text-slack-secondary">
              {t('twoFactor.recoveryRemaining', { count: status.recoveryCodesRemaining })}
            </p>
            {status.required ? (
              // 조직이 필수로 했으면 끌 수 없다(서버도 MFA_REQUIRED_BY_POLICY로 막는다)
              <p data-testid="mfa-disable-blocked" className="text-[13px] text-amber-700">{t('twoFactor.disable.blockedByPolicy')}</p>
            ) : !disabling ? (
              <button
                type="button"
                data-testid="mfa-disable-start"
                onClick={() => setDisabling(true)}
                className="rounded-md border border-red-300 px-4 py-2 text-[14px] font-medium text-red-700 hover:bg-red-50"
              >
                {t('twoFactor.disable.start')}
              </button>
            ) : (
              <form onSubmit={handleDisable} className="space-y-3 rounded-md border border-slack-border p-3">
                <p className="text-[14px] font-bold text-slack-primary">{t('twoFactor.disable.title')}</p>
                <p className="text-[13px] text-slack-secondary">{t('twoFactor.disable.description')}</p>
                <label className="block text-[13px] text-slack-secondary">
                  {t('twoFactor.disable.passwordLabel')}
                  <input
                    type="password"
                    data-testid="mfa-disable-password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-slack-border px-2 py-1.5 text-[14px]"
                  />
                </label>
                <label className="block text-[13px] text-slack-secondary">
                  {t('twoFactor.disable.codeLabel')}
                  <input
                    data-testid="mfa-disable-code"
                    autoComplete="one-time-code"
                    maxLength={32}
                    dir="ltr"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="mt-1 block w-full rounded-md border border-slack-border px-2 py-1.5 font-mono text-[14px]"
                  />
                </label>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    data-testid="mfa-disable-submit"
                    disabled={busy || !password || !code.trim()}
                    className="rounded-md bg-red-600 px-4 py-2 text-[14px] font-medium text-white disabled:opacity-50"
                  >
                    {busy ? t('twoFactor.disable.submitting') : t('twoFactor.disable.submit')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDisabling(false); setError(null); }}
                    className="rounded-md border border-slack-border px-4 py-2 text-[14px] text-slack-primary hover:bg-slack-hover"
                  >
                    {t('twoFactor.disable.cancel')}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : !status.available ? (
          <p className="text-[13px] text-amber-700">{t('twoFactor.unavailable')}</p>
        ) : (
          <>
            {status.required && <p className="mb-3 text-[13px] text-amber-700">{t('twoFactor.requiredNotice')}</p>}
            <TwoFactorSetup onFinished={() => void load()} />
          </>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slack-border px-4 py-2 text-[14px] font-medium text-slack-primary hover:bg-slack-hover"
          >
            {t('twoFactor.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
