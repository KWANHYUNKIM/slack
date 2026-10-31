import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { LanguageSelect } from '@/components/ui/LanguageSelect';
import { useAuthStore } from '@/stores/useAuthStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function LoginPage() {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login, isLoading } = useAuthStore();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      const errorMap: Record<string, string> = {
        'Invalid credentials': t('login.errors.invalidCredentials'),
        'User not found': t('login.errors.invalidCredentials'),
        'Invalid email address': t('login.errors.invalidEmail'),
      };
      setError(errorMap[raw] || raw || t('login.errors.generic'));
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

        <form onSubmit={handleSubmit} className="space-y-4">
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
