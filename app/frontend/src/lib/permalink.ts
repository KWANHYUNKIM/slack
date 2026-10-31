// 메시지 퍼말링크의 생성과 해석(순수 함수). 형식은 우리가 정한 것이다.
//   채널   /c/<channelId>/m/<messageId>
//   DM     /d/<userId>/m/<messageId>      (userId는 상대방)
//   그룹   /g/<groupId>/m/<messageId>
//   답글   위 형식에서 messageId는 부모 id, 끝에 ?reply=<replyId>

export type PermalinkKind = 'channel' | 'dm' | 'group';

export interface PermalinkTarget {
  kind: PermalinkKind;
  /** 채널 id, DM 상대 userId, 그룹 id */
  conversationId: number;
  /** 대화 타임라인에 있는 메시지 id. 답글이면 부모 id */
  messageId: number;
  /** 스레드 답글이면 답글 id */
  replyId?: number;
}

const PREFIX: Record<PermalinkKind, string> = { channel: 'c', dm: 'd', group: 'g' };
const KIND_BY_PREFIX: Record<string, PermalinkKind> = { c: 'channel', d: 'dm', g: 'group' };

export function isId(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/** 대화 자체의 주소(/c/3, /d/7, /g/5) */
export function buildConversationPath(target: Pick<PermalinkTarget, 'kind' | 'conversationId'>): string {
  return `/${PREFIX[target.kind]}/${target.conversationId}`;
}

/** 앱 안 경로(쿼리 포함)를 만든다 */
export function buildPermalinkPath(target: PermalinkTarget): string {
  const path = `/${PREFIX[target.kind]}/${target.conversationId}/m/${target.messageId}`;
  return target.replyId ? `${path}?reply=${target.replyId}` : path;
}

/** 클립보드에 넣을 전체 URL. 외부 도메인을 쓰지 않고 현재 origin을 기준으로 한다. */
export function buildPermalink(target: PermalinkTarget, origin: string = window.location.origin): string {
  return `${origin}${buildPermalinkPath(target)}`;
}

/**
 * 경로나 URL을 해석한다. 형식이 다르거나 id가 올바르지 않으면 null이다.
 * 전체 URL은 origin이 일치할 때만 우리 링크로 본다.
 */
export function parsePermalink(input: string, origin: string = window.location.origin): PermalinkTarget | null {
  let url: URL;
  try {
    url = new URL(input, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;

  const match = /^\/([cdg])\/(\d+)\/m\/(\d+)\/?$/.exec(url.pathname);
  if (!match) return null;
  const conversationId = Number(match[2]);
  const messageId = Number(match[3]);
  if (!isId(conversationId) || !isId(messageId)) return null;

  const target: PermalinkTarget = { kind: KIND_BY_PREFIX[match[1]], conversationId, messageId };
  const reply = url.searchParams.get('reply');
  if (reply !== null) {
    const replyId = Number(reply);
    if (isId(replyId)) target.replyId = replyId;
  }
  return target;
}
