import { create } from 'zustand';
import { t } from '@/lib/i18n';
import * as api from '@/lib/api';
import type { Channel, DirectMessage } from '@/lib/types';

export type SidebarSection = keyof api.SidebarCollapsed;

interface ChannelState {
  channels: Channel[];
  directMessages: DirectMessage[];
  activeChannelId: number | null;
  activeDMId: number | null;
  scrollToMessageId: number | null;
  dmScrollToMessageId: number | null;
  isLoading: boolean;
  loadError: string | null;
  /** Per-user collapsed state of the sidebar sections (saved on the server) */
  sidebarCollapsed: api.SidebarCollapsed;

  fetchSidebarPrefs: () => Promise<void>;
  toggleSection: (section: SidebarSection) => void;
  toggleDMStar: (userId: number) => void;
  /** Apply a channel:updated / star:updated payload from another tab or user */
  applyChannelMeta: (meta: { id: number; name: string; topic: string | null; description: string | null }) => void;
  applyStar: (target: { type: 'channel' | 'dm'; id: number; isStarred: boolean }) => void;
  updateChannelMeta: (channelId: number, data: api.ChannelMetaUpdate) => Promise<void>;
  fetchChannels: () => Promise<void>;
  fetchDirectMessages: () => Promise<void>;
  createChannel: (name: string, isPrivate?: boolean) => Promise<number>;
  joinChannel: (channelId: number) => Promise<void>;
  leaveChannel: (channelId: number) => Promise<number | null>;
  removeChannelMember: (channelId: number, userId: number) => Promise<void>;
  toggleStar: (channelId: number) => void;
  setActiveChannel: (channelId: number, scrollToMessageId?: number) => void;
  setActiveDM: (dmId: number, scrollToMessageId?: number) => void;
  startDM: (userId: number, userName: string, userAvatar?: string) => void;
  addOrUpdateDM: (userId: number, userName: string, userAvatar?: string) => void;
  updateDMUser: (userId: number, updates: Partial<Pick<DirectMessage, 'userName' | 'userAvatar'>>) => void;
  updateDMStatus: (userId: number, status: DirectMessage['userStatus']) => void;
  updateMemberCount: (channelId: number, memberCount: number) => void;
  incrementUnread: (channelId: number) => void;
  setUnreadCount: (channelId: number, count: number) => void;
  incrementDMUnread: (userId: number) => void;
  markChannelAsRead: (channelId: number) => void;
  /** Re-fetch only the mention counts (after activity read/removed events) */
  refreshMentionCounts: () => Promise<void>;
  /** Lower a channel or DM mention badge by one (an activity was read or removed) */
  decrementMention: (target: { channelId?: number; dmUserId?: number }) => void;
  /** A new mention arrived for a channel (channelId) or DM partner (dmUserId) */
  incrementMention: (target: { channelId?: number; dmUserId?: number }) => void;
  markDMAsRead: (dmId: number) => void;
  getActiveChannel: () => Channel | undefined;
  getActiveDM: () => DirectMessage | undefined;
}

