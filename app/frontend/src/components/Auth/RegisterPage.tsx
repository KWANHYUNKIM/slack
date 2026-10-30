import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/useAuthStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { validateInvite } from '@/lib/api';

export function RegisterPage() {
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

  useEffect(() => {
    if (inviteCode) {
      validateInvite(inviteCode)
        .then((data) => {
          setInviteValid(data.valid);
          setInviteRole(data.role);
        })
        .catch(() => setInviteValid(false));
    }
  }, [inviteCode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    try {
      await register(name, email, password, inviteCode);
      navigate('/');
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      const errorMap: Record<string, string> = {
        'Email already exists': 'An account with this email already exists',
        'Email already in use': 'An account with this email already exists',
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
        <h1 className="text-4xl font-bold text-slack-primary">Create your account</h1>
        <p className="mt-2 text-gray-600">
          We suggest using the <strong>email address you use at work.</strong>
        </p>
      </div>

      {/* Register Form */}
      <div className="w-full max-w-[400px] px-4">
        {/* Invite Banner */}
        {inviteCode && inviteValid === true && (
          <div className="mb-4 rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700">
            You've been invited to join as a <strong>{inviteRole}</strong>
          </div>
        )}
        {inviteCode && inviteValid === false && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            This invite link is invalid or has expired
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
              placeholder="Full name"
              required
              className="h-11"
            />
          </div>
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
              minLength={8}
              className="h-11"
            />
          </div>
          <div>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm password"
              required
              className="h-11"
            />
          </div>
          <Button
            type="submit"
            disabled={isLoading}
            className="h-11 w-full bg-slack-purple hover:bg-slack-sidebar text-white font-medium"
          >
            {isLoading ? 'Creating account...' : 'Create Account'}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-600">
          Already have an account?{' '}
          <Link to="/login" className="text-slack-link hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
