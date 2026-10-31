import { Prisma } from '@prisma/client';
import { DEFAULT_WORKSPACE_ID, channelHostData, channelNameKey } from './workspaceService.js';

// 기본 워크스페이스에 기본 채널이 하나도 없을 때 새로 만드는 이름. 가입(/auth/register)과 첫 OWNER 부트스트랩이 같은 규칙을 쓴다.
export const DEFAULT_CHANNELS = ['general', 'random'];

// 규칙(E1a)
// - 기본 채널은 이름이 아니라 ChannelWorkspace.isDefault로 정한다. #general 이름을 바꿔도 기본 채널로 남고,
//   비공개로 바꾸거나 보관하면 isDefault가 꺼진다(channelService·관리자 보관 경로).
// - 공개(isPrivate:false)이고 보관되지 않은(archivedAt:null) 기본 채널에만 넣는다.
// - 기본 채널이 하나도 없을 때만 DEFAULT_CHANNELS를 만든다. 같은 이름(대소문자 무시)의 채널이 이미 있으면 새로 만들지 않고,
//   그 채널이 공개·미보관이면 기본 채널로 표시해 쓴다(보관 채널을 되살리거나 비공개 채널에 몰래 넣지 않는다).
export async function joinDefaultChannels(db: Prisma.TransactionClient, userId: number): Promise<number[]> {
  const defaults = await db.channel.findMany({
    where: {
      isPrivate: false,
      archivedAt: null,
      workspaces: { some: { workspaceId: DEFAULT_WORKSPACE_ID, isDefault: true } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const channelIds = defaults.length > 0 ? defaults.map((c) => c.id) : await createDefaultChannels(db);
  if (channelIds.length > 0) {
    await db.channelMember.createMany({
      data: channelIds.map((channelId) => ({ userId, channelId })),
      skipDuplicates: true,
    });
  }
  return channelIds;
}

async function createDefaultChannels(db: Prisma.TransactionClient): Promise<number[]> {
  const ids: number[] = [];
  for (const name of DEFAULT_CHANNELS) {
    const id = await findOrCreateDefaultChannel(db, name);
    if (id !== null) ids.push(id);
  }
  return ids;
}

function findSameName(db: Prisma.TransactionClient, name: string) {
  return db.channel.findFirst({
    where: {
      OR: [
        { name: { equals: name, mode: 'insensitive' } },
        { workspaces: { some: { workspaceId: DEFAULT_WORKSPACE_ID, nameKey: channelNameKey(name) } } },
      ],
    },
    select: { id: true, name: true, workspaceId: true, isPrivate: true, archivedAt: true },
    orderBy: { id: 'asc' },
  });
}

async function findOrCreateDefaultChannel(db: Prisma.TransactionClient, name: string): Promise<number | null> {
  let existing = await findSameName(db, name);
  if (!existing) {
    try {
      // 채널과 호스트 행(isDefault)을 한 번의 중첩 create로 만든다. 기존 가입 동작과 같이 createdBy는 비워 둔다.
      const created = await db.channel.create({
        data: { name, isPrivate: false, ...channelHostData(name, DEFAULT_WORKSPACE_ID, true) },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      // 동시에 들어온 가입이 먼저 만든 경우(이름·nameKey 유니크). 트랜잭션 밖 호출(가입)에서만 다시 찾을 수 있다.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      existing = await findSameName(db, name);
      if (!existing) throw error;
    }
  }
  if (existing.isPrivate || existing.archivedAt) return null;
  const marked = await db.channelWorkspace.updateMany({
    where: { channelId: existing.id, workspaceId: DEFAULT_WORKSPACE_ID },
    data: { isDefault: true },
  });
  if (marked.count === 0) {
    // 다른 워크스페이스의 채널이면 쓰지 않는다. 기본 워크스페이스 호스트인데 행이 없으면(옛 경로로 만든 채널) 채운다.
    if (existing.workspaceId !== DEFAULT_WORKSPACE_ID) return null;
    await db.channelWorkspace.createMany({
      data: [{ channelId: existing.id, workspaceId: DEFAULT_WORKSPACE_ID, isDefault: true, nameKey: channelNameKey(existing.name) }],
      skipDuplicates: true,
    });
  }
  return existing.id;
}
