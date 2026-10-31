import type { Prisma } from '@prisma/client';

/**
 * 채널 타임라인에 보이는 메시지: 최상위 메시지 + "채널에도 보내기"로 보낸 스레드 답글.
 * 기본값은 화면용으로, 답글이 남은 삭제된 부모도 자리표시자로 포함한다.
 * liveOnly는 읽음 위치 계산(기준선, 안 읽음 표시)처럼 살아 있는 메시지만 셀 때 쓴다.
 * GET /channels/:id/messages, channels.ts의 읽음 처리, MCP read_channel이 같이 쓴다.
 * (unread 수를 세는 raw SQL은 같은 조건을 SQL로 따로 적는다)
 */
export function channelTimelineWhere(channelId: number, opts: { liveOnly?: boolean } = {}): Prisma.MessageWhereInput {
  const live: Prisma.MessageWhereInput = { deletedAt: null, OR: [{ threadId: null }, { alsoSendToChannel: true }] };
  if (opts.liveOnly) return { channelId, ...live };
  return {
    channelId,
    OR: [
      live,
      { deletedAt: { not: null }, threadId: null, replies: { some: { deletedAt: null } } },
    ],
  };
}
