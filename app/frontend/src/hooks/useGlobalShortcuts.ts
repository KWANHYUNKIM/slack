import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChannelStore } from '@/stores/useChannelStore';
import { useSwitcherStore } from '@/stores/useSwitcherStore';
import { getCollator } from '@/lib/i18n/format';
import i18n from 'i18next';
import {
  detectMac,
  isEditableElement,
  matchShortcut,
} from '@/lib/shortcuts';
import { parseTargetPath, sidebarOrder, stepTarget } from '@/lib/switcher';

export const isMacPlatform = () => detectMac(navigator.userAgent);

/**
 * 전역 단축키(06). 목록과 판정은 lib/shortcuts.ts에 있다.
 * - window 캡처 단계에서 받아, Quill(snow)의 Ctrl+K 링크 단축키보다 먼저 가로챈다.
 * - 입력창/에디터에 포커스가 있으면 inEditable인 단축키(Cmd/Ctrl+K, Esc)만 동작한다.
 * - 또한 방문 기록(최근 방문)을 경로 변화로 쌓는다.
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const location = useLocation();

  // 최근 방문 기록: 채널/DM/그룹 화면에 들어갈 때마다
  useEffect(() => {
    const target = parseTargetPath(location.pathname);
    if (target) useSwitcherStore.getState().recordVisit(target);
  }, [location.pathname]);

  useEffect(() => {
    const isMac = isMacPlatform();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.isComposing) return; // 한글 등 IME 조합 중에는 건드리지 않는다
      const def = matchShortcut(e, isMac);
      if (!def) return;
      if (!def.inEditable && isEditableElement(e.target as HTMLElement | null)) return;

      const sw = useSwitcherStore.getState();
      switch (def.id) {
        case 'switcher':
          e.preventDefault();
          e.stopPropagation();
          sw.toggleSwitcher();
          return;
        case 'help':
          e.preventDefault();
          sw.openHelp();
          return;
        case 'closeTop':
          // 전환기·도움말은 각자 Esc를 처리한다. 여기서는 열려 있을 때 하나씩 닫는다.
          if (sw.switcherOpen) sw.closeSwitcher();
          else if (sw.helpOpen) sw.closeHelp();
          return;
        case 'prevChannel':
        case 'nextChannel':
        case 'prevUnread':
        case 'nextUnread': {
          if (sw.switcherOpen || sw.helpOpen) return;
          e.preventDefault();
          const { channels, directMessages, groupDMs } = useChannelStore.getState();
          const collator = getCollator(i18n.language);
          const order = sidebarOrder({ channels, directMessages, groupDMs }, collator.compare);
          const current = parseTargetPath(window.location.pathname);
          const dir = def.id === 'nextChannel' || def.id === 'nextUnread' ? 1 : -1;
          const next = stepTarget(order, current, dir, def.id === 'prevUnread' || def.id === 'nextUnread');
          if (next) navigate(next.path);
          return;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [navigate]);
}
