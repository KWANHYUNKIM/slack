import { Prisma } from '@prisma/client';
import { DEFAULT_WORKSPACE_ID, channelNameKey } from './workspaceService.js';

// 기본 워크스페이스의 기본 채널 자리(ChannelWorkspace.defaultSlot). 가입(/auth/register)과 첫 OWNER 부트스트랩이 같은 규칙을 쓴다.
export const DEFAULT_CHANNELS = ['general', 'random'];

// 규칙(E1a)
// - "기본 채널로 지정됨"(isDefault)과 "지금 자동 가입 대상"을 나눈다. isDefault는 비공개 전환·보관에도 그대로 두고,
//   가입 때 공개(isPrivate:false)·미보관(archivedAt:null)인 기본 채널만 고른다. 공개로 되돌리거나 보관을 풀면 다시 대상이 된다.
// - 자리(defaultSlot)는 이름이 아니라 행에 기록한다. #general 이름을 바꿔도 그 자리는 채워진 것으로 보고 새 general을 만들지 않는다.
// - 자리가 비어 있을 때만 채운다. 같은 nameKey 채널이 기본 워크스페이스에 있으면 그 채널을 쓰고(비공개·보관이어도 자리만 채우고
//   자동 가입은 하지 않는다), 없을 때만 새 공개 채널을 만든다.
// - 트랜잭션 안(부트스트랩)과 밖(가입)이 같은 경로를 쓴다. PostgreSQL은 트랜잭션 안의 오류 하나로 트랜잭션 전체를 중단하므로
//   유니크 충돌은 예외 대신 skipDuplicates(ON CONFLICT DO NOTHING)로 넘기고 다시 조회한다.
export async function joinDefaultChannels(db: Prisma.TransactionClient, userId: number): Promise<number[]> {
  const filled = await db.channelWorkspace.findMany({
    where: { workspaceId: DEFAULT_WORKSPACE_ID, defaultSlot: { in: DEFAULT_CHANNELS } },
    select: { defaultSlot: true },
  });
  const filledSlots = new Set(filled.map((r) => r.defaultSlot));
  for (const slot of DEFAULT_CHANNELS) {
    if (!filledSlots.has(slot)) await fillDefaultSlot(db, slot);
  }

  const targets = await db.channel.findMany({
    where: {
      isPrivate: false,
      archivedAt: null,
      workspaces: { some: { workspaceId: DEFAULT_WORKSPACE_ID, isDefault: true } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const channelIds = targets.map((c) => c.id);
  if (channelIds.length > 0) {
    await db.channelMember.createMany({
      data: channelIds.map((channelId) => ({ userId, channelId })),
      skipDuplicates: true,
    });
  }
  return channelIds;
}

// 워크스페이스의 기본 채널 자리 하나를 채운다. 기본 워크스페이스는 가입·부트스트랩이, 새 워크스페이스는 POST /org/workspaces가 부른다.
export async function fillDefaultSlot(
  db: Prisma.TransactionClient,
  slot: string,
  workspaceId: number = DEFAULT_WORKSPACE_ID,
): Promise<number | null> {
  const nameKey = channelNameKey(slot);
  // 그 워크스페이스의 nameKey로만 찾는다(다른 워크스페이스의 같은 이름 채널과 섞이지 않게, E1c)
  let row = await db.channelWorkspace.findUnique({
    where: { workspaceId_nameKey: { workspaceId, nameKey } },
    select: { channelId: true },
  });
  if (!row) {
    // 호스트 행 없이 옛 경로로 만들어진 같은 이름의 채널이 있으면 그것을 쓰고, 없으면 새로 만든다(createdBy는 비워 둔다: 시스템이 만든 채널).
    // Channel.name 전역 유니크가 없으므로(E1c) 동시에 두 요청이 채널을 만들 수 있다. 이름 유일성은 아래 호스트 행의
    // nameKey 유니크가 정하고, 진 쪽은 방금 만든 채널을 지운다. 유니크 충돌은 예외 대신 skipDuplicates(ON CONFLICT DO NOTHING)로
    // 넘긴다(트랜잭션 안의 오류 하나가 트랜잭션 전체를 중단하므로).
    const orphan = await db.channel.findFirst({
      where: { name: slot, workspaceId, workspaces: { none: { workspaceId } } },
      select: { id: true },
    });
    const channel = orphan ?? await db.channel.create({
      data: { name: slot, isPrivate: false, workspaceId },
      select: { id: true },
    });
    const attached = await db.channelWorkspace.createMany({
      data: [{ channelId: channel.id, workspaceId, nameKey }],
      skipDuplicates: true,
    });
    if (attached.count === 0 && !orphan) await db.channel.delete({ where: { id: channel.id } });
    row = await db.channelWorkspace.findUnique({
      where: { workspaceId_nameKey: { workspaceId, nameKey } },
      select: { channelId: true },
    });
    if (!row) return null;
  }
  // 자리 표시. 동시에 같은 행을 채우는 가입은 defaultSlot:null 조건에 걸려 아무것도 바꾸지 않는다.
  await db.channelWorkspace.updateMany({
    where: { channelId: row.channelId, workspaceId, defaultSlot: null },
    data: { isDefault: true, defaultSlot: slot },
  });
  return row.channelId;
}
