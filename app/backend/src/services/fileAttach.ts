import type { Prisma } from '@prisma/client';

/**
 * 메시지·DM에 새로 붙일 수 있는 파일 조건(업로더 본인, 아직 어디에도 안 붙음).
 * 소프트 삭제로 분리된 파일(detachedFrom*가 있음)은 다시 붙일 수 없다. 첨부 연결은 모두 이 조건을 쓴다.
 */
export const attachableFiles = (userId: number, fileIds: number[]): Prisma.FileWhereInput => ({
  id: { in: fileIds },
  userId,
  messageId: null,
  dmId: null,
  detachedFromMessageId: null,
  detachedFromDmId: null,
});
