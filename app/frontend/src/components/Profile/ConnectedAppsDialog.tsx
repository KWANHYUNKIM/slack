import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PlugZap } from 'lucide-react';
import * as api from '@/lib/api';
import type { ConnectedApp } from '@/lib/api';
import { formatDateTime, formatList, DATE_TIME_MEDIUM } from '@/lib/i18n/format';
import { ACCESS_TOKEN_SCOPES } from '@/stores/useAccessTokenStore';
import { useToastStore } from '@/stores/useToastStore';

interface ConnectedAppsDialogProps {
  onClose: () => void;
}

// 연결된 앱(mcp-4): OAuth로 허용한 앱 목록과 연결 해제. 해제하면 그 앱의 토큰이 모두 폐기된다.
export function ConnectedAppsDialog({ onClose }: ConnectedAppsDialogProps) {
  const { t } = useTranslation('settings');
  const showToast = useToastStore((s) => s.show);
  const [apps, setApps] = useState<ConnectedApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setApps((await api.listConnectedApps()).items);
      setError(null);
    } catch {
      setError(t('connectedApps.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDisconnect = async (app: ConnectedApp) => {
    setBusy(true);
    setError(null);
    try {
      await api.disconnectConnectedApp(app.id);
      setApps((cur) => cur.filter((a) => a.id !== app.id));
      setConfirmId(null);
      showToast(t('connectedApps.disconnected'));
    } catch {
      setError(t('connectedApps.errors.disconnectFailed'));
    } finally {
      setBusy(false);
    }
  };

  const scopeLabels = (app: ConnectedApp) =>
    ACCESS_TOKEN_SCOPES.filter((s) => app.scopes.includes(s.scope)).map((s) => t(`accessTokens.scope.${s.key}`));

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('connectedApps.title')}
        data-testid="connected-apps-dialog"
        className="flex max-h-[90vh] w-[560px] max-w-[95vw] flex-col rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h3 className="mb-1 flex items-center gap-2 text-[17px] font-bold text-slack-primary">
          <PlugZap className="h-5 w-5" />
          {t('connectedApps.title')}
        </h3>
        <p className="mb-4 text-[13px] text-slack-secondary">{t('connectedApps.description')}</p>

        {error && <p role="alert" className="mb-3 text-[13px] text-red-600">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-[13px] text-slack-hint">{t('connectedApps.loading')}</p>
          ) : apps.length === 0 ? (
            <p data-testid="connected-apps-empty" className="text-[13px] text-slack-hint">{t('connectedApps.empty')}</p>
          ) : (
            <ul data-testid="connected-app-list">
              {apps.map((app) => (
                <li key={app.id} data-testid="connected-app-row" className="flex items-start justify-between gap-3 border-b border-slack-border-light py-3">
                  <div className="min-w-0 flex-1">
                    <p dir="auto" className="truncate text-[14px] font-medium text-slack-primary">{app.name}</p>
                    <p className="mt-0.5 text-[12px] text-slack-secondary">
                      {t('connectedApps.redirectsTo', { hosts: formatList(app.redirectHosts) })}
                    </p>
                    <p className="mt-0.5 text-[12px] text-slack-secondary">{formatList(scopeLabels(app))}</p>
                    <p className="mt-0.5 text-[12px] text-slack-hint">
                      {app.connectedAt && t('connectedApps.connectedAt', { date: formatDateTime(app.connectedAt, DATE_TIME_MEDIUM) })}
                      {' · '}
                      {app.lastUsedAt
                        ? t('connectedApps.lastUsed', { date: formatDateTime(app.lastUsedAt, DATE_TIME_MEDIUM) })
                        : t('connectedApps.neverUsed')}
                    </p>
                  </div>
                  {confirmId === app.id ? (
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        data-testid="connected-app-disconnect-confirm"
                        disabled={busy}
                        onClick={() => void handleDisconnect(app)}
                        className="rounded-md bg-red-600 px-3 py-1 text-[13px] font-medium text-white disabled:opacity-50"
                      >
                        {t('connectedApps.disconnectConfirm')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmId(null)}
                        className="rounded-md border border-slack-border px-3 py-1 text-[13px] text-slack-primary hover:bg-slack-hover"
                      >
                        {t('connectedApps.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      data-testid="connected-app-disconnect"
                      disabled={busy}
                      aria-label={t('connectedApps.disconnectLabel', { name: app.name })}
                      onClick={() => setConfirmId(app.id)}
                      className="shrink-0 rounded-md border border-red-300 px-3 py-1 text-[13px] text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {t('connectedApps.disconnect')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slack-border px-4 py-2 text-[14px] font-medium text-slack-primary hover:bg-slack-hover"
          >
            {t('connectedApps.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
