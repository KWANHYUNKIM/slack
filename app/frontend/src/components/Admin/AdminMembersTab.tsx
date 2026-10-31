import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { useAdminStore } from '@/stores/useAdminStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { Avatar } from '@/components/ui/avatar';
import { ConfirmDialog } from './ConfirmDialog';

const ROLE_BADGE: Record<string, { labelKey: string; className: string }> = {
  OWNER: { labelKey: 'members.roles.owner', className: 'bg-amber-100 text-amber-700' },
  ADMIN: { labelKey: 'members.roles.admin', className: 'bg-purple-100 text-purple-700' },
  MEMBER: { labelKey: 'members.roles.member', className: 'bg-blue-100 text-blue-700' },
  GUEST: { labelKey: 'members.roles.guest', className: 'bg-gray-100 text-gray-600' },
};

export function AdminMembersTab() {
  const { t } = useTranslation('admin');
  const { users, updateUserRole, deactivateUser, reactivateUser, transferOwnership } = useAdminStore();
  const currentUser = useAuthStore((s) => s.user);
  const [search, setSearch] = useState('');
  const [confirmAction, setConfirmAction] = useState<{
    type: 'deactivate' | 'reactivate' | 'transfer';
    userId: number;
    userName: string;
  } | null>(null);

  const isOwner = currentUser?.role === 'OWNER';

  const filtered = users.filter(
    (u) =>
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
  );

  const getRoleOptions = () => {
    if (isOwner) {
      return ['ADMIN', 'MEMBER', 'GUEST'] as const;
    }
    return ['MEMBER', 'GUEST'] as const;
  };

  const canModify = (userRole: string, userId: number) => {
    if (userId === currentUser?.id) return false;
    if (userRole === 'OWNER') return false;
    if (isOwner) return true;
    if (userRole === 'ADMIN') return false;
    return true;
  };

  return (
    <div>
      <div className="mb-4 relative">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slack-hint" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('members.searchPlaceholder')}
          aria-label={t('members.searchPlaceholder')}
          className="w-full rounded-lg border border-slack-border ps-10 pe-4 py-2 text-sm focus:border-slack-focus focus:outline-none focus:ring-1 focus:ring-slack-focus"
        />
      </div>

      <div className="rounded-lg border border-slack-border overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="bg-gray-50 border-b border-slack-border">
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('members.columns.user')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('members.columns.email')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('members.columns.role')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('members.columns.status')}</th>
              <th className="text-end px-4 py-2.5 font-medium text-slack-secondary">{t('members.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((user) => {
              const isMe = user.id === currentUser?.id;
              const isDeactivated = !!user.deactivatedAt;
              const badge = ROLE_BADGE[user.role] || ROLE_BADGE.MEMBER;
              const modifiable = canModify(user.role, user.id);

              return (
                <tr key={user.id} className="border-b border-slack-border last:border-b-0 hover:bg-gray-50/50">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <Avatar src={user.avatar} alt={user.name} fallback={user.name} size="sm" />
                      <span className="font-medium text-slack-primary">
                        {user.name}
                        {isMe && <span className="ms-1 text-slack-hint text-xs">{t('members.you')}</span>}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slack-secondary">{user.email}</td>
                  <td className="px-4 py-2.5">
                    {!modifiable ? (
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
                        {t(badge.labelKey)}
                      </span>
                    ) : (
                      <select
                        value={user.role}
                        onChange={(e) => updateUserRole(user.id, e.target.value as 'ADMIN' | 'MEMBER' | 'GUEST')}
                        className="rounded border border-slack-border px-2 py-1 text-xs focus:border-slack-focus focus:outline-none"
                      >
                        {getRoleOptions().map((r) => (
                          <option key={r} value={r}>{t(ROLE_BADGE[r].labelKey)}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      isDeactivated ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                    }`}>
                      {isDeactivated ? t('members.status.deactivated') : t('members.status.active')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    <div className="flex items-center justify-end gap-2">
                      {isOwner && !isMe && user.role !== 'OWNER' && !isDeactivated && (
                        <button
                          onClick={() => setConfirmAction({ type: 'transfer', userId: user.id, userName: user.name })}
                          className="text-xs font-medium text-amber-600 hover:text-amber-700"
                        >
                          {t('members.actions.transfer')}
                        </button>
                      )}
                      {modifiable && (
                        isDeactivated ? (
                          <button
                            onClick={() => setConfirmAction({ type: 'reactivate', userId: user.id, userName: user.name })}
                            className="text-xs font-medium text-green-600 hover:text-green-700"
                          >
                            {t('members.actions.reactivate')}
                          </button>
                        ) : (
                          <button
                            onClick={() => setConfirmAction({ type: 'deactivate', userId: user.id, userName: user.name })}
                            className="text-xs font-medium text-red-600 hover:text-red-700"
                          >
                            {t('members.actions.deactivate')}
                          </button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slack-hint">{t('members.empty')}</div>
        )}
      </div>

      {confirmAction && (
        <ConfirmDialog
          title={t(`members.dialogs.${confirmAction.type}.title`)}
          message={t(`members.dialogs.${confirmAction.type}.message`, { name: confirmAction.userName })}
          confirmLabel={t(`members.dialogs.${confirmAction.type}.confirm`)}
          onConfirm={() => {
            if (confirmAction.type === 'transfer') {
              transferOwnership(confirmAction.userId);
            } else if (confirmAction.type === 'deactivate') {
              deactivateUser(confirmAction.userId);
            } else {
              reactivateUser(confirmAction.userId);
            }
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
