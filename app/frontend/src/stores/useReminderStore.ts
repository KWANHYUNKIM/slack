import { create } from 'zustand';
import type { Socket } from 'socket.io-client';
import * as api from '@/lib/api';
import type { ApiReminder } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useToastStore } from './useToastStore';

type Tab = 'pending' | 'done';

interface ReminderState {
  tab: Tab;
  items: ApiReminder[];
  isLoading: boolean;
  isLoadingMore: boolean;
  loadError: boolean;
  /** 완료 목록의 다음 페이지 cursor (미완료 목록은 항상 전부 받는다) */
  nextCursor: number | null;

  setTab: (tab: Tab) => Promise<void>;
  fetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
  /** notify: false이면 성공 토스트를 띄우지 않는다(/remind처럼 호출한 쪽이 피드백을 직접 보일 때). 실패 토스트는 항상 띄운다. */
  create: (body: { messageId?: number; dmId?: number; text?: string; remindAt: Date }, opts?: { notify?: boolean }) => Promise<boolean>;
  snooze: (id: number, remindAt: Date) => Promise<void>;
  complete: (id: number, completed?: boolean) => Promise<void>;
  remove: (id: number) => Promise<void>;
  /** Subscribe to reminder:due / reminder:updated / reminder:removed. Returns the unsubscribe function. */
  bindSocket: (socket: Socket) => () => void;
}

// 미완료는 예정 순, 완료는 최근 완료 순(서버 정렬과 같다)
function sortFor(tab: Tab, items: ApiReminder[]): ApiReminder[] {
  return [...items].sort((a, b) =>
    tab === 'pending'
      ? a.remindAt.localeCompare(b.remindAt) || a.id - b.id
      : (b.completedAt ?? '').localeCompare(a.completedAt ?? '') || b.id - a.id,
  );
}

const belongsToTab = (tab: Tab, r: ApiReminder) => (tab === 'pending' ? r.completedAt === null : r.completedAt !== null);

export const useReminderStore = create<ReminderState>((set, get) => ({
  tab: 'pending',
  items: [],
  isLoading: false,
  isLoadingMore: false,
  loadError: false,
  nextCursor: null,

  setTab: async (tab) => {
    set({ tab, items: [], nextCursor: null });
    await get().fetch();
  },

  fetch: async () => {
    const { tab } = get();
    set({ isLoading: true, loadError: false });
    try {
      const data = await api.getReminders(tab);
      if (get().tab !== tab) return;
      set({ items: data.items, nextCursor: data.nextCursor, isLoading: false });
    } catch {
      if (get().tab !== tab) return;
      set({ isLoading: false, loadError: true });
    }
  },

  fetchMore: async () => {
    const { tab, nextCursor, isLoadingMore } = get();
    if (nextCursor === null || isLoadingMore) return;
    set({ isLoadingMore: true });
    try {
      const data = await api.getReminders(tab, nextCursor);
      if (get().tab !== tab) return;
      set((s) => ({
        items: [...s.items, ...data.items.filter((n) => !s.items.some((i) => i.id === n.id))],
        nextCursor: data.nextCursor,
        isLoadingMore: false,
      }));
    } catch {
      set({ isLoadingMore: false });
    }
  },

  create: async (body, opts = {}) => {
    try {
      const created = await api.createReminder({ ...body, remindAt: body.remindAt.toISOString() });
      set((s) => ({
        items: s.tab === 'pending' && !s.items.some((i) => i.id === created.id) ? sortFor('pending', [...s.items, created]) : s.items,
      }));
      if (opts.notify !== false) useToastStore.getState().show(t('messages:reminder.toast.created'));
      return true;
    } catch {
      useToastStore.getState().show(t('messages:reminder.toast.createFailed'), 'error');
      return false;
    }
  },

  snooze: async (id, remindAt) => {
    try {
      const updated = await api.updateReminder(id, { remindAt: remindAt.toISOString() });
      set((s) => ({ items: sortFor(s.tab, s.items.map((i) => (i.id === id ? updated : i)).filter((i) => belongsToTab(s.tab, i))) }));
    } catch {
      void get().fetch();
    }
  },

  complete: async (id, completed = true) => {
    // 낙관적으로 목록에서 뺀다. 실패하면 다시 불러온다.
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    try {
      await api.updateReminder(id, { completed });
    } catch {
      void get().fetch();
    }
  },

  remove: async (id) => {
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    try {
      await api.deleteReminder(id);
    } catch {
      void get().fetch();
    }
  },

  bindSocket: (socket) => {
    // 다른 탭의 변경도 같은 목록에 반영한다(중복 전달은 id로 합친다)
    const handleUpdated = (data: { reminder: ApiReminder }) => {
      const r = data.reminder;
      set((s) => {
        const rest = s.items.filter((i) => i.id !== r.id);
        return { items: belongsToTab(s.tab, r) ? sortFor(s.tab, [...rest, r]) : rest };
      });
    };
    const handleDue = (data: { reminder: ApiReminder }) => {
      handleUpdated(data);
      const text = data.reminder.text ?? data.reminder.message?.excerpt ?? '';
      useToastStore.getState().show(t('messages:reminder.toast.due', { text }), 'success', 6000);
    };
    const handleRemoved = (data: { id: number }) => {
      set((s) => ({ items: s.items.filter((i) => i.id !== data.id) }));
    };
    socket.on('reminder:updated', handleUpdated);
    socket.on('reminder:due', handleDue);
    socket.on('reminder:removed', handleRemoved);
    return () => {
      socket.off('reminder:updated', handleUpdated);
      socket.off('reminder:due', handleDue);
      socket.off('reminder:removed', handleRemoved);
    };
  },
}));
