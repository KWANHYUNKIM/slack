import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { PASSWORD_MAX, reauthFieldErrorKey } from '@/lib/authErrors';

interface ReauthFormProps {
  /** data-testid 접두어: `<접두어>-password`, `-code`, `-submit`, `-error` */
  testId: string;
  title: string;
  description: string;
  submitLabel: string;
  submittingLabel: string;
  /** 서버 오류에 구체 문구가 없을 때 쓰는 번역 키(`ns:key`) */
  fallbackErrorKey: string;
  /** 위험한 동작(끄기)이면 빨간 버튼 */
  danger?: boolean;
  /** 비밀번호와 코드를 받아 서버를 부른다. 실패하면 던진다(오류는 이 폼이 보여 준다). */
  onSubmit: (password: string, code: string) => Promise<void>;
  onCancel: () => void;
}

// 비밀번호 + 2단계 코드(인증 앱 또는 복구 코드) 재확인 폼. 2FA 끄기와 복구 코드 다시 만들기가 함께 쓴다.
export function ReauthForm({ testId, title, description, submitLabel, submittingLabel, fallbackErrorKey, danger, onSubmit, onCancel }: ReauthFormProps) {
  const { t } = useTranslation('settings');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password, code.trim());
    } catch (err) {
      const fieldKey = err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? reauthFieldErrorKey(err.fields) : null;
      setError(fieldKey ? t(fieldKey) : apiErrorMessage(err, fallbackErrorKey));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mb-3 space-y-3 rounded-md border border-slack-border p-3">
      <p className="text-[14px] font-bold text-slack-primary">{title}</p>
      <p className="text-[13px] text-slack-secondary">{description}</p>
      {error && <p role="alert" data-testid={`${testId}-error`} className="text-[13px] text-red-600">{error}</p>}
      <label className="block text-[13px] text-slack-secondary">
        {t('twoFactor.reauth.passwordLabel')}
        <input
          type="password"
          data-testid={`${testId}-password`}
          autoComplete="current-password"
          maxLength={PASSWORD_MAX}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 block w-full rounded-md border border-slack-border px-2 py-1.5 text-[14px]"
        />
      </label>
      <label className="block text-[13px] text-slack-secondary">
        {t('twoFactor.reauth.codeLabel')}
        <input
          data-testid={`${testId}-code`}
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
          data-testid={`${testId}-submit`}
          disabled={busy || !password || !code.trim()}
          className={`rounded-md px-4 py-2 text-[14px] font-medium text-white disabled:opacity-50 ${danger ? 'bg-red-600' : 'bg-slack-aubergine'}`}
        >
          {busy ? submittingLabel : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slack-border px-4 py-2 text-[14px] text-slack-primary hover:bg-slack-hover"
        >
          {t('twoFactor.reauth.cancel')}
        </button>
      </div>
    </form>
  );
}
