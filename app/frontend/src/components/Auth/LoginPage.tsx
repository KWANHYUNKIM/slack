import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/useAuthStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function LoginPage() {
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
        'Invalid credentials': 'Invalid email or password',
        'User not found': 'Invalid email or password',
        'Invalid email address': 'Please enter a valid email address',
      };
      setError(errorMap[raw] || raw || 'Something went wrong. Please try again.');
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white">
      {/* Header */}
      <div className="mb-8 text-center">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/favicon-192.png" alt="Slawk" className="h-12 w-12 rounded-lg" />
          <span className="text-3xl font-bold text-slack-primary">slawk</span>
        </div>
        <h1 className="text-4xl font-bold text-slack-primary">Sign in to Slawk</h1>
        <p className="mt-2 text-gray-600">
          We suggest using the <strong>email address you use at work.</strong>
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
              placeholder="name@work-email.com"
              required
              className="h-11"
            />
          </div>
          <div>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              className="h-11"
            />
          </div>
          <Button
            type="submit"
            disabled={isLoading}
            className="h-11 w-full bg-slack-purple hover:bg-slack-sidebar text-white font-medium"
          >
            {isLoading ? 'Signing in...' : 'Sign in with Email'}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-600">
          New to Slawk?{' '}
          <Link to="/register" className="text-slack-link hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
