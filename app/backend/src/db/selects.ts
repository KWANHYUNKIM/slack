// Shared Prisma select/include constants for consistent field selection.

export const USER_SELECT_BASIC = {
  id: true,
  name: true,
  avatar: true,
} as const;

export const USER_SELECT_FULL = {
  ...USER_SELECT_BASIC,
  status: true,
  lastSeen: true,
  createdAt: true,
} as const;

export const FILE_SELECT = {
  id: true,
  filename: true,
  originalName: true,
  mimetype: true,
  size: true,
  url: true,
} as const;

export const MESSAGE_INCLUDE_FULL = {
  user: { select: USER_SELECT_BASIC },
  reactions: { include: { user: { select: { id: true, name: true } } } },
  files: { select: FILE_SELECT },
  _count: { select: { replies: { where: { deletedAt: null } } } },
} as const;

export const MESSAGE_INCLUDE_WITH_FILES = {
  user: { select: USER_SELECT_BASIC },
  files: { select: FILE_SELECT },
} as const;

export const THREAD_REPLY_INCLUDE = {
  ...MESSAGE_INCLUDE_WITH_FILES,
  reactions: { include: { user: { select: { id: true, name: true } } } },
} as const;

export const DM_INCLUDE_USERS = {
  fromUser: { select: USER_SELECT_BASIC },
  toUser: { select: USER_SELECT_BASIC },
  reactions: { include: { user: { select: { id: true, name: true } } } },
  files: { select: FILE_SELECT },
} as const;
