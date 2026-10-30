import { useState } from 'react';
import { Lock, Hash, Trash2, Archive, ArchiveRestore, Pencil, X, Check } from 'lucide-react';
import { useAdminStore } from '@/stores/useAdminStore';
import { ConfirmDialog } from './ConfirmDialog';

export function AdminChannelsTab() {
  const { channels, deleteChannel, archiveChannel, unarchiveChannel, editChannel } = useAdminStore();
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<{ id: number; name: string; archived: boolean } | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString();
  };

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
              <th className="text-left px-4 py-2.5 font-medium text-slack-secondary">Channel</th>
              <th className="text-left px-4 py-2.5 font-medium text-slack-secondary">Members</th>
              <th className="text-left px-4 py-2.5 font-medium text-slack-secondary">Messages</th>
              <th className="text-left px-4 py-2.5 font-medium text-slack-secondary">Created</th>
              <th className="text-right px-4 py-2.5 font-medium text-slack-secondary"></th>
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
                      <button onClick={saveEdit} className="text-green-600 hover:text-green-700" title="Save">
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setEditingId(null)} className="text-slack-hint hover:text-slack-primary" title="Cancel">
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
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      onClick={() => startEdit(channel)}
                      className="text-slack-hint hover:text-slack-primary"
                      title="Rename channel"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setArchiveTarget({ id: channel.id, name: channel.name, archived: false })}
                      className="text-slack-hint hover:text-amber-600"
                      title="Archive channel"
                    >
                      <Archive className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget({ id: channel.id, name: channel.name })}
                      className="text-slack-hint hover:text-red-600"
                      title="Delete channel"
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
          <div className="px-4 py-8 text-center text-sm text-slack-hint">No active channels</div>
        )}
      </div>

      {/* Archived channels */}
      {archivedChannels.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-slack-secondary mb-2 flex items-center gap-1.5">
            <Archive className="h-4 w-4" />
            Archived channels ({archivedChannels.length})
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
                        <span className="text-xs text-slack-hint ml-1">
                          archived {channel.archivedAt ? formatDate(channel.archivedAt) : ''}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-slack-secondary">{channel._count.members}</td>
                    <td className="px-4 py-2.5 text-slack-secondary">{channel._count.messages} msgs</td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setArchiveTarget({ id: channel.id, name: channel.name, archived: true })}
                          className="text-slack-hint hover:text-green-600"
                          title="Unarchive channel"
                        >
                          <ArchiveRestore className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget({ id: channel.id, name: channel.name })}
                          className="text-slack-hint hover:text-red-600"
                          title="Delete permanently"
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
          title="Delete channel"
          message={`Are you sure you want to permanently delete #${deleteTarget.name}? All messages will be lost. This can't be undone.`}
          confirmLabel="Delete"
          onConfirm={() => {
            deleteChannel(deleteTarget.id);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {archiveTarget && (
        <ConfirmDialog
          title={archiveTarget.archived ? 'Unarchive channel' : 'Archive channel'}
          message={
            archiveTarget.archived
              ? `Unarchive #${archiveTarget.name}? It will reappear in the sidebar for all members.`
              : `Archive #${archiveTarget.name}? It will be hidden from the sidebar but messages will be preserved. You can unarchive it later.`
          }
          confirmLabel={archiveTarget.archived ? 'Unarchive' : 'Archive'}
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
