import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as api from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { useToastStore } from '@/stores/useToastStore';
import { RecoveryCodesPanel } from './RecoveryCodesPanel';

interface RecoveryCodesRegenerateProps {
  /** 새 코드를 저장했다고 확인한 뒤 부른다(남은 개수를 다시 불러오게) */
  onFinished: () => void;
}

// 복구 코드 다시 만들기(E7c): 비밀번호 + 인증 코드(또는 복구 코드)를 다시 확인하고, 새 10개를 한 번만 보여 준다.
// 기존 코드는 서버가 모두 무효로 만든다. 세션은 그대로라 토큰을 바꿀 필요가 없다.
export function RecoveryCodesRegenerate({ onFinished }: RecoveryCodesRegenerateProps) {
  const { t } = useTranslation('settings');
  const showToast = useToastStore((s) => s.show);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const reset = () => {
    setOpen(false);
    setPassword('');
    setCode('');
    setError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.regenerateRecoveryCodes(password, code.trim());
      setCodes(res.recoveryCodes);
      reset();
      showToast(t('twoFactor.regenerate.toast'));
    } catch (err) {
      setError(apiErrorMessage(err, 'settings:twoFactor.errors.regenerateFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return <RecoveryCodesPanel codes={codes} onDone={() => { setCodes(null); onFinished(); }} />;
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="mfa-regenerate-start"
        onClick={() => setOpen(true)}
        className="mb-3 rounded-md border border-slack-border px-4 py-2 text-[14px] font-medium text-slack-primary hover:bg-slack-hover"
      >
        {t('twoFactor.regenerate.start')}
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mb-3 space-y-3 rounded-md border border-slack-border p-3">
      <p className="text-[14px] font-bold text-slack-primary">{t('twoFactor.regenerate.title')}</p>
      <p className="text-[13px] text-slack-secondary">{t('twoFactor.regenerate.description')}</p>
      {error && <p role="alert" data-testid="mfa-regenerate-error" className="text-[13px] text-red-600">{error}</p>}
      <label className="block text-[13px] text-slack-secondary">
        {t('twoFactor.regenerate.passwordLabel')}
        <input
          type="password"
          data-testid="mfa-regenerate-password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slack-border px-2 py-1.5 text-[14px]"
        />
      </label>
      <label className="block text-[13px] text-slack-secondary">
        {t('twoFactor.regenerate.codeLabel')}
        <input
          data-testid="mfa-regenerate-code"
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
          data-testid="mfa-regenerate-submit"
          disabled={busy || !password || !code.trim()}
          className="rounded-md bg-slack-aubergine px-4 py-2 text-[14px] font-medium text-white disabled:opacity-50"
        >
          {busy ? t('twoFactor.regenerate.submitting') : t('twoFactor.regenerate.submit')}
        </button>
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-slack-border px-4 py-2 text-[14px] text-slack-primary hover:bg-slack-hover"
        >
          {t('twoFactor.regenerate.cancel')}
        </button>
      </div>
    </form>
  );
}
