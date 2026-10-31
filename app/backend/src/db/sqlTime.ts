import { Prisma } from '@prisma/client';

/**
 * raw SQL에 시각을 넘길 때 쓴다. DateTime 열은 timestamp(3)(시간대 없음)이고 Prisma는 UTC 값으로 저장한다.
 * JS Date를 그대로 넘기면 세션 시간대(TimeZone)에 따라 해석이 달라질 수 있으므로, 'Z'가 붙은 ISO 문자열을 timestamptz로 읽고
 * UTC 기준의 timestamp로 바꿔 비교·기록한다. 세션 시간대와 무관하게 Prisma가 저장한 값과 같은 기준이 된다.
 */
export function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}
