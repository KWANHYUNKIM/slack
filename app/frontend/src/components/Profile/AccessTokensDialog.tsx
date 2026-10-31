import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, KeyRound } from 'lucide-react';
import { ApiError, type AccessTokenScope } from '@/lib/api';
import { getMcpUrl } from '@/lib/serverUrl';
import { useAccessTokenStore, ACCESS_TOKEN_SCOPES } from '@/stores/useAccessTokenStore';
import { useToastStore } from '@/stores/useToastStore';
import { AccessTokenRow } from './AccessTokenRow';

interface AccessTokensDialogProps {
  onClose: () => void;
}

const NAME_MAX = 100;
// 서버 accessTokenService.MAX_ACTIVE_TOKENS와 같은 값(안내 문구에만 쓴다)
const TOKEN_LIMIT = 20;
const EXPIRY_OPTIONS = ['7', '30', '90', '365', 'never'] as const;
type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];
// 처음에는 읽기 범위만 켠다. 쓰기(메시지, 리액션)는 사용자가 직접 켜야 한다.
const DEFAULT_SCOPES: AccessTokenScope[] = ['channels:read', 'channels:history', 'users:read'];

// 개인 액세스 토큰 관리(mcp-1): 발급, 목록, 이름 바꾸기, 폐기. 원문은 발급 직후 이 화면에서 한 번만 보인다.
export function AccessTokensDialog({ onClose }: AccessTokensDialogProps) {
  const { t } = useTranslation('settings');
  const { tokens, loading, justCreated, load, create, dismissCreated } = useAccessTokenStore();
  const showToast = useToastStore((s) => s.show);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<AccessTokenScope[]>(DEFAULT_SCOPES);
  const [expiry, setExpiry] = useState<ExpiryOption>('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load().catch(() => setError(t('accessTokens.errors.loadFailed')));
    // 닫을 때 원문을 메모리에서 지운다
    return () => dismissCreated();
  }, [load, dismissCreated, t]);

  const canCreate = !busy && name.trim().length > 0 && scopes.length > 0;

  const toggleScope = (scope: AccessTokenScope) =>
    setScopes((cur) => (cur.includes(scope) ? cur.filter((s) => s !== scope) : [...cur, scope]));

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      await create({ name: name.trim(), scopes, expiresInDays: expiry === 'never' ? null : Number(expiry) });
      setName('');
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'TOKEN_LIMIT_REACHED'
        ? t('accessTokens.errors.limitReached', { max: TOKEN_LIMIT })
        : t('accessTokens.errors.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('accessTokens.copied'));
    } catch {
      setError(t('accessTokens.errors.copyFailed'));
    }
  };

  const connectCommand = justCreated
    ? `claude mcp add --transport http slackclone ${getMcpUrl()} --header "Authorization: Bearer ${justCreated.token}"`
    : '';

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('accessTokens.title')}
        data-testid="access-tokens-dialog"
        className="flex max-h-[90vh] w-[560px] max-w-[95vw] flex-col rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h3 className="mb-1 flex items-center gap-2 text-[17px] font-bold text-slack-primary">
          <KeyRound className="h-5 w-5" />
          {t('accessTokens.title')}
        </h3>
        <p className="mb-4 text-[13px] text-slack-secondary">{t('accessTokens.description')}</p>

        {justCreated && (
          <div data-testid="access-token-created" role="status" className="mb-4 rounded-md border border-green-300 bg-green-50 p-3">
            <p className="mb-2 text-[13px] font-medium text-green-800">{t('accessTokens.createdNotice')}</p>
            <div className="flex items-center gap-2">
              <code data-testid="access-token-value" className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 font-mono text-[12px]">
                {justCreated.token}
              </code>
              <button
                type="button"
                aria-label={t('accessTokens.copy')}
                title={t('accessTokens.copy')}
                onClick={() => handleCopy(justCreated.token)}
                className="rounded p-1.5 text-slack-secondary hover:bg-slack-hover"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-1 mt-3 text-[12px] text-slack-secondary">{t('accessTokens.connectHint')}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1 font-mono text-[11px]">{connectCommand}</code>
              <button
                type="button"
                aria-label={t('accessTokens.copyCommand')}
                title={t('accessTokens.copyCommand')}
                onClick={() => handleCopy(connectCommand)}
                className="rounded p-1.5 text-slack-secondary hover:bg-slack-hover"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            <button type="button" onClick={dismissCreated} className="mt-2 text-[13px] font-medium text-green-800 hover:underline">
              {t('accessTokens.dismiss')}
            </button>
          </div>
        )}

        <div className="mb-4 rounded-md border border-slack-border p-3">
          <label className="mb-2 block text-[13px] text-slack-secondary">
            {t('accessTokens.nameLabel')}
            <input
              data-testid="access-token-name-input"
              className="mt-1 block w-full rounded-md border border-slack-border px-2 py-1.5 text-[14px]"
              placeholder={t('accessTokens.namePlaceholder')}
              maxLength={NAME_MAX}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className="mb-2">
            <legend className="text-[13px] text-slack-secondary">{t('accessTokens.scopesLabel')}</legend>
            {ACCESS_TOKEN_SCOPES.map(({ scope, key }) => (
              <label key={scope} className="mt-1 flex items-center gap-2 text-[13px] text-slack-primary">
                <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                {t(`accessTokens.scope.${key}`)}
              </label>
            ))}
          </fieldset>
          <label className="mb-3 block text-[13px] text-slack-secondary">
            {t('accessTokens.expiryLabel')}
            <select
              data-testid="access-token-expiry-select"
              className="mt-1 block w-full rounded-md border border-slack-border bg-white px-2 py-1.5 text-[14px]"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as ExpiryOption)}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o === 'never' ? t('accessTokens.expiryNever') : t('accessTokens.expiryDays', { count: Number(o) })}
                </option>
              ))}
            </select>
          </label>
          {expiry === 'never' && <p className="mb-2 text-[12px] text-amber-700">{t('accessTokens.neverWarning')}</p>}
          <button
            type="button"
            data-testid="access-token-create"
            disabled={!canCreate}
            onClick={handleCreate}
            className="rounded-md bg-slack-aubergine px-4 py-2 text-[14px] font-medium text-white disabled:opacity-50"
          >
            {t('accessTokens.create')}
          </button>
        </div>

        {error && <p role="alert" className="mb-3 text-[13px] text-red-600">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && tokens.length === 0 ? (
            <p className="text-[13px] text-slack-hint">{t('accessTokens.loading')}</p>
          ) : tokens.length === 0 ? (
            <p className="text-[13px] text-slack-hint">{t('accessTokens.empty')}</p>
          ) : (
            <ul data-testid="access-token-list">
              {tokens.map((tok) => <AccessTokenRow key={tok.id} token={tok} onError={setError} />)}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slack-border px-4 py-2 text-[14px] font-medium text-slack-primary hover:bg-slack-hover"
          >
            {t('accessTokens.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
