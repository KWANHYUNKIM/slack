import { useState, useEffect, useRef } from 'react';
import { UserPlus, X } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { getChannelMembers, getUsers, addChannelMember, getChannel, type ChannelMember, type AuthUser } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { ProfileModal } from '@/components/ProfileModal';
import { PanelHeader } from './PanelHeader';
import { useChannelStore } from '@/stores/useChannelStore';
import { useAdminStore } from '@/stores/useAdminStore';
import { useAuthStore } from '@/stores/useAuthStore';

interface MembersPanelProps {
  channelId: number;
  onClose: () => void;
}

export function MembersPanel({ channelId, onClose }: MembersPanelProps) {
  const { user: currentUser } = useAuthStore();
  const channelStoreRemove = useChannelStore((s) => s.removeChannelMember);
  const adminStoreRemove = useAdminStore((s) => s.removeChannelMember);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [profileUserId, setProfileUserId] = useState<number | null>(null);
  const [channelCreatorId, setChannelCreatorId] = useState<number | null>(null);
  const [currentUserChannelRole, setCurrentUserChannelRole] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ userId: number; userName: string } | null>(null);
  const [removing, setRemoving] = useState(false);

  const fetchMembers = () => {
    setIsLoading(true);
    getChannelMembers(channelId)
      .then((data) => {
        setMembers(data);
        setLoadError(null);
        // Sync badge count with actual member list
        useChannelStore.getState().updateMemberCount(channelId, data.length);
      })
      .catch(() => setLoadError('Failed to load members.'))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    fetchMembers();
    // Fetch channel details to get creator and current user's role
    getChannel(channelId).then((channel) => {
      setChannelCreatorId(channel.createdBy ?? null);
      const currentMember = channel.members.find((m) => m.userId === currentUser?.id);
      setCurrentUserChannelRole(currentMember?.role ?? null);
    }).catch(() => {
      // Ignore error, user may not have access
    });
  }, [channelId, currentUser?.id]);

  // Listen for real-time presence updates
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handlePresenceUpdate = (data: { userId: number; status: string }) => {
      setMembers((prev) =>
        prev.map((m) =>
          m.user.id === data.userId
            ? {
                ...m,
                user: {
                  ...m.user,
                  status: data.status,
                  isOnline: data.status === 'online',
                },
              }
            : m
        )
      );
    };

    socket.on('presence:update', handlePresenceUpdate);
    return () => {
      socket.off('presence:update', handlePresenceUpdate);
    };
  }, []);

  // Listen for member removal events (uses same event as voluntary leave)
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const handleMemberLeft = (data: { channelId: number; userId: number; memberCount: number }) => {
      if (data.channelId === channelId) {
        fetchMembers(); // Refresh the member list
      }
    };

    socket.on('channel:member-left', handleMemberLeft);
    return () => {
      socket.off('channel:member-left', handleMemberLeft);
    };
  }, [channelId]);

  const handleRemoveMember = async (userId: number, userName: string) => {
    setConfirmRemove({ userId, userName });
  };

  const confirmRemoveMember = async () => {
    if (!confirmRemove || !currentUser) return;
    setRemoving(true);
    try {
      // Workspace admins use admin endpoint, channel owners/mods use channel endpoint
      const isWorkspaceAdmin = currentUser.role === 'ADMIN' || currentUser.role === 'OWNER';
      if (isWorkspaceAdmin) {
        await adminStoreRemove(channelId, confirmRemove.userId);
      } else {
        await channelStoreRemove(channelId, confirmRemove.userId);
      }
      setConfirmRemove(null);
      // Member list will refresh via WebSocket channel:member-left event
    } catch (error: any) {
      alert(error.message || 'Failed to remove member');
    } finally {
      setRemoving(false);
    }
  };

  // Determine if current user can remove members
  const canRemoveMembers = () => {
    if (!currentUser) return false;
    const isWorkspaceAdmin = currentUser.role === 'ADMIN' || currentUser.role === 'OWNER';
    const isChannelOwner = currentUserChannelRole === 'OWNER';
    const isChannelModerator = currentUserChannelRole === 'MODERATOR';
    return isWorkspaceAdmin || isChannelOwner || isChannelModerator;
  };

  // Check if a specific member can be removed by current user
  const canRemoveMember = (member: ChannelMember) => {
    if (!currentUser || !canRemoveMembers()) return false;
    if (member.user.id === currentUser.id) return false; // Cannot remove self
    if (member.user.id === channelCreatorId) return false; // Cannot remove creator

    const isWorkspaceAdmin = currentUser.role === 'ADMIN' || currentUser.role === 'OWNER';
    const isChannelOwner = currentUserChannelRole === 'OWNER';
    const isChannelModerator = currentUserChannelRole === 'MODERATOR';

    // Workspace admins and channel owners can remove anyone (except creator)
    if (isWorkspaceAdmin || isChannelOwner) return true;

    // Moderators can only remove regular members
    if (isChannelModerator) {
      return member.channelRole === 'MEMBER' || !member.channelRole;
    }

    return false;
  };

  const onlineMembers = members.filter((m) => m.user.isOnline);
  const offlineMembers = members.filter((m) => !m.user.isOnline);
  const memberUserIds = new Set(members.map((m) => m.user.id));

  return (
    <div
      data-testid="members-panel"
      className="flex w-full md:w-[260px] flex-col border-l border-slack-border bg-white absolute inset-0 md:static md:inset-auto z-30 md:z-auto"
    >
      <PanelHeader title="Members" onClose={onClose} />

      <div className="flex-1 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {/* Add People button */}
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[14px] text-slack-link hover:bg-slack-hover mb-2"
        >
          <UserPlus className="h-4 w-4" />
          Add people
        </button>

        {showAddForm && (
          <AddPeopleForm
            channelId={channelId}
            memberUserIds={memberUserIds}
            onAdded={() => {
              setShowAddForm(false);
              fetchMembers();
            }}
            onCancel={() => setShowAddForm(false)}
          />
        )}

        {isLoading ? (
          <div className="text-center text-sm text-slack-hint py-4">Loading...</div>
        ) : loadError ? (
          <div className="text-center text-sm text-slack-error py-4">{loadError}</div>
        ) : (
          <>
            {onlineMembers.length > 0 && (
              <div data-testid="online-members" className="mb-4">
                <h4 className="mb-2 text-[12px] font-medium text-slack-secondary uppercase tracking-wide">
                  Online — {onlineMembers.length}
                </h4>
                {onlineMembers.map((m) => (
                  <MemberRow
                    key={m.user.id}
                    member={m}
                    onClick={() => setProfileUserId(m.user.id)}
                    onRemove={canRemoveMember(m) ? () => handleRemoveMember(m.user.id, m.user.name) : undefined}
                  />
                ))}
              </div>
            )}

            {offlineMembers.length > 0 && (
              <div data-testid="offline-members">
                <h4 className="mb-2 text-[12px] font-medium text-slack-secondary uppercase tracking-wide">
                  Offline — {offlineMembers.length}
                </h4>
                {offlineMembers.map((m) => (
                  <MemberRow
                    key={m.user.id}
                    member={m}
                    onClick={() => setProfileUserId(m.user.id)}
                    onRemove={canRemoveMember(m) ? () => handleRemoveMember(m.user.id, m.user.name) : undefined}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {profileUserId !== null && (
        <ProfileModal userId={profileUserId} onClose={() => setProfileUserId(null)} />
      )}
      {confirmRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold text-slack-primary mb-2">Remove member?</h3>
            <p className="text-sm text-slack-secondary mb-4">
              Remove <strong>{confirmRemove.userName}</strong> from this channel?
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmRemove(null)}
                disabled={removing}
                className="px-4 py-2 text-sm rounded bg-slack-hover hover:bg-slack-border text-slack-primary disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmRemoveMember}
                disabled={removing}
                className="px-4 py-2 text-sm rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
              >
                {removing ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddPeopleForm({
  channelId,
  memberUserIds,
  onAdded,
  onCancel,
}: {
  channelId: number;
  memberUserIds: Set<number>;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AuthUser[]>([]);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (query.length < 1) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const users = await getUsers(query);
        setResults(users.filter((u) => !memberUserIds.has(u.id)));
      } catch { /* ignore */ }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, memberUserIds]);

  const handleAdd = async (userId: number) => {
    setAdding(true);
    try {
      await addChannelMember(channelId, userId);
      onAdded();
    } catch {
      setAdding(false);
    }
  };

  return (
    <div className="mb-3 rounded border border-slack-border p-2">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name..."
        className="w-full rounded border border-slack-border px-2 py-1 text-[13px] outline-none focus:border-slack-link"
      />
      {results.length > 0 && (
        <div className="mt-1 max-h-[150px] overflow-y-auto">
          {results.map((user) => (
            <button
              key={user.id}
              disabled={adding}
              onClick={() => handleAdd(user.id)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-slack-hover disabled:opacity-50"
            >
              <Avatar
                src={user.avatar}
                alt={user.name}
                fallback={user.name}
                size="sm"
              />
              <span className="text-[13px] text-slack-primary truncate">{user.name}</span>
            </button>
          ))}
        </div>
      )}
      {query.length > 0 && results.length === 0 && (
        <div className="mt-1 text-[12px] text-slack-hint px-2">No users found</div>
      )}
      <button
        onClick={onCancel}
        className="mt-1 text-[12px] text-slack-secondary hover:underline"
      >
        Cancel
      </button>
    </div>
  );
}

const CHANNEL_ROLE_BADGE: Record<string, { label: string; className: string } | undefined> = {
  OWNER: { label: 'Owner', className: 'bg-amber-100 text-amber-700' },
  MODERATOR: { label: 'Mod', className: 'bg-indigo-100 text-indigo-700' },
};

function MemberRow({ member, onClick, onRemove }: { member: ChannelMember; onClick?: () => void; onRemove?: () => void }) {
  const roleBadge = member.channelRole ? CHANNEL_ROLE_BADGE[member.channelRole] : undefined;
  const [showRemove, setShowRemove] = useState(false);

  return (
    <div
      data-testid={`member-row-${member.user.id}`}
      className="relative group"
      onMouseEnter={() => setShowRemove(true)}
      onMouseLeave={() => setShowRemove(false)}
    >
      <button
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 hover:bg-slack-hover cursor-pointer">
        <Avatar
          src={member.user.avatar}
          alt={member.user.name}
          fallback={member.user.name}
          size="sm"
          status={member.user.isOnline ? 'online' : 'offline'}
        />
        <span className="text-[14px] text-slack-primary truncate">{member.user.name}</span>
        {roleBadge && (
          <span className={`ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${roleBadge.className}`}>
            {roleBadge.label}
          </span>
        )}
      </button>
      {onRemove && showRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-red-100 text-slack-secondary hover:text-red-600"
          title="Remove member"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
