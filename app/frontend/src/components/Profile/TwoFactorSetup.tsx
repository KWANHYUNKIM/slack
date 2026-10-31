import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import * as api from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { useToastStore } from '@/stores/useToastStore';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';

interface TwoFactorSetupProps {
  /** 복구 코드를 저장했다고 확인한 뒤 부른다 */
  onFinished: () => void;
  onCancel?: () => void;
}

// 2FA 등록(E7b): 비밀 만들기 → 인증 앱에 추가(링크 또는 키) → 코드 확인 → 복구 코드 한 번 보여 주기.
// QR 그림은 그리지 않는다. 외부 QR 서비스는 쓰지 않고(규칙 17), QR 라이브러리도 아직 없어서 링크와 키만 보여 준다.
export function TwoFactorSetup({ onFinished, onCancel }: TwoFactorSetupProps) {
  const { t } = useTranslation('settings');
  const showToast = useToastStore((s) => s.show);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.setupMfa());
    } catch (err) {
      setError(apiErrorMessage(err, 'settings:twoFactor.errors.setupFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.enableMfa(password, code.trim());
      setSetup(null);
      setCode('');
      setPassword('');
      setRecoveryCodes(res.recoveryCodes);
      showToast(t('twoFactor.enabledToast'));
    } catch (err) {
      setError(apiErrorMessage(err, 'settings:twoFactor.errors.enableFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('twoFactor.setup.copied'));
    } catch {
      setError(t('twoFactor.errors.copyFailed'));
    }
  };

  if (recoveryCodes) {
    return <RecoveryCodesPanel codes={recoveryCodes} onDone={onFinished} />;
  }

  // 키는 4글자씩 끊어 보여 준다(손으로 옮겨 적기 쉽게)
  const groupedKey = setup ? setup.secret.match(/.{1,4}/g)!.join(' ') : '';

  return (
    <div data-testid="mfa-setup">
      {error && <p role="alert" className="mb-3 text-[13px] text-red-600">{error}</p>}
      {!setup ? (
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="mfa-setup-start"
            disabled={busy}
            onClick={handleStart}
            className="rounded-md bg-slack-aubergine px-4 py-2 text-[14px] font-medium text-white disabled:opacity-50"
          >
            {busy ? t('twoFactor.setup.starting') : t('twoFactor.setup.start')}
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel} className="rounded-md border border-slack-border px-4 py-2 text-[14px] text-slack-primary hover:bg-slack-hover">
              {t('twoFactor.setup.cancel')}
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={handleVerify} className="space-y-3">
          <p className="text-[13px] text-slack-primary">{t('twoFactor.setup.step1')}</p>
          <div className="rounded-md border border-slack-border p-3">
            <p className="mb-1 text-[12px] text-slack-secondary">{t('twoFactor.setup.keyLabel')}</p>
            <div className="flex items-center gap-2">
              <code data-testid="mfa-setup-key" dir="ltr" className="min-w-0 flex-1 break-all font-mono text-[14px] tracking-wider">{groupedKey}</code>
              <button
                type="button"
                aria-label={t('twoFactor.setup.copyKey')}
                title={t('twoFactor.setup.copyKey')}
                onClick={() => handleCopy(setup.secret)}
                className="rounded p-1.5 text-slack-secondary hover:bg-slack-hover"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-1 mt-3 text-[12px] text-slack-secondary">{t('twoFactor.setup.uriLabel')}</p>
            <div className="flex items-center gap-2">
              <a
                href={setup.otpauthUri}
                data-testid="mfa-setup-uri"
                className="min-w-0 flex-1 truncate text-[13px] text-slack-link hover:underline"
              >
                {t('twoFactor.setup.openInApp')}
              </a>
              <button
                type="button"
                aria-label={t('twoFactor.setup.copyUri')}
                title={t('twoFactor.setup.copyUri')}
                onClick={() => handleCopy(setup.otpauthUri)}
                className="rounded p-1.5 text-slack-secondary hover:bg-slack-hover"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>
          <label className="block text-[13px] text-slack-primary">
            {t('twoFactor.setup.step2')}
            <input
              data-testid="mfa-setup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              dir="ltr"
              aria-label={t('twoFactor.setup.codeLabel')}
              placeholder={t('twoFactor.setup.codePlaceholder')}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="mt-1 block w-40 rounded-md border border-slack-border px-2 py-1.5 font-mono text-[16px] tracking-widest"
            />
          </label>
          <label className="block text-[13px] text-slack-primary">
            {t('twoFactor.setup.passwordLabel')}
            <input
              type="password"
              data-testid="mfa-setup-password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full max-w-xs rounded-md border border-slack-border px-2 py-1.5 text-[14px]"
            />
          </label>
          <p className="text-[12px] text-slack-secondary">{t('twoFactor.setup.sessionsNote')}</p>
          <div className="flex gap-2">
            <button
              type="submit"
              data-testid="mfa-setup-verify"
              disabled={busy || code.length !== 6 || !password}
              className="rounded-md bg-slack-aubergine px-4 py-2 text-[14px] font-medium text-white disabled:opacity-50"
            >
              {busy ? t('twoFactor.setup.verifying') : t('twoFactor.setup.verify')}
            </button>
            <button
              type="button"
              onClick={() => { setSetup(null); setCode(''); setPassword(''); setError(null); onCancel?.(); }}
              className="rounded-md border border-slack-border px-4 py-2 text-[14px] text-slack-primary hover:bg-slack-hover"
            >
              {t('twoFactor.setup.cancel')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
