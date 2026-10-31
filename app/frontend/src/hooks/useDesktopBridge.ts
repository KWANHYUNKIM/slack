import { useEffect } from 'react';
import { useChannelStore } from '@/stores/useChannelStore';
import { computeBadgeCount, getDesktop } from '@/lib/desktop';
import { navigateInApp } from '@/lib/navigation';

/**
 * 데스크톱 앱에서만: 안 읽음 수를 독·작업 표시줄 배지로 보내고, 알림 클릭 시 해당 화면으로 이동한다.
 * 웹에서는 window.desktop이 없어서 아무것도 하지 않는다. AppShell(로그인 후)에서 한 번 부른다.
 */
export function useDesktopBridge(): void {
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;

    let lastCount = -1;
    const sync = (state: ReturnType<typeof useChannelStore.getState>) => {
      const count = computeBadgeCount(state);
      if (count === lastCount) return;
      lastCount = count;
      desktop.setBadgeCount(count);
    };
    sync(useChannelStore.getState());
    const unsubscribeStore = useChannelStore.subscribe(sync);
    const unsubscribeNavigate = desktop.onNavigate((path) => {
      navigateInApp(path);
    });

    return () => {
      unsubscribeStore();
      unsubscribeNavigate();
      // 로그아웃하면 배지를 지운다
      desktop.setBadgeCount(0);
    };
  }, []);
}
