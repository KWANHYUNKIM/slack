import { create } from 'zustand';
import type { Socket } from 'socket.io-client';
import * as api from '@/lib/api';
import type { ApiThreadItem } from '@/lib/api';

interface ThreadState {
  items: ApiThreadItem[];
  nextCursor: number | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  loadError: boolean;
  /** 안 읽은 답글이 있는 스레드 수(왼쪽 레일 배지) */
  unreadCount: number;

  fetchFirstPage: () => Promise<void>;
  fetchMore: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  /** 스레드를 읽음 처리한다(목록과 배지를 낙관적으로 갱신) */
  markRead: (parentId: number) => Promise<void>;
  /** thread:updated / thread:read 구독. 해제 함수를 돌려준다. */
  bindSocket: (socket: Socket) => () => void;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  items: [],
  nextCursor: null,
  isLoading: false,
  isLoadingMore: false,
  loadError: false,
  unreadCount: 0,

  fetchFirstPage: async () => {
    set({ isLoading: true, loadError: false });
    try {
      const data = await api.getThreads();
      set({ items: data.items, nextCursor: data.nextCursor ?? null, isLoading: false });
    } catch {
      set({ isLoading: false, loadError: true });
    }
  },

  fetchMore: async () => {
    const { nextCursor, isLoadingMore } = get();
    if (nextCursor === null || isLoadingMore) return;
    set({ isLoadingMore: true });
    try {
      const data = await api.getThreads(nextCursor);
      set((s) => ({
        items: [...s.items, ...data.items.filter((n) => !s.items.some((i) => i.parent.id === n.parent.id))],
        nextCursor: data.nextCursor ?? null,
        isLoadingMore: false,
      }));
    } catch {
      set({ isLoadingMore: false });
    }
  },

  fetchUnreadCount: async () => {
    try {
      const { count } = await api.getThreadUnreadCount();
      set({ unreadCount: count });
    } catch {
      // 배지는 다음 이벤트에서 다시 맞춰진다
    }
  },

  markRead: async (parentId) => {
    const item = get().items.find((i) => i.parent.id === parentId);
    if (item && item.unreadCount > 0) {
      set((s) => ({
        items: s.items.map((i) => (i.parent.id === parentId ? { ...i, unreadCount: 0 } : i)),
        unreadCount: Math.max(0, s.unreadCount - 1),
      }));
    }
    try {
      await api.markThreadRead(parentId);
    } catch {
      void get().fetchUnreadCount();
    }
  },

  bindSocket: (socket) => {
    const refresh = () => {
      void get().fetchUnreadCount();
      // 목록 화면이 열려 있을 때만 다시 불러온다(items가 비어 있어도 첫 방문 때 어차피 불러온다)
      if (get().items.length > 0 || get().isLoading) void get().fetchFirstPage();
    };
    socket.on('thread:updated', refresh);
    socket.on('thread:read', refresh);
    return () => {
      socket.off('thread:updated', refresh);
      socket.off('thread:read', refresh);
    };
  },
}));
