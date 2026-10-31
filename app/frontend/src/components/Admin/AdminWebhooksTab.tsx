import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Trash2, Check } from 'lucide-react';
import { useAdminStore } from '@/stores/useAdminStore';
import { formatDate, formatRelative } from '@/lib/i18n/format';

export function AdminWebhooksTab() {
  const { t } = useTranslation('admin');
  const { webhooks, channels, createWebhook, deleteWebhook } = useAdminStore();
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const handleCreate = async () => {
    if (!name || !channelId) return;
    await createWebhook({
      name,
      channelId: parseInt(channelId),
    });
    setName('');
    setChannelId('');
  };

  const copyUrl = (token: string, id: number) => {
    const url = `${window.location.protocol}//${window.location.host}/webhooks/${token}`;
    navigator.clipboard.writeText(url);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatLastUsed = (lastUsedAt: string | null) => {
    if (!lastUsedAt) return t('webhooks.never');
    const date = new Date(lastUsedAt);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return t('webhooks.justNow');
    if (days < 30) return formatRelative(date, now);
    return formatDate(date);
  };

  const activeChannels = channels.filter((c) => !c.archivedAt);

  return (
    <div>
      {/* Create Form */}
      <div className="mb-6 rounded-lg border border-slack-border p-4">
        <h3 className="text-sm font-semibold text-slack-primary mb-3">{t('webhooks.createHeading')}</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-slack-secondary mb-1">{t('webhooks.fields.name')}</label>
            <input
              type="text"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('webhooks.namePlaceholder')}
              className="w-48 rounded border border-slack-border px-3 py-1.5 text-sm focus:border-slack-focus focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-slack-secondary mb-1">{t('webhooks.fields.channel')}</label>
            <select
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              className="w-48 rounded border border-slack-border px-3 py-1.5 text-sm focus:border-slack-focus focus:outline-none"
            >
              <option value="">{t('webhooks.selectChannel')}</option>
              {activeChannels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  # {channel.name}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleCreate}
            disabled={!name || !channelId}
            className="rounded-lg bg-slack-btn px-4 py-1.5 text-sm font-medium text-white hover:bg-slack-btn-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('common:actions.create')}
          </button>
        </div>
      </div>

      {/* Webhook List */}
      <div className="rounded-lg border border-slack-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-slack-border">
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('webhooks.columns.name')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('webhooks.fields.channel')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('webhooks.columns.url')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('webhooks.columns.lastUsed')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('members.columns.status')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('invites.columns.createdBy')}</th>
              <th className="text-end px-4 py-2.5 font-medium text-slack-secondary"></th>
            </tr>
          </thead>
          <tbody>
            {webhooks.map((webhook) => (
              <tr key={webhook.id} className="border-b border-slack-border last:border-b-0 hover:bg-gray-50/50">
                <td className="px-4 py-2.5 font-medium text-slack-primary">{webhook.name}</td>
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1 text-slack-secondary">
                    <span className="text-slack-hint">#</span>
                    {webhook.channel.name}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <code className="text-xs bg-gray-100 rounded px-1.5 py-0.5 max-w-[200px] truncate">
                      {webhook.token.slice(0, 16)}...
                    </code>
                    <button
                      onClick={() => copyUrl(webhook.token, webhook.id)}
                      className="text-slack-hint hover:text-slack-primary"
                      title={t('webhooks.copyUrl')} aria-label={t('webhooks.copyUrl')}
                    >
                      {copiedId === webhook.id ? (
                        <Check className="h-3.5 w-3.5 text-green-600" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-slack-secondary">
                  {formatLastUsed(webhook.lastUsedAt)}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      webhook.isActive
                        ? 'bg-green-100 text-green-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}
                  >
                    {webhook.isActive ? t('members.status.active') : t('webhooks.inactive')}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-slack-secondary">{webhook.creator.name}</td>
                <td className="px-4 py-2.5 text-end">
                  <button
                    onClick={() => deleteWebhook(webhook.id)}
                    className="text-slack-hint hover:text-red-600"
                    title={t('webhooks.delete')} aria-label={t('webhooks.delete')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {webhooks.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slack-hint">{t('webhooks.empty')}</div>
        )}
      </div>
    </div>
  );
}
