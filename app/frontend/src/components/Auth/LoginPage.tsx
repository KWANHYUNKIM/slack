import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { LanguageSelect } from '@/components/ui/LanguageSelect';
import { useAuthStore } from '@/stores/useAuthStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { peekOAuthReturn } from '@/lib/oauthReturn';
import { loginFieldErrorKey } from '@/lib/authErrors';
import { SESSION_ENDED_FLAG } from '@/lib/socket';
import { TwoFactorLoginStep } from './TwoFactorLoginStep';

export function LoginPage() {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // 다른 기기에서 로그아웃되었거나 세션이 끝나 이 화면으로 왔으면 한 번만 안내한다
  const [sessionEnded] = useState(() => {
    const flag = sessionStorage.getItem(SESSION_ENDED_FLAG) === '1';
    sessionStorage.removeItem(SESSION_ENDED_FLAG);
    return flag;
  });
  const { login, isLoading, mfaToken } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      // 2FA 사용자는 같은 화면에서 2단계 코드 입력으로 넘어간다
      // OAuth 동의 화면에서 로그인하러 왔으면 그리로 돌아간다(mcp-4)
      if ((await login(email, password)) === 'done') navigate(peekOAuthReturn() ?? '/');
      else setPassword('');
    } catch (err) {
      // 서버 code로 문구를 고른다(영어 원문 비교 금지). 검증 실패는 이메일 필드일 때만 이메일 안내를 보인다.
      setError(err instanceof ApiError && err.code === 'VALIDATION_FAILED'
        ? t(loginFieldErrorKey(err.fields))
        : apiErrorMessage(err, 'auth:login.errors.generic'));
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white">
      {/* Header */}
      <div className="mb-8 text-center">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/favicon-192.png" alt={t('brand.logoAlt')} className="h-12 w-12 rounded-lg" />
          <span className="text-3xl font-bold text-slack-primary">{t('brand.name')}</span>
        </div>
        <h1 className="text-4xl font-bold text-slack-primary">{t('login.title')}</h1>
        <p className="mt-2 text-gray-600">
          <Trans t={t} i18nKey="login.subtitle" components={{ strong: <strong /> }} />
        </p>
      </div>

      {/* Login Form */}
      <div className="w-full max-w-[400px] px-4">

        {mfaToken ? (
          <TwoFactorLoginStep onExpired={() => setError(t('login.twoFactor.expired'))} />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {sessionEnded && !error && (
              <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800" role="status" data-testid="session-ended-notice">
                {t('login.sessionEnded')}
              </div>
            )}
            {error && (
              <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700" role="alert">
                {error}
              </div>
            )}
            <div>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('fields.emailPlaceholder')}
                required
                className="h-11"
              />
            </div>
            <div>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('fields.password')}
                required
                className="h-11"
              />
            </div>
            <Button
              type="submit"
              disabled={isLoading}
              className="h-11 w-full bg-slack-purple hover:bg-slack-sidebar text-white font-medium"
            >
              {isLoading ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-gray-600">
          {t('login.newToApp')}{' '}
          <Link to="/register" className="text-slack-link hover:underline">
            {t('login.createAccount')}
          </Link>
        </p>
        <LanguageSelect className="mt-6 block" />
      </div>
    </div>
  );
}
