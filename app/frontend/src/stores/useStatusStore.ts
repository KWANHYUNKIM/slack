import { create } from 'zustand';
import * as api from '@/lib/api';
import type { CustomStatus, Dnd } from '@/lib/types';

// 커스텀 상태와 방해금지(05). 프레즌스(useAuthStore의 status)와 별개 값이다.
// 만료 시각이 지난 값은 서버 정리를 기다리지 않고 화면에서 바로 숨긴다(now를 주기적으로 갱신).

interface UserStatusEntry {
  customStatus: CustomStatus | null;
  dnd: Dnd;
}

interface StatusState {
  /** 사용자 id별 최신 상태 (user:status 이벤트와 목록 응답이 채운다) */
  byUser: Record<number, UserStatusEntry>;
  /** 내 방해금지 */
  myDnd: Dnd;
  /** 만료 판단 기준 시각(ms). 타이머가 갱신한다. */
  now: number;
  loadMine: () => Promise<void>;
  setEntry: (userId: number, entry: Partial<UserStatusEntry>) => void;
  saveStatus: (input: { emoji: string | null; text: string | null; expiresAt: string | null; pauseNotifications: boolean }) => Promise<void>;
  clearStatus: () => Promise<void>;
  pauseNotifications: (input: { minutes?: number; until?: string }) => Promise<void>;
  resumeNotifications: () => Promise<void>;
  /** user:status 소켓 이벤트 */
  onUserStatus: (data: { userId: number; customStatus: CustomStatus | null; dnd: Dnd }, myUserId: number | undefined) => void;
  startTicker: () => () => void;
}

const OFF: Dnd = { active: false, until: null };

export function isStatusActive(status: CustomStatus | null | undefined, now: number): status is CustomStatus {
  if (!status || (!status.emoji && !status.text)) return false;
  return !status.expiresAt || new Date(status.expiresAt).getTime() > now;
}

export function isDndActive(dnd: Dnd | null | undefined, now: number): boolean {
  if (!dnd?.active) return false;
  return !dnd.until || new Date(dnd.until).getTime() > now;
}

export const useStatusStore = create<StatusState>((set, get) => ({
  byUser: {},
  myDnd: OFF,
  now: Date.now(),

  loadMine: async () => {
    const me = await api.getMyProfile();
    set((s) => ({
      byUser: { ...s.byUser, [me.id]: { customStatus: me.customStatus ?? null, dnd: me.dnd ?? OFF } },
      myDnd: me.dnd ?? OFF,
    }));
  },

  setEntry: (userId, entry) =>
    set((s) => ({
      byUser: {
        ...s.byUser,
        [userId]: { ...(s.byUser[userId] ?? { customStatus: null, dnd: OFF }), ...entry },
      },
    })),

  saveStatus: async (input) => {
    const res = await api.setCustomStatus(input);
    get().setEntry(res.id, { customStatus: res.customStatus, dnd: res.dnd });
    set({ myDnd: res.dnd });
  },

  clearStatus: async () => {
    const res = await api.clearCustomStatus();
    get().setEntry(res.id, { customStatus: res.customStatus, dnd: res.dnd });
    set({ myDnd: res.dnd });
  },

  pauseNotifications: async (input) => {
    const dnd = await api.startDnd(input);
    set({ myDnd: dnd });
  },

  resumeNotifications: async () => {
    const dnd = await api.endDnd();
    set({ myDnd: dnd });
  },

  onUserStatus: (data, myUserId) => {
    get().setEntry(data.userId, { customStatus: data.customStatus, dnd: data.dnd });
    if (data.userId === myUserId) set({ myDnd: data.dnd });
  },

  startTicker: () => {
    const id = setInterval(() => set({ now: Date.now() }), 15_000);
    return () => clearInterval(id);
  },
}));

/** 한 사용자의 현재(만료 반영) 커스텀 상태 */
export function useCustomStatus(userId: number | undefined): CustomStatus | null {
  const entry = useStatusStore((s) => (userId === undefined ? undefined : s.byUser[userId]));
  const now = useStatusStore((s) => s.now);
  return isStatusActive(entry?.customStatus, now) ? entry!.customStatus : null;
}

/** 한 사용자의 방해금지 여부(만료 반영) */
export function useIsDnd(userId: number | undefined): boolean {
  const entry = useStatusStore((s) => (userId === undefined ? undefined : s.byUser[userId]));
  const now = useStatusStore((s) => s.now);
  return isDndActive(entry?.dnd, now);
}

/** 서비스 워커로 띄우는 브라우저 알림을 내 쪽에서 막을 때 쓴다 */
export function isMyDndNow(): boolean {
  const { myDnd } = useStatusStore.getState();
  return isDndActive(myDnd, Date.now());
}
