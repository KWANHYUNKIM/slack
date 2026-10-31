import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { formatDateTime, DATE_TIME_MEDIUM } from '@/lib/i18n/format';
import * as api from '@/lib/api';
import type { AuditLogEntry, AuditLogFilter } from '@/lib/api';
import { useAdminStore } from '@/stores/useAdminStore';
import { useAdminAction } from '@/hooks/useAdminAction';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { apiErrorMessage } from '@/lib/apiErrors';

// 서버가 남기는 action → 번역 키. 목록에 없는 action(나중에 추가된 것)은 원문을 그대로 보여 준다.
const ACTION_KEYS: Record<string, string> = {
  'auth.login': 'authLogin',
  'auth.login_failed': 'authLoginFailed',
  'auth.login_locked': 'authLoginLocked',
  'auth.logout': 'authLogout',
  'auth.password_changed': 'authPasswordChanged',
  'user.role_changed': 'userRoleChanged',
  'user.deactivated': 'userDeactivated',
  'user.reactivated': 'userReactivated',
  'user.force_logout': 'userForceLogout',
  'session.revoked': 'sessionRevoked',
  'session.revoked_all': 'sessionRevokedAll',
  'mfa.enabled': 'mfaEnabled',
  'mfa.disabled': 'mfaDisabled',
  'mfa.recovery_used': 'mfaRecoveryUsed',
  'mfa.reset_by_admin': 'mfaResetByAdmin',
  'workspace.mfa_policy_changed': 'mfaPolicyChanged',
  'workspace.ownership_transferred': 'ownershipTransferred',
  'owner.bootstrapped': 'ownerBootstrapped',
  'channel.created': 'channelCreated',
  'channel.edited': 'channelEdited',
  'channel.archived': 'channelArchived',
  'channel.unarchived': 'channelUnarchived',
  'channel.deleted': 'channelDeleted',
  'channel.member_added': 'channelMemberAdded',
  'channel.member_removed': 'channelMemberRemoved',
  'invite.created': 'inviteCreated',
  'invite.deleted': 'inviteDeleted',
  'webhook.created': 'webhookCreated',
  'webhook.deleted': 'webhookDeleted',
  'token.create': 'tokenCreate',
  'token.revoke': 'tokenRevoke',
  'mcp.tool_call': 'mcpToolCall',
  'audit.exported': 'auditExported',
  'retention.purged': 'retentionPurged',
  'retention.workspace_updated': 'retentionWorkspaceUpdated',
  'retention.channel_updated': 'retentionChannelUpdated',
  'retention.channel_cleared': 'retentionChannelCleared',
};

const TARGET_KEYS: Record<string, string> = {
  user: 'user',
  channel: 'channel',
  invite: 'invite',
  webhook: 'webhook',
  message: 'message',
  direct_message: 'directMessage',
  personal_access_token: 'token',
  audit_log: 'auditLog',
  mcp_tool: 'mcpTool',
  workspace: 'workspace',
  file: 'file',
};

function actionColor(action: string): string {
  if (/failed|delet|revoke|deactivat|force_logout/.test(action)) return 'bg-red-100 text-red-700';
  if (/creat|reactivat|added|login$/.test(action)) return 'bg-green-100 text-green-700';
  if (/archiv|exported|ownership/.test(action)) return 'bg-amber-100 text-amber-700';
  return 'bg-blue-100 text-blue-700';
}

// datetime-local 값(브라우저 로컬 시각)을 UTC ISO 문자열로 바꾼다. 비어 있으면 필터에서 뺀다.
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const EMPTY_FILTER = { actions: [] as string[], actorId: '', targetType: '', from: '', to: '' };

