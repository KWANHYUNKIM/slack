import { create } from 'zustand';
import type { Socket } from 'socket.io-client';
import * as api from '@/lib/api';
import type { ActivityFilter, ApiActivity } from '@/lib/api';
import { useChannelStore } from './useChannelStore';

interface ActivityState {
  filter: ActivityFilter;
  items: ApiActivity[];
  nextCursor: number | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  loadError: string | null;
  /** Unread activity total (left rail badge) */
  unreadTotal: number;
  unreadMentions: number;

  setFilter: (filter: ActivityFilter) => Promise<void>;
  fetchFirstPage: () => Promise<void>;
  fetchMore: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  markRead: (ids: number[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  /** Subscribe to activity:new / activity:read / activity:removed. Returns the unsubscribe function. */
  bindSocket: (socket: Socket) => () => void;
}

const MENTION_TYPES: ApiActivity['type'][] = ['MENTION', 'CHANNEL_MENTION', 'HERE_MENTION'];

const isMentionType = (type: ApiActivity['type']) => MENTION_TYPES.includes(type);

// Own markAllRead already updated everything locally; ignore the server echo that follows
const ECHO_GUARD_MS = 3000;
let ignoreReadEchoUntil = 0;

function badgeTarget(a: ApiActivity): { channelId?: number; dmUserId?: number; dmGroupId?: number } {
  if (a.dmGroupId) return { dmGroupId: a.dmGroupId };
  return a.dmId !== null ? { dmUserId: a.actor.id } : { channelId: a.channelId ?? undefined };
}

function matchesFilter(filter: ActivityFilter, type: ApiActivity['type']): boolean {
  if (filter === 'all') return true;
  if (filter === 'mentions') return MENTION_TYPES.includes(type);
  if (filter === 'threads') return type === 'THREAD_REPLY';
  return type === 'REACTION';
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  filter: 'all',
  items: [],
  nextCursor: null,
  isLoading: false,
  isLoadingMore: false,
  loadError: null,
  unreadTotal: 0,
  unreadMentions: 0,

  setFilter: async (filter) => {
    set({ filter, items: [], nextCursor: null, isLoadingMore: false });
    await get().fetchFirstPage();
  },

  fetchFirstPage: async () => {
    const { filter } = get();
    set({ isLoading: true, loadError: null });
    try {
      const data = await api.getActivity(filter);
      // Drop the response if the tab changed while it was in flight
      if (get().filter !== filter) return;
      set({ items: data.items, nextCursor: data.nextCursor, isLoading: false });
    } catch {
      if (get().filter !== filter) return;
      set({ isLoading: false, loadError: 'load-failed' });
    }
  },

  fetchMore: async () => {
    const { filter, nextCursor, isLoadingMore } = get();
    if (nextCursor === null || isLoadingMore) return;
    set({ isLoadingMore: true });
    try {
      const data = await api.getActivity(filter, nextCursor);
      if (get().filter !== filter) {
        // The tab changed while loading: the new tab owns the list now, so just release the flag
        set({ isLoadingMore: false });
        return;
      }
      set((s) => {
        const known = new Set(s.items.map((i) => i.id));
        return {
          items: [...s.items, ...data.items.filter((i) => !known.has(i.id))],
          nextCursor: data.nextCursor,
          isLoadingMore: false,
        };
      });
    } catch {
      set({ isLoadingMore: false });
    }
  },

  fetchUnreadCount: async () => {
    try {
      const { total, mentions } = await api.getActivityUnreadCount();
      set({ unreadTotal: total, unreadMentions: mentions });
    } catch {
      // Badge is best-effort
    }
  },

  markRead: async (ids) => {
    const unread = get().items.filter((i) => ids.includes(i.id) && !i.readAt);
    if (unread.length === 0) return;
    const now = new Date().toISOString();
    // Optimistic: mark locally first, roll back if the request fails
    const mentionsRead = unread.filter((i) => isMentionType(i.type));
    set((s) => ({
      items: s.items.map((i) => (ids.includes(i.id) && !i.readAt ? { ...i, readAt: now } : i)),
      unreadTotal: Math.max(0, s.unreadTotal - unread.length),
      unreadMentions: Math.max(0, s.unreadMentions - mentionsRead.length),
    }));
    mentionsRead.forEach((i) => useChannelStore.getState().decrementMention(badgeTarget(i)));
    try {
      await api.markActivityRead({ ids });
    } catch {
      set((s) => ({
        items: s.items.map((i) => (unread.some((u) => u.id === i.id) ? { ...i, readAt: null } : i)),
      }));
      void get().fetchUnreadCount();
      void useChannelStore.getState().refreshMentionCounts();
    }
  },

  markAllRead: async () => {
    const now = new Date().toISOString();
    ignoreReadEchoUntil = Date.now() + ECHO_GUARD_MS;
    set((s) => ({ items: s.items.map((i) => (i.readAt ? i : { ...i, readAt: now })), unreadTotal: 0, unreadMentions: 0 }));
    useChannelStore.setState((s) => ({
      channels: s.channels.map((ch) => ({ ...ch, mentionCount: 0 })),
      directMessages: s.directMessages.map((dm) => ({ ...dm, mentionCount: 0 })),
    }));
    try {
      await api.markActivityRead({ all: true });
    } catch {
      ignoreReadEchoUntil = 0;
      void get().fetchFirstPage();
      void get().fetchUnreadCount();
      void useChannelStore.getState().refreshMentionCounts();
    }
  },

  bindSocket: (socket) => {
    const handleNew = (data: { activity: ApiActivity }) => {
      const activity = data.activity;
      // Already known (duplicate delivery): nothing to count
      if (get().items.some((i) => i.id === activity.id)) return;

      // Seeing it right now (channel or DM open, window focused): it is read on arrival
      const { activeChannelId, activeDMId } = useChannelStore.getState();
      const isViewing =
        document.hasFocus() &&
        !document.hidden &&
        (activity.dmId !== null ? activeDMId === activity.actor.id : activity.channelId !== null && activeChannelId === activity.channelId);

      if (isViewing) {
        set((s) => ({
          items: matchesFilter(s.filter, activity.type)
            ? [{ ...activity, readAt: new Date().toISOString() }, ...s.items]
            : s.items,
        }));
        void api.markActivityRead({ ids: [activity.id] }).catch(() => {
          void get().fetchUnreadCount();
        });
        return;
      }

      set((s) => ({
        items: matchesFilter(s.filter, activity.type) ? [activity, ...s.items] : s.items,
        unreadTotal: s.unreadTotal + 1,
        unreadMentions: s.unreadMentions + (isMentionType(activity.type) ? 1 : 0),
      }));
      if (isMentionType(activity.type)) useChannelStore.getState().incrementMention(badgeTarget(activity));
    };

    // Other tab or server side read: update from the event's ids, no list refetch
    const handleRead = (data: { ids: number[] }) => {
      if (Date.now() < ignoreReadEchoUntil) return;
      const known = new Map(get().items.map((i) => [i.id, i]));
      // Ids already read locally (our own optimistic update) are echoes: nothing to do
      const newlyRead = data.ids.filter((id) => !known.get(id)?.readAt);
      if (newlyRead.length === 0) return;
      const knownMentions = newlyRead.map((id) => known.get(id)).filter((i): i is ApiActivity => !!i && isMentionType(i.type));
      const hasUnknown = newlyRead.some((id) => !known.has(id));
      const now = new Date().toISOString();
      set((s) => ({
        items: s.items.map((i) => (newlyRead.includes(i.id) ? { ...i, readAt: now } : i)),
        unreadTotal: Math.max(0, s.unreadTotal - newlyRead.length),
        unreadMentions: Math.max(0, s.unreadMentions - knownMentions.length),
      }));
      knownMentions.forEach((i) => useChannelStore.getState().decrementMention(badgeTarget(i)));
      // Items we never loaded: their channel is unknown, so fetch the light per-channel counts once
      if (hasUnknown) void useChannelStore.getState().refreshMentionCounts();
    };

    const handleRemoved = (data: { ids: number[] }) => {
      const known = new Map(get().items.map((i) => [i.id, i]));
      const removedKnown = data.ids.map((id) => known.get(id)).filter((i): i is ApiActivity => !!i);
      const unreadKnown = removedKnown.filter((i) => !i.readAt);
      const unreadMentions = unreadKnown.filter((i) => isMentionType(i.type));
      set((s) => ({
        items: s.items.filter((i) => !data.ids.includes(i.id)),
        unreadTotal: Math.max(0, s.unreadTotal - unreadKnown.length),
        unreadMentions: Math.max(0, s.unreadMentions - unreadMentions.length),
      }));
      unreadMentions.forEach((i) => useChannelStore.getState().decrementMention(badgeTarget(i)));
      // Ids we never loaded: whether they were unread is unknown, so ask for the totals once
      if (removedKnown.length < data.ids.length) {
        void get().fetchUnreadCount();
        void useChannelStore.getState().refreshMentionCounts();
      }
    };

    socket.on('activity:new', handleNew);
    socket.on('activity:read', handleRead);
    socket.on('activity:removed', handleRemoved);
    return () => {
      socket.off('activity:new', handleNew);
      socket.off('activity:read', handleRead);
      socket.off('activity:removed', handleRemoved);
    };
  },
}));
