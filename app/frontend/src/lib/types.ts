const USER_STATUSES = ['online', 'away', 'dnd', 'offline'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Narrow a server-provided status string; unknown values give undefined. */
export function toUserStatus(status: string | undefined): UserStatus | undefined {
  return USER_STATUSES.find((s) => s === status);
}

/** 커스텀 상태(05). 프레즌스(UserStatus)와 별개 값이다. */
export interface CustomStatus {
  emoji: string | null;
  text: string | null;
  expiresAt: string | null;
}

/** 방해금지(05). 타인에게는 켜짐 여부와 끝나는 시각만 온다. */
export interface Dnd {
  active: boolean;
  until: string | null;
}

export interface User {
  id: number;
  name: string;
  email: string;
  avatar?: string | null;
  role?: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
  status?: UserStatus;
  displayName?: string;
}

export interface Channel {
  id: number;
  name: string;
  description?: string | null;
  /** Single-line header text shown next to the channel name */
  topic?: string | null;
  isPrivate: boolean;
  memberCount: number;
  unreadCount: number;
  isMember: boolean;
  isMuted?: boolean;
  isStarred?: boolean;
  /** Unread messages that mention me (shown as a red number) */
  mentionCount: number;
}

export interface DirectMessage {
  id: number;
  userId: number;
  userName: string;
  userAvatar: string;
  userStatus: UserStatus;
  unreadCount: number;
  mentionCount: number;
  isStarred?: boolean;
}

/** 그룹 DM(본인 포함 3~9명) 사이드바 항목 */
export interface GroupDM {
  id: number;
  /** 사용자가 붙인 이름. 없으면 멤버 이름을 나열해 보여 준다 */
  name: string | null;
  members: { id: number; name: string; avatar: string | null; status: UserStatus }[];
  unreadCount: number;
  mentionCount: number;
  isStarred: boolean;
}

export interface Reaction {
  emoji: string;
  count: number;
  userIds: number[];
  userNames: string[];
}

export interface MessageFile {
  id: number;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  url: string;
}

/** Author info embedded in a message (the API does not send email or role). */
export type MessageUser = Pick<User, 'id' | 'name' | 'avatar' | 'displayName'>;

/** Entry in the @mention dropdown; the @here pseudo-user has no email. */
/** Pseudo-user ids for broadcast mentions in the @ dropdown */
export const MENTION_HERE_ID = -1;
export const MENTION_CHANNEL_ID = -2;

export type MentionUser = Pick<User, 'id' | 'name' | 'avatar'>;

export interface Message {
  id: number;
  content: string;
  userId: number;
  user: MessageUser;
  channelId: number;
  createdAt: Date;
  updatedAt?: Date;
  reactions: Reaction[];
  files: MessageFile[];
  threadCount: number;
  threadLastReplyAt?: Date;
  threadParticipants?: { id: number; name: string; avatar: string | null }[];
  /** 스레드 답글이면 부모 id */
  threadId?: number | null;
  /** 스레드 답글을 채널 타임라인에도 보냈는지 */
  alsoSendToChannel?: boolean;
  /** 채널 타임라인의 "스레드에 답글" 머리글에 쓰는 부모 발췌 */
  parentExcerpt?: { id: number; content: string; user: { id: number; name: string } } | null;
  /** 답글이 남은 채널 삭제된 부모(자리표시자) */
  isDeleted?: boolean;
  isEdited?: boolean;
  isPinned?: boolean;
}
