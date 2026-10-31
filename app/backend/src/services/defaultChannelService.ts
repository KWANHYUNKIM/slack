import { Prisma } from '@prisma/client';

// 새 사용자를 넣는 기본 채널. 가입(/auth/register)과 첫 OWNER 부트스트랩이 같은 규칙을 쓴다.
export const DEFAULT_CHANNELS = ['general', 'random'];

// 규칙
// - 공개(isPrivate:false)이고 보관되지 않은(archivedAt:null) 채널에만 넣는다.
// - 그 이름의 채널이 아예 없을 때만 공개 채널로 새로 만든다. 이름은 unique라서 보관됐거나 비공개로 바뀐
//   채널이 있으면 만들지도 넣지도 않는다(보관 채널을 되살리거나 비공개 채널에 몰래 넣지 않는다).
// - 트랜잭션 안에서도 쓸 수 있게 unique 충돌은 예외 대신 skipDuplicates(ON CONFLICT DO NOTHING)로 넘긴다.
//   PostgreSQL은 트랜잭션 안의 오류 하나로 트랜잭션 전체를 중단하기 때문이다.
export async function joinDefaultChannels(db: Prisma.TransactionClient, userId: number): Promise<number[]> {
  const joined: number[] = [];
  for (const name of DEFAULT_CHANNELS) {
    await db.channel.createMany({
      // 기존 가입 동작과 같이 createdBy는 비워 둔다. 시스템이 만든 채널이지 그 사용자가 만든 채널이 아니다.
      data: [{ name, isPrivate: false }],
      skipDuplicates: true,
    });
    const channel = await db.channel.findFirst({
      where: { name, isPrivate: false, archivedAt: null },
      select: { id: true },
    });
    if (!channel) continue;
    await db.channelMember.createMany({
      data: [{ userId, channelId: channel.id }],
      skipDuplicates: true,
    });
    joined.push(channel.id);
  }
  return joined;
}
