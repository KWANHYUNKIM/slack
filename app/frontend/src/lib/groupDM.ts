import { formatList } from '@/lib/i18n/format';
import type { GroupDM } from '@/lib/types';

/** 그룹 DM 표시 이름: 붙인 이름이 있으면 그것, 없으면 나를 뺀 멤버 이름을 로캘 목록 형식으로 잇는다. */
export function groupDisplayName(group: Pick<GroupDM, 'name' | 'members'>, currentUserId?: number): string {
  if (group.name) return group.name;
  const others = group.members.filter((m) => m.id !== currentUserId).map((m) => m.name);
  return formatList(others.length > 0 ? others : group.members.map((m) => m.name), { style: 'short', type: 'unit' });
}

/** 나를 뺀 멤버(아바타 겹침 표시용). 혼자 남았으면 나를 돌려준다. */
export function otherMembers(group: Pick<GroupDM, 'members'>, currentUserId?: number): GroupDM['members'] {
  const others = group.members.filter((m) => m.id !== currentUserId);
  return others.length > 0 ? others : group.members;
}
