import { formatList } from '@/lib/i18n/format';
import type { GroupDM } from '@/lib/types';

/** 그룹 DM 최대 인원(본인 포함). 서버 MAX_GROUP_SIZE와 같다. */
export const MAX_GROUP_SIZE = 9;
/** 한 번에 고를 수 있는 상대 수(본인 제외) */
export const MAX_GROUP_OTHERS = MAX_GROUP_SIZE - 1;

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
