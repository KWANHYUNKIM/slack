import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Trash2, Check } from 'lucide-react';
import { useAdminStore } from '@/stores/useAdminStore';
import { formatDate } from '@/lib/i18n/format';
import { useAdminAction } from '@/hooks/useAdminAction';

const ROLE_BADGE: Record<string, { labelKey: string; className: string }> = {
  ADMIN: { labelKey: 'members.roles.admin', className: 'bg-purple-100 text-purple-700' },
  MEMBER: { labelKey: 'members.roles.member', className: 'bg-blue-100 text-blue-700' },
  GUEST: { labelKey: 'members.roles.guest', className: 'bg-gray-100 text-gray-600' },
};

const EXPIRY_OPTIONS = [
  { labelKey: 'invites.expiry.1d', value: '1d' },
  { labelKey: 'invites.expiry.7d', value: '7d' },
  { labelKey: 'invites.expiry.30d', value: '30d' },
  { labelKey: 'invites.expiry.never', value: 'never' },
];

function getExpiresAt(value: string): string | null {
  if (value === 'never') return null;
  const days = parseInt(value);
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

export function AdminInvitesTab() {
  const { t } = useTranslation('admin');
  const { invites, createInvite, deleteInvite } = useAdminStore();
  const [role, setRole] = useState<'MEMBER' | 'GUEST'>('MEMBER');
  const [maxUses, setMaxUses] = useState('');
  const [expiry, setExpiry] = useState('7d');
  const [copiedId, setCopiedId] = useState<number | null>(null);
  // 만들기와 삭제는 인스턴스를 나눈다. 만들기는 진행 중에 다시 누르지 못하게 busy로 막는다.
  const createAction = useAdminAction('admin:errors.createInvite');
  const deleteAction = useAdminAction('admin:errors.deleteInvite');

  const handleCreate = () => {
    void createAction.run(() => createInvite({
      role,
      maxUses: maxUses ? parseInt(maxUses) : null,
      expiresAt: getExpiresAt(expiry),
    }));
  };

  const handleDelete = (inviteId: number) => {
    void deleteAction.run(() => deleteInvite(inviteId));
  };

  const copyUrl = (code: string, id: number) => {
    const url = `${window.location.origin}/register?invite=${code}`;
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatExpiry = (expiresAt: string | null) => {
    if (!expiresAt) return t('invites.expiry.never');
    const date = new Date(expiresAt);
    if (date < new Date()) return t('invites.expired');
    return formatDate(date);
  };

  return (
    <div>
      {/* Create Form */}
      <div className="mb-6 rounded-lg border border-slack-border p-4">
        <h3 className="text-sm font-semibold text-slack-primary mb-3">{t('invites.createHeading')}</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-slack-secondary mb-1">{t('invites.fields.role')}</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'MEMBER' | 'GUEST')}
              className="rounded border border-slack-border px-3 py-1.5 text-sm focus:border-slack-focus focus:outline-none"
            >
              <option value="MEMBER">{t('members.roles.member')}</option>
              <option value="GUEST">{t('members.roles.guest')}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slack-secondary mb-1">{t('invites.fields.maxUses')}</label>
            <input
              type="number"
              min="1"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              placeholder={t('invites.unlimited')}
              className="w-28 rounded border border-slack-border px-3 py-1.5 text-sm focus:border-slack-focus focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-slack-secondary mb-1">{t('invites.fields.expiresIn')}</label>
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="rounded border border-slack-border px-3 py-1.5 text-sm focus:border-slack-focus focus:outline-none"
            >
              {EXPIRY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
              ))}
            </select>
          </div>
          <button
            onClick={handleCreate}
            disabled={createAction.busy}
            className="rounded-lg bg-slack-btn px-4 py-1.5 text-sm font-medium text-white hover:bg-slack-btn-hover"
          >
            {t('common:actions.create')}
          </button>
        </div>
      </div>

      {createAction.error && (
        <p role="alert" className="mb-3 text-sm text-slack-error">{createAction.error}</p>
      )}
      {deleteAction.error && (
        <p role="alert" className="mb-3 text-sm text-slack-error">{deleteAction.error}</p>
      )}

      {/* Invite List */}
      <div className="rounded-lg border border-slack-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-slack-border">
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('invites.columns.url')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('invites.fields.role')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('invites.columns.uses')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('invites.columns.expires')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('invites.columns.createdBy')}</th>
              <th className="text-end px-4 py-2.5 font-medium text-slack-secondary"></th>
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => {
              const badge = ROLE_BADGE[invite.role] || ROLE_BADGE.MEMBER;
              const isExpired = invite.expiresAt && new Date(invite.expiresAt) < new Date();
              const isExhausted = invite.maxUses !== null && invite.useCount >= invite.maxUses;

              return (
                <tr key={invite.id} className="border-b border-slack-border last:border-b-0 hover:bg-gray-50/50">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <code className="text-xs bg-gray-100 rounded px-1.5 py-0.5 max-w-[200px] truncate">
                        {invite.code.slice(0, 16)}...
                      </code>
                      <button
                        onClick={() => copyUrl(invite.code, invite.id)}
                        className="text-slack-hint hover:text-slack-primary"
                        title={t('invites.copyUrl')} aria-label={t('invites.copyUrl')}
                      >
                        {copiedId === invite.id ? (
                          <Check className="h-3.5 w-3.5 text-green-600" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
                      {t(badge.labelKey)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slack-secondary">
                    {invite.useCount}{invite.maxUses !== null ? ` / ${invite.maxUses}` : ''}
                    {isExhausted && <span className="ms-1 text-red-500 text-xs">{t('invites.full')}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-slack-secondary">
                    <span className={isExpired ? 'text-red-500' : ''}>
                      {formatExpiry(invite.expiresAt)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slack-secondary">{invite.creator.name}</td>
                  <td className="px-4 py-2.5 text-end">
                    <button
                      onClick={() => handleDelete(invite.id)}
                      className="text-slack-hint hover:text-red-600"
                      title={t('invites.delete')} aria-label={t('invites.delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {invites.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slack-hint">{t('invites.empty')}</div>
        )}
      </div>
    </div>
  );
}
