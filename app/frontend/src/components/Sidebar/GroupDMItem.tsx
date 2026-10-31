import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/ui/avatar';
import { useAuthStore } from '@/stores/useAuthStore';
import { groupDisplayName, otherMembers } from '@/lib/groupDM';
import type { GroupDM } from '@/lib/types';
import { SidebarItem } from './SidebarItem';

interface GroupDMItemProps {
  group: GroupDM;
  isActive: boolean;
  onClick: () => void;
}

/** 사이드바의 그룹 DM 항목: 멤버 아바타 두 개를 겹쳐 보이고 이름을 나열한다. */
export function GroupDMItem({ group, isActive, onClick }: GroupDMItemProps) {
  const { t } = useTranslation('sidebar');
  const currentUserId = useAuthStore((s) => s.user?.id);
  const hasUnread = group.unreadCount > 0 || group.mentionCount > 0;
  const [first, second] = otherMembers(group, currentUserId);
  const name = groupDisplayName(group, currentUserId);

  return (
    <SidebarItem
      data-testid="group-dm-list-item"
      isActive={isActive}
      hasUnread={hasUnread}
      unreadCount={group.unreadCount}
      mentionCount={group.mentionCount}
      onClick={onClick}
      leftSlot={
        <span className="relative h-5 w-5 flex-shrink-0" aria-label={t('groupDM.memberCount', { count: group.members.length })}>
          {first && (
            <Avatar src={first.avatar} alt={first.name} fallback={first.name} size="sm" className="absolute start-0 top-0 h-4 w-4" />
          )}
          {second && (
            <Avatar
              src={second.avatar}
              alt={second.name}
              fallback={second.name}
              size="sm"
              className="absolute bottom-0 end-0 h-4 w-4 ring-1 ring-slack-sidebar"
            />
          )}
        </span>
      }
      label={name}
    />
  );
}
