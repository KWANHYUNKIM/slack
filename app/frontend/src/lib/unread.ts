// 안 읽음 구분선 위치 계산(순수 함수). 읽음 기준점은 대화를 열 때 한 번 고정한 값이다.

export interface UnreadCandidate {
  id: number;
  userId: number;
  isDeleted?: boolean;
  threadId?: number | null;
  alsoSendToChannel?: boolean;
}

export interface UnreadInfo {
  /** 구분선을 그릴 메시지 id(첫 안 읽음 메시지 바로 앞). 없으면 null */
  dividerBeforeId: number | null;
  /** 로드된 범위 안의 안 읽음 수(내 메시지·삭제된 메시지 제외) */
  unreadLoaded: number;
}

// 서버의 안 읽음 규칙(최상위 메시지 또는 "채널에도 보내기" 답글, 삭제 제외)에 맞는 메시지인가
function isTimeline(m: UnreadCandidate): boolean {
  return !m.isDeleted && (!m.threadId || m.alsoSendToChannel === true);
}

/**
 * 기준점(lastReadId) 다음의 첫 안 읽음 메시지를 찾는다. lastReadId가 null이면 처음부터 전부 안 읽음이다.
 * 내가 쓴 메시지와 삭제된 메시지는 건너뛴다. messages는 오래된 순서다.
 */
export function computeUnread(
  messages: readonly UnreadCandidate[],
  lastReadId: number | null,
  myUserId: number | null | undefined,
): UnreadInfo {
  let dividerBeforeId: number | null = null;
  let unreadLoaded = 0;
  for (const m of messages) {
    if (lastReadId !== null && m.id <= lastReadId) continue;
    if (!isTimeline(m) || m.userId === myUserId) continue;
    if (dividerBeforeId === null) dividerBeforeId = m.id;
    unreadLoaded++;
  }
  return { dividerBeforeId, unreadLoaded };
}

/** 서버가 센 안 읽음이 로드된 목록보다 많다 = 더 오래된 안 읽음이 로드 범위 밖에 있다 */
export function hasUnreadOutOfRange(
  messages: readonly UnreadCandidate[],
  lastReadId: number | null,
  unreadTotal: number,
): boolean {
  if (unreadTotal <= 0 || messages.length === 0) return false;
  if (lastReadId !== null && messages[0].id <= lastReadId) return false;
  // 서버 수에는 내 메시지도 들어 있으므로 내 메시지를 포함해 센다
  const loaded = messages.filter((m) => (lastReadId === null || m.id > lastReadId) && isTimeline(m)).length;
  return unreadTotal > loaded;
}

/** "여기서부터 읽지 않음으로 표시": messageId 바로 앞의 타임라인 메시지 id(없으면 null = 처음부터 안 읽음) */
export function previousTimelineId(messages: readonly UnreadCandidate[], messageId: number): number | null {
  let prev: number | null = null;
  for (const m of messages) {
    if (m.id >= messageId) break;
    if (isTimeline(m)) prev = m.id;
  }
  return prev;
}

/** "여기서부터 읽지 않음으로 표시"한 뒤의 안 읽음 수: messageId 이상인 타임라인 메시지(삭제 제외, 내 것 포함 = 서버 수와 같은 규칙) */
export function countUnreadFrom(messages: readonly UnreadCandidate[], messageId: number): number {
  return messages.filter((m) => m.id >= messageId && isTimeline(m)).length;
}

/**
 * DM 대화 키(1:1은 상대 userId, 그룹은 -groupId)를 useUnreadStore의 범위 번호로 바꾼다.
 * 채널 id(양수)와 겹치지 않게 음수로 보내고, 1:1은 짝수, 그룹은 홀수로 나눈다.
 */
export function dmUnreadScope(conversationKey: number): number {
  return conversationKey > 0 ? -2 * conversationKey : -(2 * -conversationKey + 1);
}
