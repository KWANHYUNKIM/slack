import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldAlert } from 'lucide-react';
import * as api from '@/lib/api';
import type { OAuthConsentDetails } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { clearOAuthReturn } from '@/lib/oauthReturn';
import { useAuthStore } from '@/stores/useAuthStore';
import { ACCESS_TOKEN_SCOPES } from '@/stores/useAccessTokenStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

// 인가 요청에서 서버로 다시 보내는 파라미터. 이 밖의 쿼리는 버린다.
const PARAM_KEYS = ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource'];

// OAuth 동의 화면(mcp-4). 서버 /oauth/authorize가 요청을 확인한 뒤 이리로 보낸다.
// 앱 이름은 등록할 때 누구나 정할 수 있으므로 피싱 방지를 위해 허용 후 이동할 호스트를 크게 보여 준다.
// 허용·거부 결과의 이동 주소는 서버가 등록된 redirect_uri로만 만들어 준다.
export function OAuthConsentPage() {
  const { t } = useTranslation('auth');
  const { t: ts } = useTranslation('settings');
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const params = useMemo(() => {
    const q = new URLSearchParams(location.search);
    const out: Record<string, string> = {};
    for (const k of PARAM_KEYS) {
      const v = q.get(k);
      if (v !== null) out[k] = v;
    }
    return out;
  }, [location.search]);

  const [details, setDetails] = useState<OAuthConsentDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    clearOAuthReturn();
    api.getOAuthConsentDetails(params)
      .then(setDetails)
      .catch((err) => setLoadError(apiErrorMessage(err, 'auth:oauthConsent.errors.loadFailed')));
  }, [params]);

  const handleDecision = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await api.submitOAuthDecision(params, approve, approve && details?.mfaRequired ? mfaCode.trim() : undefined);
      setRedirecting(true);
      window.location.assign(redirectTo);
    } catch (err) {
      setMfaCode('');
      setError(apiErrorMessage(err, 'auth:oauthConsent.errors.generic'));
      setBusy(false);
    }
  };

  const scopeLabels = details
    ? ACCESS_TOKEN_SCOPES.filter((s) => details.scopes.includes(s.scope)).map((s) => ({ scope: s.scope, label: ts(`accessTokens.scope.${s.key}`) }))
    : [];
  const canAllow = !busy && !redirecting && (!details?.mfaRequired || mfaCode.trim().length > 0);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <main data-testid="oauth-consent" className="w-full max-w-[480px] rounded-xl border border-slack-border bg-white p-6 shadow-sm">
        {loadError ? (
          <p role="alert" data-testid="oauth-consent-error" className="text-sm text-slack-error">{loadError}</p>
        ) : !details ? (
          <p className="text-sm text-slack-hint">{t('oauthConsent.loading')}</p>
        ) : (
          <>
            <h1 className="text-xl font-bold text-slack-primary">
              {t('oauthConsent.title', { name: details.client.name || t('oauthConsent.unnamedApp') })}
            </h1>
            {user && <p className="mt-1 text-sm text-slack-secondary">{t('oauthConsent.signedInAs', { name: user.name })}</p>}

            <section className="mt-5 rounded-lg border-2 border-amber-400 bg-amber-50 p-4" aria-labelledby="oauth-redirect-label">
              <p id="oauth-redirect-label" className="text-xs font-medium uppercase text-amber-900">{t('oauthConsent.redirectLabel')}</p>
              <p data-testid="oauth-redirect-host" dir="ltr" className="mt-1 break-all text-start font-mono text-lg font-bold text-slack-primary">
                {details.client.redirectHost}
              </p>
              {details.client.loopback && <p className="mt-1 text-xs text-amber-900">{t('oauthConsent.loopback')}</p>}
              <p className="mt-3 flex gap-2 text-xs text-amber-900">
                <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t('oauthConsent.unverified')}</span>
              </p>
            </section>

            <section className="mt-5">
              <h2 className="text-sm font-bold text-slack-primary">{t('oauthConsent.scopesLabel')}</h2>
              <ul data-testid="oauth-scopes" className="mt-2 list-disc space-y-1 ps-5 text-sm text-slack-primary">
                {scopeLabels.map((s) => <li key={s.scope}>{s.label}</li>)}
              </ul>
              <p className="mt-3 text-xs text-slack-secondary">{t('oauthConsent.actsAsYou')}</p>
            </section>

            {details.mfaRequired && (
              <label className="mt-5 block">
                <span className="block text-sm font-medium text-slack-primary">{t('oauthConsent.codeLabel')}</span>
                <span className="block text-xs text-slack-secondary">{t('oauthConsent.codeHint')}</span>
                <Input
                  data-testid="oauth-mfa-code"
                  className="mt-2"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  autoComplete="one-time-code"
                  maxLength={32}
                  dir="ltr"
                />
              </label>
            )}

            {error && <p role="alert" className="mt-4 text-sm text-slack-error">{error}</p>}
            {redirecting && <p role="status" className="mt-4 text-sm text-slack-secondary">{t('oauthConsent.redirecting')}</p>}

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="secondary" data-testid="oauth-deny" disabled={busy || redirecting} onClick={() => void handleDecision(false)}>
                {t('oauthConsent.deny')}
              </Button>
              <Button data-testid="oauth-allow" disabled={!canAllow} onClick={() => void handleDecision(true)}>
                {t('oauthConsent.allow')}
              </Button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
