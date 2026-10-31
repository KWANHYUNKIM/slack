import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { readDesktopNotificationsEnabled, writeDesktopNotificationsEnabled } from '@/lib/desktop';

interface DesktopNotificationMenuItemProps {
  /** 항목을 눌러 메뉴를 닫을 때 부른다 */
  onDone: () => void;
}

/** 아바타 메뉴의 데스크톱 알림 켜기/끄기 (데스크톱 앱에서 웹 푸시 항목 대신 보인다) */
export function DesktopNotificationMenuItem({ onDone }: DesktopNotificationMenuItemProps) {
  const { t } = useTranslation('desktop');
  const [enabled, setEnabled] = useState(() => readDesktopNotificationsEnabled(window.localStorage));

  const handleToggle = () => {
    const next = !enabled;
    writeDesktopNotificationsEnabled(window.localStorage, next);
    setEnabled(next);
    onDone();
  };

  return (
    <Button variant="menu-item" onClick={handleToggle} aria-pressed={enabled}>
      {enabled ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
      {enabled ? t('disableNotifications') : t('enableNotifications')}
    </Button>
  );
}
