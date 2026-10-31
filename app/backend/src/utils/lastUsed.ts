// 토큰 lastUsedAt 갱신 간격(PAT, OAuth 공용). 요청마다 쓰면 DB 쓰기가 늘어나므로 1분 간격으로만 갱신한다.
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** 마지막 기록이 없거나 간격이 지났으면 true */
export function shouldWriteLastUsed(lastUsedAt: Date | null, now: number = Date.now()): boolean {
  return !lastUsedAt || now - lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS;
}
