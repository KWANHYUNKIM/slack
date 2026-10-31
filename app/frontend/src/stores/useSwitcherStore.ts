import { create } from 'zustand';
import {
  RECENT_STORAGE_KEY,
  parseRecents,
  pushRecent,
  type RecentTarget,
} from '@/lib/switcher';

// 빠른 전환기(06)와 단축키 도움말의 열림 상태, 최근 방문 기록.
// 최근 방문은 localStorage 한 키에 최대 20개만 둔다(서버 저장 없음, 비밀 정보 없음).

function load(): RecentTarget[] {
  try {
    return parseRecents(localStorage.getItem(RECENT_STORAGE_KEY));
  } catch {
    return [];
  }
}

function save(list: RecentTarget[]) {
  try {
    if (list.length === 0) localStorage.removeItem(RECENT_STORAGE_KEY);
    else localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 저장소가 막혀 있어도 화면 동작은 계속한다
  }
}

interface SwitcherState {
  switcherOpen: boolean;
  helpOpen: boolean;
  recents: RecentTarget[];
  openSwitcher: () => void;
  closeSwitcher: () => void;
  toggleSwitcher: () => void;
  openHelp: () => void;
  closeHelp: () => void;
  /** 채널/DM/그룹 화면에 들어갈 때 기록한다 */
  recordVisit: (target: RecentTarget) => void;
  /** 후보에서 사라진(나간·삭제된) 대상을 기록에서 뺀다 */
  setRecents: (list: RecentTarget[]) => void;
  clearRecents: () => void;
}

export const useSwitcherStore = create<SwitcherState>((set, get) => ({
  switcherOpen: false,
  helpOpen: false,
  recents: load(),

  openSwitcher: () => set({ switcherOpen: true, helpOpen: false }),
  closeSwitcher: () => set({ switcherOpen: false }),
  toggleSwitcher: () => (get().switcherOpen ? get().closeSwitcher() : get().openSwitcher()),
  openHelp: () => set({ helpOpen: true, switcherOpen: false }),
  closeHelp: () => set({ helpOpen: false }),

  recordVisit: (target) => {
    const next = pushRecent(get().recents, target);
    save(next);
    set({ recents: next });
  },

  setRecents: (list) => {
    if (list.length === get().recents.length) return;
    save(list);
    set({ recents: list });
  },

  clearRecents: () => {
    save([]);
    set({ recents: [] });
  },
}));