export const useChannelStore = create<ChannelState>((set, get) => ({
  channels: [],
  directMessages: [],
  activeChannelId: null,
  activeDMId: null,
  scrollToMessageId: null,
  dmScrollToMessageId: null,
  isLoading: false,
  loadError: null,
  sidebarCollapsed: { starred: false, channels: false, dms: false },

  fetchSidebarPrefs: async () => {
    try {
      const { collapsed } = await api.getSidebarPrefs();
      set({ sidebarCollapsed: collapsed });
    } catch { /* Non-critical: sections stay expanded */ }
  },

  toggleSection: (section) => {
    const next = !get().sidebarCollapsed[section];
    const prev = get().sidebarCollapsed;
    set({ sidebarCollapsed: { ...prev, [section]: next } });
    api.updateSidebarPrefs({ [section]: next }).catch(() => {
      set({ sidebarCollapsed: prev });
    });
  },

  applyChannelMeta: (meta) => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === meta.id
          ? { ...ch, name: meta.name, topic: meta.topic, description: meta.description }
          : ch,
      ),
    }));
  },

  applyStar: ({ type, id, isStarred }) => {
    if (type === 'channel') {
      set((state) => ({
        channels: state.channels.map((ch) => (ch.id === id ? { ...ch, isStarred } : ch)),
      }));
    } else {
      set((state) => ({
        directMessages: state.directMessages.map((dm) => (dm.userId === id ? { ...dm, isStarred } : dm)),
      }));
    }
  },

  updateChannelMeta: async (channelId, data) => {
    const updated = await api.updateChannel(channelId, data);
    get().applyChannelMeta({
      id: channelId,
      name: updated.name,
      topic: updated.topic ?? null,
      description: updated.description ?? null,
    });
  },

  fetchDirectMessages: async () => {
    try {
      const conversations = await api.getDirectMessages();
      const dms: DirectMessage[] = conversations.filter((c) => c?.otherUser).map((c) => ({
        id: c.otherUser.id,
        userId: c.otherUser.id,
        userName: c.otherUser.name,
        userAvatar: c.otherUser.avatar || '',
        userStatus: (c.otherUser.status as DirectMessage['userStatus']) || 'offline',
        unreadCount: c.unreadCount,
        mentionCount: c.mentionCount ?? 0,
        isStarred: c.isStarred ?? false,
      }));
      set({ directMessages: dms });
    } catch {
      set({ loadError: t('channels:errors.loadConversations') });
    }
  },

  fetchChannels: async () => {
    set({ isLoading: true, loadError: null });
    try {
      const apiChannels = await api.getChannels();
      const channels: Channel[] = apiChannels.map((ch) => ({
        id: ch.id,
        name: ch.name,
        isPrivate: ch.isPrivate,
        memberCount: ch._count.members,
        unreadCount: ch.unreadCount,
        mentionCount: ch.mentionCount ?? 0,
        isMember: ch.isMember,
        topic: ch.topic ?? null,
        description: ch.description ?? null,
        isStarred: ch.isStarred ?? false,
      }));
      set({
        channels,
        isLoading: false,
      });
    } catch {
      set({ isLoading: false, loadError: t('channels:errors.loadChannels') });
    }
  },

  createChannel: async (name: string, isPrivate = false) => {
    try {
      const ch = await api.createChannel(name, isPrivate);
      const channel: Channel = {
        id: ch.id,
        name: ch.name,
        isPrivate: ch.isPrivate,
        memberCount: ch._count?.members ?? 1,
        unreadCount: 0,
        mentionCount: 0,
        isMember: true,
      };
      set((state) => ({
        channels: [...state.channels, channel],
      }));
      return channel.id;
    } catch (err) {
      console.error('Failed to create channel:', err);
      throw err;
    }
  },

  joinChannel: async (channelId: number) => {
    try {
      await api.joinChannel(channelId);
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, isMember: true, memberCount: ch.memberCount + 1 } : ch,
        ),
      }));
    } catch (err) {
      console.error('Failed to join channel:', err);
      throw err;
    }
  },

  leaveChannel: async (channelId: number) => {
    try {
      await api.leaveChannel(channelId);
      let nextChannelId: number | null = null;
      set((state) => {
        const updated = state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, isMember: false, memberCount: Math.max(0, ch.memberCount - 1) } : ch
        );
        if (state.activeChannelId === channelId) {
          nextChannelId = updated.find((ch) => ch.isMember)?.id ?? null;
        }
        return { channels: updated };
      });
      return nextChannelId;
    } catch (err) {
      console.error('Failed to leave channel:', err);
      throw err;
    }
  },

  removeChannelMember: async (channelId: number, userId: number) => {
    try {
      await api.removeChannelMember(channelId, userId);
      // Member count will be updated via WebSocket channel:member-left event
    } catch (err) {
      console.error('Failed to remove channel member:', err);
      throw err;
    }
  },

  // Optimistic: flip locally first, roll back if the server rejects it
  toggleStar: (channelId: number) => {
    const current = get().channels.find((ch) => ch.id === channelId);
    if (!current) return;
    const next = !current.isStarred;
    get().applyStar({ type: 'channel', id: channelId, isStarred: next });
    (next ? api.starChannel(channelId) : api.unstarChannel(channelId)).catch(() => {
      get().applyStar({ type: 'channel', id: channelId, isStarred: !next });
    });
  },

  toggleDMStar: (userId: number) => {
    const current = get().directMessages.find((dm) => dm.userId === userId);
    if (!current) return;
    const next = !current.isStarred;
    get().applyStar({ type: 'dm', id: userId, isStarred: next });
    (next ? api.starDM(userId) : api.unstarDM(userId)).catch(() => {
      get().applyStar({ type: 'dm', id: userId, isStarred: !next });
    });
  },

  startDM: (userId: number, userName: string, userAvatar?: string) => {
    const state = get();
    // Add to DM list if not already there
    if (!state.directMessages.find((dm) => dm.userId === userId)) {
      set({
        directMessages: [
          ...state.directMessages,
          {
            id: userId,
            userId,
            userName,
            userAvatar: userAvatar || '',
            userStatus: 'online',
            unreadCount: 0,
            mentionCount: 0,
          },
        ],
      });
    }
    set({ activeDMId: userId, activeChannelId: null });
  },

  addOrUpdateDM: (userId: number, userName: string, userAvatar?: string) => {
    const state = get();
    const existing = state.directMessages.find((dm) => dm.userId === userId);
    if (existing) return;
    set({
      directMessages: [
        ...state.directMessages,
        {
          id: userId,
          userId,
          userName,
          userAvatar: userAvatar || '',
          userStatus: 'online',
          unreadCount: 0,
          mentionCount: 0,
        },
      ],
    });
  },

  updateDMUser: (userId: number, updates: Partial<Pick<DirectMessage, 'userName' | 'userAvatar'>>) => {
    set((state) => ({
      directMessages: state.directMessages.map((dm) =>
        dm.userId === userId ? { ...dm, ...updates } : dm
      ),
    }));
  },

  updateDMStatus: (userId: number, status: DirectMessage['userStatus']) => {
    set((state) => ({
      directMessages: state.directMessages.map((dm) =>
        dm.userId === userId ? { ...dm, userStatus: status } : dm
      ),
    }));
  },

  setActiveChannel: (channelId: number, scrollToMessageId?: number) => {
    set({ activeChannelId: channelId, activeDMId: null, scrollToMessageId: scrollToMessageId ?? null });
    const channel = get().channels.find((ch) => ch.id === channelId);
    if (channel?.isMember) {
      get().markChannelAsRead(channelId);
      api.markChannelReadBaseline(channelId).catch(() => {});
    }
  },

  setActiveDM: (dmId: number, scrollToMessageId?: number) => {
    set({ activeDMId: dmId, activeChannelId: null, dmScrollToMessageId: scrollToMessageId ?? null });
    get().markDMAsRead(dmId);
  },

  updateMemberCount: (channelId: number, memberCount: number) => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === channelId ? { ...ch, memberCount } : ch,
      ),
    }));
  },

  incrementUnread: (channelId: number) => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === channelId ? { ...ch, unreadCount: ch.unreadCount + 1 } : ch,
      ),
    }));
  },

  setUnreadCount: (channelId: number, count: number) => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === channelId ? { ...ch, unreadCount: count } : ch,
      ),
    }));
  },

  incrementDMUnread: (userId: number) => {
    set((state) => ({
      directMessages: state.directMessages.map((dm) =>
        dm.userId === userId ? { ...dm, unreadCount: dm.unreadCount + 1 } : dm,
      ),
    }));
  },

  markChannelAsRead: (channelId: number) => {
    const existing = get().channels.find((ch) => ch.id === channelId);
    if (!existing || existing.unreadCount === 0) return;
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === channelId ? { ...ch, unreadCount: 0 } : ch,
      ),
    }));
  },

  refreshMentionCounts: async () => {
    try {
      // Lightweight endpoint: only counts, not the full channel and DM lists
      const counts = await api.getMentionCounts();
      set((state) => ({
        channels: state.channels.map((ch) => ({ ...ch, mentionCount: counts.channels[ch.id] ?? 0 })),
        directMessages: state.directMessages.map((dm) => ({ ...dm, mentionCount: counts.dms[dm.userId] ?? 0 })),
      }));
    } catch {
      // Badge refresh is best-effort; the next full fetch corrects it
    }
  },

  decrementMention: ({ channelId, dmUserId }) => {
    set((state) => ({
      channels: channelId === undefined ? state.channels : state.channels.map((ch) =>
        ch.id === channelId ? { ...ch, mentionCount: Math.max(0, ch.mentionCount - 1) } : ch,
      ),
      directMessages: dmUserId === undefined ? state.directMessages : state.directMessages.map((dm) =>
        dm.userId === dmUserId ? { ...dm, mentionCount: Math.max(0, dm.mentionCount - 1) } : dm,
      ),
    }));
  },

  incrementMention: ({ channelId, dmUserId }) => {
    set((state) => ({
      channels: channelId === undefined ? state.channels : state.channels.map((ch) =>
        ch.id === channelId ? { ...ch, mentionCount: ch.mentionCount + 1 } : ch,
      ),
      directMessages: dmUserId === undefined ? state.directMessages : state.directMessages.map((dm) =>
        dm.userId === dmUserId ? { ...dm, mentionCount: dm.mentionCount + 1 } : dm,
      ),
    }));
  },

  markDMAsRead: (dmId: number) => {
    set((state) => ({
      directMessages: state.directMessages.map((dm) =>
        dm.id === dmId ? { ...dm, unreadCount: 0 } : dm,
      ),
    }));
  },

  getActiveChannel: () => {
    const state = get();
    return state.channels.find((ch) => ch.id === state.activeChannelId);
  },

  getActiveDM: () => {
    const state = get();
    return state.directMessages.find((dm) => dm.id === state.activeDMId);
  },
}));
