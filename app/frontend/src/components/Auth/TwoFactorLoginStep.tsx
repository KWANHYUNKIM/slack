import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/useAuthStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';

// 로그인 2단계(E7b): 인증 앱 6자리 코드 또는 복구 코드. mfaToken은 스토어 메모리에만 있고 5분 뒤 만료된다.
interface TwoFactorLoginStepProps {
  /** 대기가 만료되어 비밀번호 화면으로 돌아갈 때 부른다(그 화면에서 안내한다) */
  onExpired: () => void;
}

export function TwoFactorLoginStep({ onExpired }: TwoFactorLoginStepProps) {
  const { t } = useTranslation('auth');
  const { completeMfaLogin, cancelMfaLogin, isLoading } = useAuthStore();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await completeMfaLogin(code.trim());
      navigate('/');
    } catch (err) {
      // 대기가 끝났으면 스토어가 mfaToken을 지워 비밀번호 화면으로 돌아간다
      if (err instanceof ApiError && err.code === 'MFA_TOKEN_INVALID') {
        onExpired();
        return;
      }
      setCode('');
      setError(apiErrorMessage(err, 'auth:login.errors.generic'));
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" data-testid="mfa-login-step">
      <div className="text-center">
        <h2 className="text-xl font-bold text-slack-primary">{t('login.twoFactor.title')}</h2>
        <p className="mt-1 text-sm text-gray-600">{t('login.twoFactor.description')}</p>
      </div>
      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}
      <Input
        data-testid="mfa-login-code"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        aria-label={t('login.twoFactor.codeLabel')}
        placeholder={t('login.twoFactor.codePlaceholder')}
        autoComplete="one-time-code"
        autoFocus
        maxLength={32}
        dir="ltr"
        required
        className="h-11 text-center font-mono text-lg tracking-widest"
      />
      <p className="text-xs text-gray-500">{t('login.twoFactor.recoveryHint')}</p>
      <Button
        type="submit"
        disabled={isLoading || !code.trim()}
        className="h-11 w-full bg-slack-purple hover:bg-slack-sidebar text-white font-medium"
      >
        {isLoading ? t('login.twoFactor.submitting') : t('login.twoFactor.submit')}
      </Button>
      <button type="button" onClick={cancelMfaLogin} className="block w-full text-center text-sm text-slack-link hover:underline">
        {t('login.twoFactor.back')}
      </button>
    </form>
  );
}
