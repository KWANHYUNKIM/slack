import { Prisma, PrismaClient } from '@prisma/client';
import { DEFAULT_WORKSPACE_ID, channelHostData, channelNameKey, lockWorkspaceChannelNames } from './workspaceService.js';

// 기본 워크스페이스의 기본 채널 자리(ChannelWorkspace.defaultSlot). 가입(/auth/register)과 첫 OWNER 부트스트랩이 같은 규칙을 쓴다.
export const DEFAULT_CHANNELS = ['general', 'random'];

// 규칙(E1a)
// - "기본 채널로 지정됨"(isDefault)과 "지금 자동 가입 대상"을 나눈다. isDefault는 비공개 전환·보관에도 그대로 두고,
//   가입 때 공개(isPrivate:false)·미보관(archivedAt:null)인 기본 채널만 고른다. 공개로 되돌리거나 보관을 풀면 다시 대상이 된다.
// - 자리(defaultSlot)는 이름이 아니라 행에 기록한다. #general 이름을 바꿔도 그 자리는 채워진 것으로 보고 새 general을 만들지 않는다.
// - 자리가 비어 있을 때만 채운다. 같은 nameKey 채널이 기본 워크스페이스에 있으면 그 채널을 쓰고(비공개·보관이어도 자리만 채우고
//   자동 가입은 하지 않는다), 없을 때만 새 공개 채널을 만든다.
// - 트랜잭션 안(부트스트랩)과 밖(가입)이 같은 경로를 쓴다. 자리 채우기는 워크스페이스 잠금 안에서 돌아 동시 가입에도 채널이 하나다.
export async function joinDefaultChannels(db: Prisma.TransactionClient | PrismaClient, userId: number): Promise<number[]> {
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
// 같은 워크스페이스의 채널 이름을 정하는 경로(자리 채우기, POST /channels, 이름 변경)는 워크스페이스 단위 advisory lock
// (lockWorkspaceChannelNames)으로 줄을 선다. Channel.name 전역 유니크가 없으므로(E1c) 잠금 없이 동시에 가입하면 general이
// 둘 생길 수 있다. 트랜잭션 밖에서 부르면 자체 트랜잭션을 열고, 안에서 부르면 그 트랜잭션에서 잠근다(트랜잭션이 끝날 때 풀린다).
export async function fillDefaultSlot(
  db: Prisma.TransactionClient | PrismaClient,
  slot: string,
  workspaceId: number = DEFAULT_WORKSPACE_ID,
): Promise<number | null> {
  if ('$transaction' in db) return db.$transaction((tx) => fillDefaultSlotLocked(tx, slot, workspaceId));
  return fillDefaultSlotLocked(db, slot, workspaceId);
}

async function fillDefaultSlotLocked(db: Prisma.TransactionClient, slot: string, workspaceId: number): Promise<number | null> {
  await lockWorkspaceChannelNames(db, [workspaceId]);
  const nameKey = channelNameKey(slot);
  // 그 워크스페이스의 nameKey로만 찾는다(다른 워크스페이스의 같은 이름 채널과 섞이지 않게, E1c)
  let row = await db.channelWorkspace.findUnique({
    where: { workspaceId_nameKey: { workspaceId, nameKey } },
    select: { channelId: true },
  });
  if (!row) {
    // 잠금 안이라 다른 경로가 같은 nameKey를 먼저 가져갈 수 없다. 호스트 행 없이 옛 경로로 만들어진 같은 이름의 채널이 있으면
    // 행만 붙이고, 없으면 채널과 호스트 행을 한 번의 중첩 create로 만든다(createdBy는 비워 둔다: 시스템이 만든 채널).
    const orphan = await db.channel.findFirst({
      where: { name: slot, workspaceId, workspaces: { none: { workspaceId } } },
      select: { id: true },
    });
    if (orphan) {
      await db.channelWorkspace.create({ data: { channelId: orphan.id, workspaceId, nameKey } });
      row = { channelId: orphan.id };
    } else {
      const created = await db.channel.create({
        data: { name: slot, isPrivate: false, ...channelHostData(slot, workspaceId) },
        select: { id: true },
      });
      row = { channelId: created.id };
    }
  }
  // 자리 표시. 이미 자리가 찬 행이면 defaultSlot:null 조건에 걸려 아무것도 바꾸지 않는다.
  await db.channelWorkspace.updateMany({
    where: { channelId: row.channelId, workspaceId, defaultSlot: null },
    data: { isDefault: true, defaultSlot: slot },
  });
  return row.channelId;
}
