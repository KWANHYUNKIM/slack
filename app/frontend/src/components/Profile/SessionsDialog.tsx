import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Laptop } from 'lucide-react';
import * as api from '@/lib/api';
import type { UserSession } from '@/lib/api';
import { formatDateTime, DATE_TIME_MEDIUM } from '@/lib/i18n/format';
import { useAuthStore } from '@/stores/useAuthStore';
import { useToastStore } from '@/stores/useToastStore';

interface SessionsDialogProps {
  onClose: () => void;
}

// 로그인된 기기 관리(E7): 목록, 이 기기 표시, 기기 하나 또는 나머지 전체 로그아웃.
export function SessionsDialog({ onClose }: SessionsDialogProps) {
  const { t } = useTranslation('settings');
  const logout = useAuthStore((s) => s.logout);
  const showToast = useToastStore((s) => s.show);
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await api.listMySessions());
      setError(null);
    } catch {
      setError(t('sessions.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRevoke = async (session: UserSession) => {
    setBusyId(session.id);
    setError(null);
    try {
      await api.revokeMySession(session.id);
      // 이 기기를 지우면 토큰이 곧바로 무효가 되므로 로그아웃 화면으로 보낸다
      if (session.current) {
        logout();
        return;
      }
      setSessions((cur) => cur.filter((s) => s.id !== session.id));
      showToast(t('sessions.revoked'));
    } catch {
      setError(t('sessions.errors.revokeFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const handleRevokeOthers = async () => {
    setBusyId('all');
    setError(null);
    try {
      await api.revokeOtherSessions();
      setSessions((cur) => cur.filter((s) => s.current));
      setConfirmAll(false);
      showToast(t('sessions.revokedOthers'));
    } catch {
      setError(t('sessions.errors.revokeFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const others = sessions.filter((s) => !s.current);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('sessions.title')}
        data-testid="sessions-dialog"
        className="flex max-h-[90vh] w-[560px] max-w-[95vw] flex-col rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h3 className="mb-1 flex items-center gap-2 text-[17px] font-bold text-slack-primary">
          <Laptop className="h-5 w-5" />
          {t('sessions.title')}
        </h3>
        <p className="mb-4 text-[13px] text-slack-secondary">{t('sessions.description')}</p>

        {error && <p role="alert" className="mb-3 text-[13px] text-red-600">{error}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-[13px] text-slack-hint">{t('sessions.loading')}</p>
          ) : sessions.length === 0 ? (
            <p className="text-[13px] text-slack-hint">{t('sessions.empty')}</p>
          ) : (
            <ul data-testid="session-list">
              {sessions.map((s) => (
                <li key={s.id} data-testid="session-row" className="flex items-start justify-between gap-3 border-b border-slack-border-light py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-[14px] font-medium text-slack-primary">
                      {s.userAgent ?? t('sessions.unknownDevice')}
                      {s.current && (
                        <span data-testid="session-current" className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
                          {t('sessions.thisDevice')}
                        </span>
                      )}
                    </p>
                    {s.ip && <p className="mt-0.5 font-mono text-[12px] text-slack-hint">{s.ip}</p>}
                    <p className="mt-0.5 text-[12px] text-slack-secondary">
                      {t('sessions.signedInAt', { date: formatDateTime(s.createdAt, DATE_TIME_MEDIUM) })}
                      {' · '}
                      {t('sessions.lastActive', { date: formatDateTime(s.lastSeenAt, DATE_TIME_MEDIUM) })}
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="session-revoke"
                    disabled={busyId !== null}
                    aria-label={t(s.current ? 'sessions.signOutThisLabel' : 'sessions.signOutLabel', { device: s.userAgent ?? t('sessions.unknownDevice') })}
                    onClick={() => void handleRevoke(s)}
                    className="shrink-0 rounded-md border border-red-300 px-3 py-1 text-[13px] text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {t('sessions.signOut')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          {others.length > 0 ? (
            confirmAll ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="session-revoke-others-confirm"
                  disabled={busyId !== null}
                  onClick={() => void handleRevokeOthers()}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                >
                  {t('sessions.signOutOthersConfirm', { count: others.length })}
                </button>
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => setConfirmAll(false)}
                  className="rounded-md border border-slack-border px-3 py-1.5 text-[13px] text-slack-primary hover:bg-slack-hover"
                >
                  {t('accessTokens.cancel')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="session-revoke-others"
                onClick={() => setConfirmAll(true)}
                className="rounded-md border border-red-300 px-3 py-1.5 text-[13px] text-red-600 hover:bg-red-50"
              >
                {t('sessions.signOutOthers')}
              </button>
            )
          ) : <span />}
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
