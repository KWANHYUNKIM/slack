import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Hash, Trash2, Archive, ArchiveRestore, Pencil, X, Check } from 'lucide-react';
import { useAdminStore } from '@/stores/useAdminStore';
import { formatDate } from '@/lib/i18n/format';
import { ConfirmDialog } from './ConfirmDialog';

export function AdminChannelsTab() {
  const { t } = useTranslation('admin');
  const { channels, deleteChannel, archiveChannel, unarchiveChannel, editChannel } = useAdminStore();
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<{ id: number; name: string; archived: boolean } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  const startEdit = (channel: { id: number; name: string }) => {
    setEditingId(channel.id);
    setEditName(channel.name);
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    const channel = channels.find((c) => c.id === editingId);
    if (channel && editName.trim() !== channel.name) {
      await editChannel(editingId, { name: editName.trim().toLowerCase() });
    }
    setEditingId(null);
  };

  const activeChannels = channels.filter((c) => !c.archivedAt);
  const archivedChannels = channels.filter((c) => !!c.archivedAt);

  return (
    <div>
      {/* Active channels */}
      <div className="rounded-lg border border-slack-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-slack-border">
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('channels.columns.channel')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('channels.columns.members')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('channels.columns.messages')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('channels.columns.created')}</th>
              <th className="text-end px-4 py-2.5 font-medium text-slack-secondary"></th>
            </tr>
          </thead>
          <tbody>
            {activeChannels.map((channel) => (
              <tr key={channel.id} className="border-b border-slack-border last:border-b-0 hover:bg-gray-50/50">
                <td className="px-4 py-2.5">
                  {editingId === channel.id ? (
                    <div className="flex items-center gap-1.5">
                      {channel.isPrivate ? (
                        <Lock className="h-3.5 w-3.5 text-slack-hint flex-shrink-0" />
                      ) : (
                        <Hash className="h-3.5 w-3.5 text-slack-hint flex-shrink-0" />
                      )}
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEdit();
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="w-full rounded border border-slack-focus px-1.5 py-0.5 text-sm font-medium focus:outline-none"
                        autoFocus
                      />
                      <button onClick={saveEdit} className="text-green-600 hover:text-green-700" title={t('common:actions.save')} aria-label={t('common:actions.save')}>
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setEditingId(null)} className="text-slack-hint hover:text-slack-primary" title={t('common:actions.cancel')} aria-label={t('common:actions.cancel')}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      {channel.isPrivate ? (
                        <Lock className="h-3.5 w-3.5 text-slack-hint" />
                      ) : (
                        <Hash className="h-3.5 w-3.5 text-slack-hint" />
                      )}
                      <span className="font-medium text-slack-primary">{channel.name}</span>
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-slack-secondary">{channel._count.members}</td>
                <td className="px-4 py-2.5 text-slack-secondary">{channel._count.messages}</td>
                <td className="px-4 py-2.5 text-slack-secondary">{formatDate(channel.createdAt)}</td>
                <td className="px-4 py-2.5 text-end">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => startEdit(channel)}
                      className="text-slack-hint hover:text-slack-primary"
                      title={t('channels.actions.rename')} aria-label={t('channels.actions.rename')}
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setArchiveTarget({ id: channel.id, name: channel.name, archived: false })}
                      className="text-slack-hint hover:text-amber-600"
                      title={t('channels.actions.archive')} aria-label={t('channels.actions.archive')}
                    >
                      <Archive className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget({ id: channel.id, name: channel.name })}
                      className="text-slack-hint hover:text-red-600"
                      title={t('channels.actions.delete')} aria-label={t('channels.actions.delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {activeChannels.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slack-hint">{t('channels.emptyActive')}</div>
        )}
      </div>

      {/* Archived channels */}
      {archivedChannels.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-slack-secondary mb-2 flex items-center gap-1.5">
            <Archive className="h-4 w-4" />
            {t('channels.archivedHeading', { count: archivedChannels.length })}
          </h3>
          <div className="rounded-lg border border-slack-border overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {archivedChannels.map((channel) => (
                  <tr key={channel.id} className="border-b border-slack-border last:border-b-0 hover:bg-gray-50/50">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {channel.isPrivate ? (
                          <Lock className="h-3.5 w-3.5 text-slack-hint" />
                        ) : (
                          <Hash className="h-3.5 w-3.5 text-slack-hint" />
                        )}
                        <span className="font-medium text-slack-hint line-through">{channel.name}</span>
                        <span className="text-xs text-slack-hint ms-1">
                          {t('channels.archivedOn', { date: channel.archivedAt ? formatDate(channel.archivedAt) : '' })}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-slack-secondary">{channel._count.members}</td>
                    <td className="px-4 py-2.5 text-slack-secondary">{t('channels.messageCount', { count: channel._count.messages })}</td>
                    <td className="px-4 py-2.5 text-end">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setArchiveTarget({ id: channel.id, name: channel.name, archived: true })}
                          className="text-slack-hint hover:text-green-600"
                          title={t('channels.actions.unarchive')} aria-label={t('channels.actions.unarchive')}
                        >
                          <ArchiveRestore className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget({ id: channel.id, name: channel.name })}
                          className="text-slack-hint hover:text-red-600"
                          title={t('channels.actions.deletePermanently')} aria-label={t('channels.actions.deletePermanently')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t('channels.deleteDialog.title')}
          message={t('channels.deleteDialog.message', { name: deleteTarget.name })}
          confirmLabel={t('common:actions.delete')}
          onConfirm={() => {
            deleteChannel(deleteTarget.id);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {archiveTarget && (
        <ConfirmDialog
          title={archiveTarget.archived ? t('channels.unarchiveDialog.title') : t('channels.archiveDialog.title')}
          message={
            archiveTarget.archived
              ? t('channels.unarchiveDialog.message', { name: archiveTarget.name })
              : t('channels.archiveDialog.message', { name: archiveTarget.name })
          }
          confirmLabel={archiveTarget.archived ? t('channels.unarchiveDialog.confirm') : t('channels.archiveDialog.confirm')}
          onConfirm={() => {
            if (archiveTarget.archived) {
              unarchiveChannel(archiveTarget.id);
            } else {
              archiveChannel(archiveTarget.id);
            }
            setArchiveTarget(null);
          }}
          onCancel={() => setArchiveTarget(null)}
        />
      )}
    </div>
  );
}
