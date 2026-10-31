// 서버 푸시 알림 문구. 외부 리소스 없이 백엔드 안에 둔다(규칙 17).
// 푸시는 서버가 문구를 만들어 보내므로 수신자의 User.locale로 번역한다. 지원 언어는 ko(1등급), en.
// 다른 언어를 추가하려면 PUSH_MESSAGES에 로캘 하나를 더하면 된다. 키가 없으면 en으로 대체한다.
export type PushLocale = 'ko' | 'en';
export const DEFAULT_PUSH_LOCALE: PushLocale = 'ko';

export type PushKey =
  | 'channelMention' | 'channelThread' | 'channelMessage' | 'dmTitle' | 'dmThread' | 'unknownSender'
  | 'body' | 'attachment' | 'reminderTitle' | 'reminderFallback';

type Messages = Record<PushKey, string>;

const PUSH_MESSAGES: Record<PushLocale, Messages> = {
  ko: {
    channelMention: '#{channel} 멘션',
    channelThread: '#{channel} 스레드',
    channelMessage: '#{channel}',
    dmTitle: '{sender}',
    dmThread: '{sender} (스레드)',
    unknownSender: '누군가',
    body: '{sender}: {content}',
    attachment: '첨부 파일을 보냈습니다',
    reminderTitle: '리마인더',
    reminderFallback: '메시지에 대한 리마인더',
  },
  en: {
    channelMention: '#{channel} mention',
    channelThread: '#{channel} thread',
    channelMessage: '#{channel}',
    dmTitle: '{sender}',
    dmThread: '{sender} (thread)',
    unknownSender: 'Someone',
    body: '{sender}: {content}',
    attachment: 'Sent an attachment',
    reminderTitle: 'Reminder',
    reminderFallback: 'Reminder about a message',
  },
};

/** BCP-47 태그나 Accept-Language 한 항목에서 지원 언어를 고른다(ko-KR -> ko). 지원하지 않으면 null. */
export function toPushLocale(tag: string | null | undefined): PushLocale | null {
  if (!tag) return null;
  const t = tag.trim().toLowerCase();
  if (t === 'ko' || t.startsWith('ko-')) return 'ko';
  if (t === 'en' || t.startsWith('en-')) return 'en';
  return null;
}

/** Accept-Language 헤더에서 지원 언어를 고른다(앞선 항목 우선). 지원하지 않으면 null. */
export function pickLocale(header: string | undefined | null): PushLocale | null {
  if (!header) return null;
  for (const part of header.split(',').slice(0, 8)) {
    const found = toPushLocale(part.split(';')[0]);
    if (found) return found;
  }
  return null;
}

/** 수신자 언어 결정: User.locale -> 호출한 쪽이 아는 값(리마인더를 만들 때의 Accept-Language) -> ko. */
export function resolvePushLocale(userLocale: string | null | undefined, fallback?: string | null): PushLocale {
  return toPushLocale(userLocale) ?? toPushLocale(fallback) ?? DEFAULT_PUSH_LOCALE;
}

/** `{name}` 자리표시자만 치환한다. 값에 포함된 `{...}`는 다시 치환하지 않는다(단일 패스). */
export function pushT(locale: PushLocale, key: PushKey, params: Record<string, string> = {}): string {
  const template = PUSH_MESSAGES[locale]?.[key] ?? PUSH_MESSAGES.en[key];
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? params[name] : m));
}

/**
 * 푸시 문구를 만드는 설명. 수신자 언어가 정해지면 sendPushToUser가 이 설명으로 title과 body를 만든다.
 * content가 비면 첨부 파일 문구로 대체한다.
 */
export interface PushSpec {
  titleKey: Exclude<PushKey, 'body' | 'attachment' | 'reminderFallback' | 'unknownSender'>;
  channel?: string;
  /** 보낸 사람 이름. 비어 있으면 번역된 '알 수 없는 사용자' 문구를 쓴다 */
  sender?: string | null;
  /** 본문 원문(최대 100자). 비어 있으면 첨부 문구 */
  content?: string;
  /** 보낸 사람 이름을 앞에 붙이지 않는다(리마인더) */
  plainBody?: boolean;
  /** content가 비었을 때 쓸 문구 키 */
  emptyKey?: 'attachment' | 'reminderFallback';
  url?: string;
}

export function renderPush(locale: PushLocale, spec: PushSpec): { title: string; body: string; url?: string } {
  const sender = spec.sender?.trim() ? spec.sender : pushT(locale, 'unknownSender');
  const title = pushT(locale, spec.titleKey, { channel: spec.channel ?? '', sender });
  // 빈 본문 판정은 모든 경로에서 trim 기준이다(공백만 있으면 비어 있는 것으로 본다)
  const raw = spec.content ?? '';
  const content = raw.trim() ? raw.slice(0, 100) : '';
  const empty = pushT(locale, spec.emptyKey ?? 'attachment');
  const body = spec.plainBody ? content || empty : pushT(locale, 'body', { sender, content: content || empty });
  return { title, body, url: spec.url };
}
