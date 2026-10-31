const USER_STATUSES = ['online', 'away', 'dnd', 'offline'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Narrow a server-provided status string; unknown values give undefined. */
export function toUserStatus(status: string | undefined): UserStatus | undefined {
  return USER_STATUSES.find((s) => s === status);
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
  description?: string;
  isPrivate: boolean;
  memberCount: number;
  unreadCount: number;
  isMember: boolean;
  isMuted?: boolean;
  isStarred?: boolean;
}

export interface DirectMessage {
  id: number;
  userId: number;
  userName: string;
  userAvatar: string;
  userStatus: UserStatus;
  unreadCount: number;
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
  isEdited?: boolean;
  isPinned?: boolean;
}
