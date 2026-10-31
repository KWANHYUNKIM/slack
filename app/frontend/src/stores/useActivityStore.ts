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
    set({ filter, items: [], nextCursor: null });
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
      if (get().filter !== filter) return;
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
    set((s) => ({
      items: s.items.map((i) => (ids.includes(i.id) && !i.readAt ? { ...i, readAt: now } : i)),
      unreadTotal: Math.max(0, s.unreadTotal - unread.length),
    }));
    try {
      await api.markActivityRead({ ids });
      void get().fetchUnreadCount();
    } catch {
      set((s) => ({
        items: s.items.map((i) => (unread.some((u) => u.id === i.id) ? { ...i, readAt: null } : i)),
      }));
      void get().fetchUnreadCount();
    }
  },

  markAllRead: async () => {
    const now = new Date().toISOString();
    set((s) => ({ items: s.items.map((i) => (i.readAt ? i : { ...i, readAt: now })), unreadTotal: 0, unreadMentions: 0 }));
    try {
      await api.markActivityRead({ all: true });
    } catch {
      void get().fetchFirstPage();
    }
    void get().fetchUnreadCount();
    void useChannelStore.getState().refreshMentionCounts();
  },

  bindSocket: (socket) => {
    const handleNew = (data: { activity: ApiActivity }) => {
      const activity = data.activity;
      set((s) => {
        const isNew = !s.items.some((i) => i.id === activity.id);
        return {
          items: isNew && matchesFilter(s.filter, activity.type) ? [activity, ...s.items] : s.items,
          unreadTotal: s.unreadTotal + 1,
          unreadMentions: s.unreadMentions + (MENTION_TYPES.includes(activity.type) ? 1 : 0),
        };
      });
      if (MENTION_TYPES.includes(activity.type)) {
        // DM mentions come from the partner; channel mentions carry the channel id
        useChannelStore.getState().incrementMention(
          activity.dmId !== null ? { dmUserId: activity.actor.id } : { channelId: activity.channelId ?? undefined },
        );
      }
    };

    const handleRead = (data: { ids: number[] }) => {
      const now = new Date().toISOString();
      set((s) => ({ items: s.items.map((i) => (data.ids.includes(i.id) && !i.readAt ? { ...i, readAt: now } : i)) }));
      void get().fetchUnreadCount();
      void useChannelStore.getState().refreshMentionCounts();
    };

    const handleRemoved = (data: { ids: number[] }) => {
      set((s) => ({ items: s.items.filter((i) => !data.ids.includes(i.id)) }));
      void get().fetchUnreadCount();
      void useChannelStore.getState().refreshMentionCounts();
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
