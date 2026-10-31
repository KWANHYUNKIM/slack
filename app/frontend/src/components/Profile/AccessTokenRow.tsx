import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDate, formatList, DATE_MEDIUM } from '@/lib/i18n/format';
import type { AccessToken } from '@/lib/api';
import { useAccessTokenStore, ACCESS_TOKEN_SCOPES } from '@/stores/useAccessTokenStore';

interface AccessTokenRowProps {
  token: AccessToken;
  onError: (message: string) => void;
}

const NAME_MAX = 100;

export function AccessTokenRow({ token, onError }: AccessTokenRowProps) {
  const { t } = useTranslation('settings');
  const rename = useAccessTokenStore((s) => s.rename);
  const revoke = useAccessTokenStore((s) => s.revoke);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(token.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === token.name) {
      setEditing(false);
      setName(token.name);
      return;
    }
    setBusy(true);
    try {
      await rename(token.id, trimmed);
      setEditing(false);
    } catch {
      onError(t('accessTokens.errors.renameFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async () => {
    setBusy(true);
    try {
      await revoke(token.id);
    } catch {
      onError(t('accessTokens.errors.revokeFailed'));
      setBusy(false);
      setConfirming(false);
    }
  };

  const expiry = token.expired
    ? t('accessTokens.expired')
    : token.expiresAt
      ? t('accessTokens.expires', { date: formatDate(token.expiresAt, DATE_MEDIUM) })
      : t('accessTokens.noExpiry');

  return (
    <li data-testid="access-token-row" className="flex items-start justify-between gap-3 border-b border-slack-border-light py-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            data-testid="access-token-rename-input"
            aria-label={t('accessTokens.nameLabel')}
            className="w-full rounded border border-slack-border px-2 py-1 text-[14px]"
            value={name}
            maxLength={NAME_MAX}
            autoFocus
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); setName(token.name); }
            }}
          />
        ) : (
          <p className="truncate text-[14px] font-medium text-slack-primary">{token.name}</p>
        )}
        <p className="mt-0.5 font-mono text-[12px] text-slack-hint">{token.prefix}…</p>
        <p className="mt-0.5 text-[12px] text-slack-secondary">
          {formatList(
            ACCESS_TOKEN_SCOPES.filter((s) => token.scopes.includes(s.scope)).map((s) => t(`accessTokens.scope.${s.key}`)),
          )}
        </p>
        <p className={token.expired ? 'mt-0.5 text-[12px] text-red-600' : 'mt-0.5 text-[12px] text-slack-secondary'}>
          {expiry}
          {' · '}
          {token.lastUsedAt
            ? t('accessTokens.lastUsed', { date: formatDate(token.lastUsedAt, DATE_MEDIUM) })
            : t('accessTokens.neverUsed')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {confirming ? (
          <>
            <button
              type="button"
              data-testid="access-token-revoke-confirm"
              disabled={busy}
              onClick={handleRevoke}
              className="rounded-md bg-red-600 px-3 py-1 text-[13px] font-medium text-white disabled:opacity-50"
            >
              {t('accessTokens.revokeConfirm')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className="rounded-md border border-slack-border px-3 py-1 text-[13px] text-slack-primary hover:bg-slack-hover"
            >
              {t('accessTokens.cancel')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              data-testid="access-token-rename"
              aria-label={t('accessTokens.renameLabel', { name: token.name })}
              onClick={() => setEditing(true)}
              className="rounded-md border border-slack-border px-3 py-1 text-[13px] text-slack-primary hover:bg-slack-hover"
            >
              {t('accessTokens.rename')}
            </button>
            <button
              type="button"
              data-testid="access-token-revoke"
              aria-label={t('accessTokens.revokeLabel', { name: token.name })}
              onClick={() => setConfirming(true)}
              className="rounded-md border border-red-300 px-3 py-1 text-[13px] text-red-600 hover:bg-red-50"
            >
              {t('accessTokens.revoke')}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
