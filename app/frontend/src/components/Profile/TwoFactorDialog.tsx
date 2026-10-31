import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import * as api from '@/lib/api';
import type { MfaStatus } from '@/lib/api';
import { formatDateTime, DATE_TIME_MEDIUM } from '@/lib/i18n/format';
import { useToastStore } from '@/stores/useToastStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { TwoFactorSetup } from './TwoFactorSetup';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';
import { ReauthForm } from './ReauthForm';

// 남은 복구 코드가 이 수 이하이면 새로 만들라고 안내한다
const LOW_RECOVERY_CODES = 3;

interface TwoFactorDialogProps {
  onClose: () => void;
}

type Action = 'disable' | 'regenerate' | null;

// 2단계 인증 설정(E7b, E7c): 상태 보기, 등록(복구 코드 표시·다운로드), 복구 코드 다시 만들기, 해제(비밀번호 + 코드).
export function TwoFactorDialog({ onClose }: TwoFactorDialogProps) {
  const { t } = useTranslation('settings');
  const showToast = useToastStore((s) => s.show);
  const replaceSessionToken = useAuthStore((s) => s.replaceSessionToken);
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action>(null);
  // 새로 만든 복구 코드. 화면에 있는 동안은 저장했다고 확인할 때까지 다이얼로그를 닫지 못하게 한다(다시 볼 수 없으므로).
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  // 처음 켠 직후 복구 코드가 화면에 있는 동안도 같다
  const [setupCodesShown, setSetupCodesShown] = useState(false);
  const codesOnScreen = !!newCodes || setupCodesShown;

  const load = useCallback(async () => {
    try {
      setStatus(await api.getMfaStatus());
      setError(null);
    } catch {
      setError(t('twoFactor.errors.loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    // 처음 한 번 상태를 읽는다(이후 갱신은 load를 직접 부른다)
    api.getMfaStatus().then(setStatus).catch(() => setError(t('twoFactor.errors.loadFailed')));
  }, [t]);

  const handleDisable = async (password: string, code: string) => {
    const res = await api.disableMfa(password, code);
    // 끄면 이전 토큰이 모두 무효가 되므로 새 토큰으로 바꾼다
    replaceSessionToken(res.token);
    setAction(null);
    showToast(t('twoFactor.disabledToast'));
    await load();
  };

  const handleRegenerate = async (password: string, code: string) => {
    const res = await api.regenerateRecoveryCodes(password, code);
    setNewCodes(res.recoveryCodes);
    setAction(null);
    showToast(t('twoFactor.regenerate.toast'));
    // 남은 개수와 경고를 바로 갱신한다
    await load();
  };

  const handleClose = () => {
    if (codesOnScreen) return;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={handleClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('twoFactor.title')}
        data-testid="two-factor-dialog"
        className="flex max-h-[90vh] w-[560px] max-w-[95vw] flex-col overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') handleClose(); }}
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
            {newCodes ? (
              // 새 코드를 보는 동안에는 끄기·재발급 폼을 숨기고, 저장했다고 확인해야 닫을 수 있다
              <RecoveryCodesPanel codes={newCodes} onDone={() => setNewCodes(null)} />
            ) : (
              <>
                {status.recoveryCodesRemaining <= LOW_RECOVERY_CODES && (
                  <p data-testid="mfa-recovery-low" role="status" className="mb-3 text-[13px] text-amber-700">
                    {t('twoFactor.regenerate.lowNotice', { count: status.recoveryCodesRemaining })}
                  </p>
                )}
                {action === 'regenerate' ? (
                  <ReauthForm
                    testId="mfa-regenerate"
                    title={t('twoFactor.regenerate.title')}
                    description={t('twoFactor.regenerate.description')}
                    submitLabel={t('twoFactor.regenerate.submit')}
                    submittingLabel={t('twoFactor.regenerate.submitting')}
                    fallbackErrorKey="settings:twoFactor.errors.regenerateFailed"
                    onSubmit={handleRegenerate}
                    onCancel={() => setAction(null)}
                  />
                ) : action === 'disable' ? (
                  <ReauthForm
                    testId="mfa-disable"
                    title={t('twoFactor.disable.title')}
                    description={t('twoFactor.disable.description')}
                    submitLabel={t('twoFactor.disable.submit')}
                    submittingLabel={t('twoFactor.disable.submitting')}
                    fallbackErrorKey="settings:twoFactor.errors.disableFailed"
                    danger
                    onSubmit={handleDisable}
                    onCancel={() => setAction(null)}
                  />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      data-testid="mfa-regenerate-start"
                      onClick={() => setAction('regenerate')}
                      className="rounded-md border border-slack-border px-4 py-2 text-[14px] font-medium text-slack-primary hover:bg-slack-hover"
                    >
                      {t('twoFactor.regenerate.start')}
                    </button>
                    {status.required ? (
                      // 조직이 필수로 했으면 끌 수 없다(서버도 MFA_REQUIRED_BY_POLICY로 막는다)
                      <p data-testid="mfa-disable-blocked" className="w-full text-[13px] text-amber-700">{t('twoFactor.disable.blockedByPolicy')}</p>
                    ) : (
                      <button
                        type="button"
                        data-testid="mfa-disable-start"
                        onClick={() => setAction('disable')}
                        className="rounded-md border border-red-300 px-4 py-2 text-[14px] font-medium text-red-700 hover:bg-red-50"
                      >
                        {t('twoFactor.disable.start')}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : !status.available ? (
          <p className="text-[13px] text-amber-700">{t('twoFactor.unavailable')}</p>
        ) : (
          <>
            {status.required && <p className="mb-3 text-[13px] text-amber-700">{t('twoFactor.requiredNotice')}</p>}
            <TwoFactorSetup onFinished={() => void load()} onCodesShown={setSetupCodesShown} />
          </>
        )}

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={handleClose}
            disabled={codesOnScreen}
            className="rounded-md border border-slack-border px-4 py-2 text-[14px] font-medium text-slack-primary hover:bg-slack-hover disabled:opacity-50"
          >
            {t('twoFactor.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