export function AdminAuditLogTab() {
  const { t } = useTranslation('admin');
  const users = useAdminStore((s) => s.users);
  const [form, setForm] = useState(EMPTY_FILTER);
  const [applied, setApplied] = useState<AuditLogFilter>({ action: [] });
  const [items, setItems] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const exportAction = useAdminAction('admin:errors.exportAuditLog');
  // 새 요청은 이전 요청을 취소하고 항상 실행한다(진행 중이라고 버리지 않는다). busy 가드는 여기에 쓰지 않는다.
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (filter: AuditLogFilter, cursor: number | null) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setLoadError('');
    // 필터가 바뀌면 이전 커서는 쓸 수 없다. "더 보기"는 같은 필터의 다음 페이지일 때만 이어 받는다.
    if (!cursor) setNextCursor(null);
    try {
      const page = await api.adminListAuditLogs(filter, cursor, 50, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setItems((prev) => (cursor ? [...prev, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      setLoaded(true);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setLoadError(apiErrorMessage(err, 'admin:errors.fetchAuditLog'));
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(applied, null);
    return () => abortRef.current?.abort();
  }, [applied, load]);

  const apply = () => {
    setApplied({
      action: form.actions,
      actorId: form.actorId ? Number(form.actorId) : undefined,
      targetType: form.targetType || undefined,
      from: toIso(form.from),
      to: toIso(form.to),
    });
  };

  const reset = () => {
    setForm(EMPTY_FILTER);
    setApplied({ action: [] });
  };

  const toggleAction = (action: string) =>
    setForm((f) => ({
      ...f,
      actions: f.actions.includes(action) ? f.actions.filter((a) => a !== action) : [...f.actions, action],
    }));

  // 토큰이 든 주소로 이동해 브라우저가 파일을 바로 받게 한다
  const download = (format: 'csv' | 'json') =>
    exportAction.run(async () => {
      const url = await api.adminAuditExportUrl(applied, format);
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

  const actionLabel = (action: string) =>
    ACTION_KEYS[action] ? t(`audit.action.${ACTION_KEYS[action]}`) : action;
  const targetLabel = (type: string) => (TARGET_KEYS[type] ? t(`audit.targets.${TARGET_KEYS[type]}`) : type);

  return (
    <div>
      {/* 필터 */}
      <div className="mb-4 grid gap-3 rounded-lg border border-slack-border p-3 sm:grid-cols-2 lg:grid-cols-4">
        <details className="relative">
          <summary className="flex h-10 cursor-pointer items-center rounded-md border border-gray-300 px-3 text-sm">
            {form.actions.length > 0 ? t('audit.filters.actionsSelected', { count: form.actions.length }) : t('audit.filters.allActions')}
          </summary>
          <div className="absolute z-10 mt-1 max-h-64 w-64 overflow-y-auto rounded-md border border-slack-border bg-white p-2 shadow-lg">
            {Object.keys(ACTION_KEYS).map((action) => (
              <label key={action} className="flex items-center gap-2 py-1 text-[13px]">
                <input type="checkbox" checked={form.actions.includes(action)} onChange={() => toggleAction(action)} />
                {actionLabel(action)}
              </label>
            ))}
          </div>
        </details>
        <select
          aria-label={t('audit.filters.actor')}
          value={form.actorId}
          onChange={(e) => setForm({ ...form, actorId: e.target.value })}
          className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm"
        >
          <option value="">{t('audit.filters.allActors')}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.name}</option>
          ))}
        </select>
        <select
          aria-label={t('audit.filters.targetType')}
          value={form.targetType}
          onChange={(e) => setForm({ ...form, targetType: e.target.value })}
          className="h-10 rounded-md border border-gray-300 bg-white px-3 text-sm"
        >
          <option value="">{t('audit.filters.allTargets')}</option>
          {Object.keys(TARGET_KEYS).map((type) => (
            <option key={type} value={type}>{targetLabel(type)}</option>
          ))}
        </select>
        <div />
        <label className="text-[12px] text-slack-hint">
          {t('audit.filters.from')}
          <Input type="datetime-local" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </label>
        <label className="text-[12px] text-slack-hint">
          {t('audit.filters.to')}
          <Input type="datetime-local" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
        </label>
        <div className="flex items-end gap-2 sm:col-span-2">
          <Button onClick={apply}>{t('audit.filters.apply')}</Button>
          <Button variant="outline" onClick={reset}>{t('audit.filters.reset')}</Button>
          <div className="ms-auto flex gap-2">
            <Button variant="outline" disabled={exportAction.busy} onClick={() => void download('csv')}>
              <Download className="me-1 h-4 w-4" />{t('audit.export.csv')}
            </Button>
            <Button variant="outline" disabled={exportAction.busy} onClick={() => void download('json')}>
              <Download className="me-1 h-4 w-4" />{t('audit.export.json')}
            </Button>
          </div>
        </div>
      </div>

      {loadError && <ErrorBanner message={loadError} onDismiss={() => setLoadError('')} />}
      {exportAction.error && <ErrorBanner message={exportAction.error} onDismiss={exportAction.reset} />}

      {loaded && items.length === 0 && (
        <div className="py-8 text-center text-sm text-slack-hint">{t('audit.empty')}</div>
      )}

      <div className="space-y-1">
        {items.map((entry) => (
          <div
            key={entry.id}
            className="flex items-start gap-3 rounded-lg border-b border-slack-border p-3 last:border-b-0 hover:bg-gray-50/50"
          >
            <Avatar
              src={entry.actor?.avatar ?? undefined}
              alt={entry.actor?.name ?? t('audit.unknownActor')}
              fallback={entry.actor?.name ?? '?'}
              size="sm"
              className="mt-0.5 flex-shrink-0"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-slack-primary">
                  {entry.actor?.name ?? t('audit.unknownActor')}
                </span>
                <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${actionColor(entry.action)}`}>
                  {actionLabel(entry.action)}
                </span>
                <span className="text-[12px] text-slack-hint">
                  {targetLabel(entry.targetType)}
                  {entry.targetName && (
                    <span className="ms-1 font-medium text-slack-secondary">
                      {entry.targetType === 'channel' ? '#' : ''}{entry.targetName}
                    </span>
                  )}
                </span>
              </div>
              {entry.details && <p className="mt-0.5 break-words text-[12px] text-slack-secondary">{entry.details}</p>}
              <span className="text-[11px] text-slack-hint">{formatDateTime(entry.createdAt, DATE_TIME_MEDIUM)}</span>
            </div>
          </div>
        ))}
      </div>

      {nextCursor && (
        <button
          disabled={loading}
          onClick={() => void load(applied, nextCursor)}
          className="mt-4 w-full rounded-lg border border-slack-border py-2 text-sm text-slack-secondary hover:bg-gray-50 disabled:opacity-50"
        >
          {t('audit.loadMore')}
        </button>
      )}
    </div>
  );
}
