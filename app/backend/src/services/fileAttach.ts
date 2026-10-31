import type { Prisma } from '@prisma/client';

/** 같은 fileId를 여러 번 보낸 요청([5,5])을 한 번으로 본다. 개수 비교는 이 결과의 길이로 한다. */
export const uniqueFileIds = (fileIds: number[]): number[] => [...new Set(fileIds)];

/**
 * 메시지·DM에 새로 붙일 수 있는 파일 조건(업로더 본인, 아직 어디에도 안 붙음).
 * 소프트 삭제로 분리된 파일(detachedFrom*가 있음)은 다시 붙일 수 없다. 첨부 연결은 모두 이 조건을 쓴다.
 * 호출부는 uniqueFileIds로 중복을 없앤 목록을 넘기고, updateMany의 count를 그 목록 길이와 비교한다.
 */
export const attachableFiles = (userId: number, fileIds: number[]): Prisma.FileWhereInput => ({
  id: { in: fileIds },
  userId,
  messageId: null,
  dmId: null,
  detachedFromMessageId: null,
  detachedFromDmId: null,
});
