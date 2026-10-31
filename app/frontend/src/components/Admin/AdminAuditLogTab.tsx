import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, DATE_TIME_MEDIUM } from '@/lib/i18n/format';
import { useAdminStore } from '@/stores/useAdminStore';
import { Avatar } from '@/components/ui/avatar';

const ACTION_LABELS: Record<string, { labelKey: string; color: string }> = {
  'user.role_changed': { labelKey: 'audit.actions.roleChanged', color: 'bg-blue-100 text-blue-700' },
  'user.deactivated': { labelKey: 'audit.actions.deactivated', color: 'bg-red-100 text-red-700' },
  'user.reactivated': { labelKey: 'audit.actions.reactivated', color: 'bg-green-100 text-green-700' },
  'channel.archived': { labelKey: 'audit.actions.archived', color: 'bg-amber-100 text-amber-700' },
  'channel.unarchived': { labelKey: 'audit.actions.unarchived', color: 'bg-green-100 text-green-700' },
  'channel.deleted': { labelKey: 'audit.actions.deleted', color: 'bg-red-100 text-red-700' },
  'channel.edited': { labelKey: 'audit.actions.edited', color: 'bg-blue-100 text-blue-700' },
  'invite.created': { labelKey: 'audit.actions.created', color: 'bg-green-100 text-green-700' },
  'invite.deleted': { labelKey: 'audit.actions.deleted', color: 'bg-red-100 text-red-700' },
};

function getActionInfo(action: string) {
  return ACTION_LABELS[action] || { labelKey: null, color: 'bg-gray-100 text-gray-600' };
}

const TARGET_LABEL_KEYS: Record<string, string> = {
  user: 'audit.targets.user',
  channel: 'audit.targets.channel',
  invite: 'audit.targets.invite',
};

export function AdminAuditLogTab() {
  const { t } = useTranslation('admin');
  const { auditLog, auditLogTotal, fetchAuditLog } = useAdminStore();

  useEffect(() => {
    fetchAuditLog();
  }, [fetchAuditLog]);

  if (auditLog.length === 0) {
    return (
      <div className="text-center text-sm text-slack-hint py-8">
        {t('audit.empty')}
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs text-slack-hint mb-3">
        {t('audit.showing', { shown: auditLog.length, total: auditLogTotal })}
      </div>

      <div className="space-y-1">
        {auditLog.map((entry) => {
          const actionInfo = getActionInfo(entry.action);
          return (
            <div
              key={entry.id}
              className="flex items-start gap-3 rounded-lg p-3 hover:bg-gray-50/50 border-b border-slack-border last:border-b-0"
            >
              <Avatar
                src={entry.actor.avatar ?? undefined}
                alt={entry.actor.name}
                fallback={entry.actor.name}
                size="sm"
                className="mt-0.5 flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-slack-primary">
                    {entry.actor.name}
                  </span>
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${actionInfo.color}`}>
                    {actionInfo.labelKey ? t(actionInfo.labelKey) : entry.action}
                  </span>
                  <span className="text-[12px] text-slack-hint">
                    {TARGET_LABEL_KEYS[entry.targetType] ? t(TARGET_LABEL_KEYS[entry.targetType]) : entry.targetType}
                    {entry.targetName && (
                      <span className="ms-1 font-medium text-slack-secondary">
                        {entry.targetType === 'channel' ? '#' : ''}{entry.targetName}
                      </span>
                    )}
                  </span>
                </div>
                {entry.details && (
                  <p className="text-[12px] text-slack-secondary mt-0.5">{entry.details}</p>
                )}
                <span className="text-[11px] text-slack-hint">
                  {formatDateTime(entry.createdAt, DATE_TIME_MEDIUM)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {auditLogTotal > auditLog.length && (
        <button
          onClick={() => fetchAuditLog(50, auditLog.length)}
          className="mt-4 w-full rounded-lg border border-slack-border py-2 text-sm text-slack-secondary hover:bg-gray-50"
        >
          {t('audit.loadMore')}
        </button>
      )}
    </div>
  );
}
