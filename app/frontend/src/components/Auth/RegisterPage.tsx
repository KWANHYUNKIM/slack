import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { LanguageSelect } from '@/components/ui/LanguageSelect';
import { useAuthStore } from '@/stores/useAuthStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { validateInvite } from '@/lib/api';
import { ApiError } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { registerFieldErrorKey, registerInputErrorKey } from '@/lib/authErrors';

export function RegisterPage() {
  const { t } = useTranslation('auth');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const { register, isLoading } = useAuthStore();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inviteCode = searchParams.get('invite') || undefined;
  const [inviteValid, setInviteValid] = useState<boolean | null>(null);
  const [inviteRole, setInviteRole] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState('');

  useEffect(() => {
    if (inviteCode) {
      validateInvite(inviteCode)
        .then((data) => {
          setInviteValid(data.valid);
          setInviteRole(data.role);
        })
        .catch((err) => {
          setInviteValid(false);
          setInviteError(apiErrorMessage(err, 'auth:register.inviteInvalid'));
        });
    }
  }, [inviteCode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError(t('register.errors.passwordMismatch'));
      return;
    }
    // 서버에 보내기 전에 이름·비밀번호 규칙을 먼저 안내한다
    const inputError = registerInputErrorKey(name, password);
    if (inputError) {
      setError(t(inputError));
      return;
    }
    try {
      await register(name, email, password, inviteCode);
      navigate('/');
    } catch (err) {
      // 서버 code로 문구를 고른다(영어 원문 비교 금지)
      const fieldKey = err instanceof ApiError && err.code === 'VALIDATION_FAILED' ? registerFieldErrorKey(err.fields) : null;
      setError(fieldKey ? t(fieldKey) : apiErrorMessage(err, 'auth:login.errors.generic'));
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
        <h1 className="text-4xl font-bold text-slack-primary">{t('register.title')}</h1>
        <p className="mt-2 text-gray-600">
          <Trans t={t} i18nKey="login.subtitle" components={{ strong: <strong /> }} />
        </p>
      </div>

      {/* Register Form */}
      <div className="w-full max-w-[400px] px-4">
        {/* Invite Banner */}
        {inviteCode && inviteValid === true && (
          <div className="mb-4 rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700">
            <Trans t={t} i18nKey="register.invited" values={{ role: inviteRole }} components={{ strong: <strong /> }} />
          </div>
        )}
        {inviteCode && inviteValid === false && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {inviteError || t('register.inviteInvalid')}
          </div>
        )}


        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700" role="alert">
              {error}
            </div>
          )}
          <div>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('fields.fullName')}
              required
              className="h-11"
            />
          </div>
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
            <p className="mt-1 text-xs text-gray-500">{t('register.passwordHint')}</p>
          </div>
          <div>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t('fields.confirmPassword')}
              required
              className="h-11"
            />
          </div>
          <Button
            type="submit"
            disabled={isLoading}
            className="h-11 w-full bg-slack-purple hover:bg-slack-sidebar text-white font-medium"
          >
            {isLoading ? t('register.submitting') : t('register.submit')}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-600">
          {t('register.haveAccount')}{' '}
          <Link to="/login" className="text-slack-link hover:underline">
            {t('register.signIn')}
          </Link>
        </p>
        <LanguageSelect className="mt-6 block" />
      </div>
    </div>
  );
}
