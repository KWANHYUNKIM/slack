import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/ui/avatar';
import { Moon } from 'lucide-react';
import { useAuthStore } from '@/stores/useAuthStore';
import { useCustomStatus, useIsDnd } from '@/stores/useStatusStore';
import type { DirectMessage } from '@/lib/types';
import { SidebarItem } from './SidebarItem';

interface DirectMessageItemProps {
  dm: DirectMessage;
  isActive: boolean;
  onClick: () => void;
}

export function DirectMessageItem({
  dm,
  isActive,
  onClick,
}: DirectMessageItemProps) {
  const { t } = useTranslation('sidebar');
  const hasUnread = dm.unreadCount > 0 || dm.mentionCount > 0;
  const currentUser = useAuthStore((s) => s.user);
  const isSelf = dm.userId === currentUser?.id;
  const customStatus = useCustomStatus(dm.userId);
  const isDnd = useIsDnd(dm.userId);

  return (
    <SidebarItem
      data-testid="dm-list-item"
      isActive={isActive}
      hasUnread={hasUnread}
      unreadCount={dm.unreadCount}
      mentionCount={dm.mentionCount}
      onClick={onClick}
      leftSlot={
        <Avatar
          src={dm.userAvatar}
          alt={dm.userName}
          fallback={dm.userName}
          size="sm"
          status={dm.userStatus}
        />
      }
      label={
        <>
          {dm.userName}
          {isSelf && <span className="opacity-60"> {t('you')}</span>}
          {customStatus?.emoji && (
            <span data-testid="dm-status-emoji" className="ms-1" title={customStatus.text ?? undefined}>{customStatus.emoji}</span>
          )}
          {isDnd && <Moon data-testid="dm-dnd-icon" className="ms-1 inline h-3 w-3 opacity-60" aria-hidden="true" />}
        </>
      }
    />
  );
}
