import { useTranslation } from 'react-i18next';
import { Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getDesktop } from '@/lib/desktop';

interface DesktopServerMenuItemProps {
  /** 항목을 눌러 메뉴를 닫을 때 부른다 */
  onDone: () => void;
}

/** 아바타 메뉴의 "서버 변경" 항목. 데스크톱 앱에서만 보이고 웹에서는 아무것도 그리지 않는다. */
export function DesktopServerMenuItem({ onDone }: DesktopServerMenuItemProps) {
  const { t } = useTranslation('desktop');
  const desktop = getDesktop();
  if (!desktop) return null;

  return (
    <Button
      variant="menu-item"
      onClick={() => {
        onDone();
        desktop.changeServer();
      }}
    >
      <Server className="h-4 w-4" />
      {t('changeServer')}
    </Button>
  );
}
