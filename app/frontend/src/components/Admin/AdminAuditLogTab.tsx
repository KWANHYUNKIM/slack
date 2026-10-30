import { useEffect } from 'react';
import { format } from 'date-fns';
import { useAdminStore } from '@/stores/useAdminStore';
import { Avatar } from '@/components/ui/avatar';

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  'user.role_changed': { label: 'Role Changed', color: 'bg-blue-100 text-blue-700' },
  'user.deactivated': { label: 'Deactivated', color: 'bg-red-100 text-red-700' },
  'user.reactivated': { label: 'Reactivated', color: 'bg-green-100 text-green-700' },
  'channel.archived': { label: 'Archived', color: 'bg-amber-100 text-amber-700' },
  'channel.unarchived': { label: 'Unarchived', color: 'bg-green-100 text-green-700' },
  'channel.deleted': { label: 'Deleted', color: 'bg-red-100 text-red-700' },
  'channel.edited': { label: 'Edited', color: 'bg-blue-100 text-blue-700' },
  'invite.created': { label: 'Created', color: 'bg-green-100 text-green-700' },
  'invite.deleted': { label: 'Deleted', color: 'bg-red-100 text-red-700' },
};

function getActionInfo(action: string) {
  return ACTION_LABELS[action] || { label: action, color: 'bg-gray-100 text-gray-600' };
}

function getTargetIcon(targetType: string) {
  switch (targetType) {
    case 'user': return 'User';
    case 'channel': return 'Channel';
    case 'invite': return 'Invite';
    default: return targetType;
  }
}

export function AdminAuditLogTab() {
  const { auditLog, auditLogTotal, fetchAuditLog } = useAdminStore();

  useEffect(() => {
    fetchAuditLog();
  }, [fetchAuditLog]);

  if (auditLog.length === 0) {
    return (
      <div className="text-center text-sm text-slack-hint py-8">
        No audit log entries yet. Admin actions will be recorded here.
      </div>
    );
  }

  return (
    <div>
      <div className="text-xs text-slack-hint mb-3">
        Showing {auditLog.length} of {auditLogTotal} entries
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
                    {actionInfo.label}
                  </span>
                  <span className="text-[12px] text-slack-hint">
                    {getTargetIcon(entry.targetType)}
                    {entry.targetName && (
                      <span className="ml-1 font-medium text-slack-secondary">
                        {entry.targetType === 'channel' ? '#' : ''}{entry.targetName}
                      </span>
                    )}
                  </span>
                </div>
                {entry.details && (
                  <p className="text-[12px] text-slack-secondary mt-0.5">{entry.details}</p>
                )}
                <span className="text-[11px] text-slack-hint">
                  {format(new Date(entry.createdAt), 'MMM d, yyyy h:mm a')}
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
          Load more
        </button>
      )}
    </div>
  );
}
