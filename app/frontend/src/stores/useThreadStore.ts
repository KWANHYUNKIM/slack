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
  /** /threads 화면이 열려 있는지. 닫혀 있으면 소켓 이벤트로 목록을 다시 불러오지 않는다. */
  isActive: boolean;

  /** 화면을 열고 닫을 때 부른다. 닫으면 목록 상태를 비운다(다음에 열 때 새로 불러온다). */
  setActive: (active: boolean) => void;
  /** 앞쪽 한 페이지를 다시 받아 이미 불러온 항목에 합친다(덮어쓰지 않고 바뀐 항목만 갱신, 새 항목은 맨 앞). */
  refreshHead: () => Promise<void>;

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
  isActive: false,

  setActive: (active) => {
    set(active ? { isActive: true } : { isActive: false, items: [], nextCursor: null, isLoading: false, isLoadingMore: false, loadError: false });
  },

  refreshHead: async () => {
    try {
      const data = await api.getThreads();
      if (!get().isActive) return;
      set((s) => {
        const fresh = new Map(data.items.map((i) => [i.parent.id, i]));
        const kept = s.items.filter((i) => !fresh.has(i.parent.id));
        // 마지막 활동 순서를 지키려고 새로 받은 항목을 앞에 두고 나머지는 기존 순서로 이어 붙인다
        return { items: [...data.items, ...kept] };
      });
    } catch {
      // 실패해도 이미 보이는 목록은 유지한다
    }
  },

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
    // 배지는 항상 unread-count로만 맞춘다. 목록은 화면이 열려 있을 때만 건드린다.
    const onUpdated = () => {
      void get().fetchUnreadCount();
      if (get().isActive) void get().refreshHead();
    };
    // 읽음은 이 탭에서 이미 반영했거나 다른 탭에서 한 것이다. 목록을 다시 받지 않고 해당 카드만 읽음으로 바꾼다.
    const onRead = (data: { parentId: number }) => {
      set((s) => ({ items: s.items.map((i) => (i.parent.id === data.parentId ? { ...i, unreadCount: 0 } : i)) }));
      void get().fetchUnreadCount();
    };
    socket.on('thread:updated', onUpdated);
    socket.on('thread:read', onRead);
    return () => {
      socket.off('thread:updated', onUpdated);
      socket.off('thread:read', onRead);
    };
  },
}));
