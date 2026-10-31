import { create } from 'zustand';
import {
  loadRecents,
  pushRecent,
  saveRecents,
  type RecentTarget,
} from '@/lib/switcher';

// 빠른 전환기(06)와 단축키 도움말의 열림 상태, 최근 방문 기록.
// 최근 방문은 사용자별 localStorage 키(`recentTargets:<userId>`)에 최대 20개만 둔다(서버 저장 없음, 비밀 정보 없음).

interface SwitcherState {
  switcherOpen: boolean;
  helpOpen: boolean;
  /** 기록의 주인. 로그인한 사용자가 확정되면 setUser로 채운다. */
  userId: number | null;
  recents: RecentTarget[];
  openSwitcher: () => void;
  closeSwitcher: () => void;
  toggleSwitcher: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  /** 사용자가 정해지거나 바뀌면 그 사용자의 기록을 읽는다(예전 공용 키는 버린다) */
  setUser: (userId: number | null) => void;
  /** 채널/DM/그룹 화면에 들어갈 때 기록한다 */
  recordVisit: (target: RecentTarget) => void;
  /** 후보에서 사라진(나간·삭제된) 대상을 뺀 목록으로 바꾼다 */
  setRecents: (list: RecentTarget[]) => void;
  /** 현재 사용자의 기록을 지운다(전환기의 "기록 지우기"와 로그아웃) */
  clearRecents: () => void;
}

export const useSwitcherStore = create<SwitcherState>((set, get) => ({
  switcherOpen: false,
  helpOpen: false,
  userId: null,
  recents: [],

  openSwitcher: () => set({ switcherOpen: true, helpOpen: false }),
  closeSwitcher: () => set({ switcherOpen: false }),
  toggleSwitcher: () => (get().switcherOpen ? get().closeSwitcher() : get().openSwitcher()),
  openHelp: () => set({ helpOpen: true, switcherOpen: false }),
  closeHelp: () => set({ helpOpen: false }),

  setUser: (userId) => {
    if (userId === get().userId) return;
    set({ userId, recents: userId === null ? [] : loadRecents(localStorage, userId) });
  },

  recordVisit: (target) => {
    const { userId, recents } = get();
    const next = pushRecent(recents, target);
    if (userId !== null) saveRecents(localStorage, userId, next);
    set({ recents: next });
  },

  setRecents: (list) => {
    const { userId, recents } = get();
    if (list.length === recents.length) return;
    if (userId !== null) saveRecents(localStorage, userId, list);
    set({ recents: list });
  },

  clearRecents: () => {
    const { userId } = get();
    if (userId !== null) saveRecents(localStorage, userId, []);
    set({ recents: [] });
  },
}));
