import i18n, { t } from '@/lib/i18n';
import type { CustomStatus, Dnd } from '@/lib/types';
import { createFileTokenCache, buildFileUrl, type TokenResponse, type TokenState } from '@/lib/fileTokens';

/**
 * 파일별 다운로드 토큰. 캐시·갱신·거부 처리 로직은 lib/fileTokens.ts(순수)에 있고 여기서는 fetch만 붙인다.
 * <img>·<a>는 Authorization 헤더를 못 붙이므로 URL 쿼리에 파일 하나에 묶인 5분짜리 토큰을 싣는다.
 * 토큰이 없으면 URL을 만들지 않는다(null). 호출한 쪽이 자리표시자를 그린다.
 */
async function fetchFileTokens(fileIds: number[]): Promise<TokenResponse | null> {
  const authToken = localStorage.getItem('token');
  if (!authToken) return null;
  const res = await fetch('/files/download-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ fileIds }),
  });
  if (!res.ok) return null;
  return (await res.json()) as TokenResponse;
}

const fileTokenCache = createFileTokenCache({ fetchTokens: fetchFileTokens });

export const subscribeDownloadTokens = fileTokenCache.subscribe;

/** 파일 토큰을 미리 받아 둔다(메시지 목록을 받았을 때 등). 이미 있거나 요청 중인 것은 건너뛴다. */
export function prefetchFileTokens(fileIds: number[]): void {
  fileTokenCache.ensure(fileIds);
}

export function getFileTokenState(fileId: number): TokenState {
  return fileTokenCache.peek(fileId);
}

/**
 * 파일 다운로드 URL(파일별 토큰 포함). 토큰이 아직 없거나 접근 불가면 null이다.
 * 렌더 중에는 토큰을 요청하지 않는다. 요청은 prefetchFileTokens나 useFileUrl 훅이 한다.
 */
export function getFileUrl(fileId: number, opts: { download?: boolean } = {}): string | null {
  return buildFileUrl(fileId, fileTokenCache.peek(fileId), opts);
}

/** Clear cached download tokens (call on logout). 늦게 도착한 응답은 세대 번호로 버린다. */
export function clearDownloadToken(): void {
  fileTokenCache.clear();
}

export class ApiError extends Error {
  status: number;
  /** Machine-readable error code from the server (e.g. CHANNEL_NAME_TAKEN) */
  code?: string;
  reason?: string;
  /** VALIDATION_FAILED일 때 어떤 필드가 왜 틀렸는지(path, zod 사유 코드) */
  fields?: Array<{ path: string; reason: string }>;

  constructor(message: string, status: number, code?: string, reason?: string, fields?: Array<{ path: string; reason: string }>) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.fields = fields;
    this.name = 'ApiError';
  }
}

async function request<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('token');

  const res = await fetch(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: t('errors:client.requestFailed') }));
    // Auto-logout on 401 (expired/invalid token).
    // Guard: only redirect once — concurrent 401s after token removal are no-ops.
    // Uses hard reload (window.location) so all in-memory Zustand state is wiped.
    if (res.status === 401 && localStorage.getItem('token')) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    const errorMsg = Array.isArray(body.error)
      ? body.error.map((e: { message?: string }) => e.message || t('errors:client.validation')).join(', ')
      : body.error || t('errors:client.requestFailed');
    throw new ApiError(errorMsg, res.status, body.code, body.reason, Array.isArray(body.fields) ? body.fields : undefined);
  }

  return res.json();
}

// ---- Auth ----

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  avatar?: string | null;
  role?: 'ADMIN' | 'MEMBER' | 'GUEST';
  locale?: string | null;
  timeZone?: string | null;
  createdAt: string;
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
}

export function login(email: string, password: string) {
  return request<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register(name: string, email: string, password: string, inviteCode?: string) {
  return request<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, name, ...(inviteCode ? { inviteCode } : {}) }),
  });
}

export function validateInvite(code: string) {
  return request<{ valid: boolean; role: string }>(`/auth/invite/${encodeURIComponent(code)}`);
}

// ---- Channels ----

export interface ApiChannel {
  id: number;
  name: string;
  isPrivate: boolean;
  topic?: string | null;
  description?: string | null;
  isStarred?: boolean;
  createdAt: string;
  unreadCount: number;
  mentionCount?: number;
  isMember: boolean;
  _count: { members: number; messages: number };
}

export interface ApiChannelDetail extends ApiChannel {
  createdBy?: number | null;
  /** 열기 직전의 읽음 기준점(멤버만). 안 읽음 구분선에 쓴다 */
  lastReadMessageId?: number | null;
  members: Array<{
    userId: number;
    channelId: number;
    role: 'OWNER' | 'MODERATOR' | 'MEMBER';
    joinedAt: string;
    user: {
      id: number;
      name: string;
      avatar?: string | null;
    };
  }>;
}

export function getChannels() {
  return request<ApiChannel[]>('/channels');
}

export function getChannel(id: number, opts?: { withUnread?: boolean }) {
  return request<ApiChannelDetail>(`/channels/${id}${opts?.withUnread ? '?withUnread=1' : ''}`);
}

export interface ChannelMetaUpdate {
  name?: string;
  topic?: string | null;
  description?: string | null;
}

export function updateChannel(id: number, data: ChannelMetaUpdate) {
  return request<ApiChannel>(`/channels/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function starChannel(id: number) {
  return request<{ channelId: number; isStarred: boolean }>(`/channels/${id}/star`, { method: 'PUT' });
}

export function unstarChannel(id: number) {
  return request<{ channelId: number; isStarred: boolean }>(`/channels/${id}/star`, { method: 'DELETE' });
}

export function starDM(userId: number) {
  return request<{ userId: number; isStarred: boolean }>(`/dms/${userId}/star`, { method: 'PUT' });
}

export function unstarDM(userId: number) {
  return request<{ userId: number; isStarred: boolean }>(`/dms/${userId}/star`, { method: 'DELETE' });
}

export interface SidebarCollapsed {
  starred: boolean;
  channels: boolean;
  dms: boolean;
}

export function getSidebarPrefs() {
  return request<{ collapsed: SidebarCollapsed }>('/users/me/sidebar');
}

export function updateSidebarPrefs(collapsed: Partial<SidebarCollapsed>) {
  return request<{ collapsed: SidebarCollapsed }>('/users/me/sidebar', {
    method: 'PATCH',
    body: JSON.stringify({ collapsed }),
  });
}

export function createChannel(name: string, isPrivate = false) {
  return request<ApiChannel>('/channels', {
    method: 'POST',
    body: JSON.stringify({ name, isPrivate }),
  });
}

export function joinChannel(id: number) {
  return request<{ message: string }>(`/channels/${id}/join`, { method: 'POST' });
}

export function leaveChannel(id: number) {
  return request<{ message: string }>(`/channels/${id}/leave`, { method: 'POST' });
}

export function markChannelReadBaseline(channelId: number) {
  return request<{ success: boolean }>(`/channels/${channelId}/read/baseline`, { method: 'POST' });
}

export function markChannelRead(channelId: number, messageId: number) {
  return request<{ success: boolean }>(`/channels/${channelId}/read`, {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  });
}

export function markChannelUnread(channelId: number, messageId: number) {
  return request<{ success: boolean }>(`/channels/${channelId}/unread`, {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  });
}

export function markDMUnread(userId: number, messageId: number) {
  return request<{ markedAsUnread: number }>(`/dms/${userId}/unread`, {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  });
}

export function pinDM(dmId: number) {
  return request(`/dms/messages/${dmId}/pin`, { method: 'POST' });
}

export function unpinDM(dmId: number) {
  return request(`/dms/messages/${dmId}/pin`, { method: 'DELETE' });
}

export function getPinnedDMs(userId: number) {
  return request<ApiDirectMessage[]>(`/dms/${userId}/pins`);
}

// ---- Messages ----

export interface ApiReaction {
  id: number;
  emoji: string;
  userId: number;
  messageId: number;
  createdAt: string;
  user: { id: number; name: string };
}

// ---- Activity ----

export type ActivityType = 'MENTION' | 'CHANNEL_MENTION' | 'HERE_MENTION' | 'THREAD_REPLY' | 'REACTION' | 'REMINDER';
export type ActivityFilter = 'all' | 'mentions' | 'threads' | 'reactions';

export interface ApiActivity {
  id: number;
  type: ActivityType;
  actor: { id: number; name: string; avatar?: string | null };
  channel: { id: number; name: string } | null;
  channelId: number | null;
  messageId: number | null;
  dmId: number | null;
  /** 그룹 DM 활동이면 그룹 id */
  dmGroupId?: number | null;
  /** 1:1 DM 활동의 상대 userId(리마인더 활동에서 이동용) */
  dmUserId?: number | null;
  threadId: number | null;
  /** 리마인더 활동은 대상이 없거나 지워졌을 수 있어 null */
  message: { id: number; content: string; excerpt: string } | null;
  reminder?: { id: number; text: string | null } | null;
  emoji: string | null;
  readAt: string | null;
  createdAt: string;
}

export function getActivity(type: ActivityFilter, cursor?: number, limit = 30) {
  const params = new URLSearchParams({ type, limit: String(limit) });
  if (cursor) params.set('cursor', String(cursor));
  return request<{ items: ApiActivity[]; nextCursor: number | null }>(`/activity?${params}`);
}

export function getActivityUnreadCount() {
  return request<{ total: number; mentions: number }>('/activity/unread-count');
}

export function getMentionCounts() {
  return request<{ channels: Record<string, number>; dms: Record<string, number>; groups?: Record<string, number> }>(
    '/activity/mention-counts',
  );
}

export function markActivityRead(body: { ids: number[] } | { all: true }) {
  return request<{ updated: number; ids: number[] }>('/activity/read', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface ApiMessageFile {
  id: number;
  filename: string;
  originalName?: string;
  mimetype: string;
  size: number;
  url: string;
}

export interface ApiMessage {
  id: number;
  content: string;
  userId: number;
  channelId: number;
  threadId: number | null;
  alsoSendToChannel?: boolean;
  parent?: { id: number; content: string; deletedAt?: string | null; user: { id: number; name: string } } | null;
  isPinned?: boolean;
  pinnedBy?: number | null;
  pinnedAt?: string | null;
  editedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  user: { id: number; name: string; email: string; avatar?: string | null };
  channel?: { id: number; name: string };
  reactions: ApiReaction[];
  files: ApiMessageFile[];
  _count: { replies: number };
  threadParticipants?: { id: number; name: string; avatar: string | null }[];
}

export interface MessagesResponse {
  messages: ApiMessage[];
  nextCursor?: number;
  hasMore: boolean;
}

/** 퍼말링크의 메시지가 어느 대화에 있는지 묻는다. 없음/삭제됨/권한 없음은 모두 404다. */
export interface LocatedMessage {
  messageId: number;
  channelId?: number;
  dmUserId?: number;
  groupId?: number;
  /** 스레드 답글이면 부모 id */
  parentId?: number;
  /** 삭제됐지만 살아 있는 답글이 남은 부모(자리표시자) */
  deleted?: boolean;
}

export function locateMessage(messageId: number, kind: 'channel' | 'dm') {
  return request<LocatedMessage>(`/messages/${messageId}/locate?kind=${kind}`);
}

export function getMessages(channelId: number, cursor?: number, limit = 50, around?: number) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', String(cursor));
  if (around) params.set('around', String(around));
  return request<MessagesResponse>(`/channels/${channelId}/messages?${params}`);
}

export function sendMessage(channelId: number, content: string, fileIds?: number[]): Promise<ApiMessage> {
  return request<ApiMessage>(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, ...(fileIds?.length ? { fileIds } : {}) }),
  });
}

// ---- Reactions ----

export function addReaction(messageId: number, emoji: string) {
  return request<ApiReaction>(`/messages/${messageId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
}

export function removeReaction(messageId: number, emoji: string) {
  return request<{ message: string }>(
    `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
    { method: 'DELETE' },
  );
}

// ---- Pins ----

export function pinMessage(messageId: number) {
  return request<ApiMessage>(`/messages/${messageId}/pin`, { method: 'POST' });
}

export function unpinMessage(messageId: number) {
  return request<ApiMessage>(`/messages/${messageId}/pin`, { method: 'DELETE' });
}

export function getPinnedMessages(channelId: number) {
  return request<ApiMessage[]>(`/channels/${channelId}/pins`);
}

// ---- Threads ----

export function getThread(messageId: number) {
  return request<{ parent: ApiMessage; replies: ApiMessage[] }>(
    `/messages/${messageId}/thread`,
  );
}

export function replyToMessage(messageId: number, content: string, fileIds?: number[], alsoSendToChannel?: boolean) {
  return request<ApiMessage>(`/messages/${messageId}/reply`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      ...(fileIds?.length ? { fileIds } : {}),
      ...(alsoSendToChannel ? { alsoSendToChannel: true } : {}),
    }),
  });
}

// ---- Threads view ----

export interface ApiThreadItem {
  parent: ApiMessage;
  channel: { id: number; name: string; isPrivate: boolean };
  replyCount: number;
  unreadCount: number;
  replies: ApiMessage[];
  lastReply: ApiMessage | null;
  lastActivityAt: string;
}

export function getThreads(cursor?: number, limit = 20) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set('cursor', String(cursor));
  return request<{ items: ApiThreadItem[]; nextCursor?: number }>(`/threads?${params}`);
}

export function getThreadUnreadCount() {
  return request<{ count: number }>('/threads/unread-count');
}

export function markThreadRead(parentId: number, lastReadReplyId?: number) {
  return request<{ success: boolean; lastReadReplyId: number | null }>(`/threads/${parentId}/read`, {
    method: 'POST',
    body: JSON.stringify(lastReadReplyId ? { lastReadReplyId } : {}),
  });
}

/** 답글의 "채널에도 보내기"를 사후에 켜고 끈다. */
export function setReplyBroadcast(messageId: number, on: boolean) {
  return request<ApiMessage>(`/messages/${messageId}/broadcast`, { method: on ? 'POST' : 'DELETE' });
}

// ---- Messages (edit/delete) ----

export function editMessage(messageId: number, content: string) {
  return request<ApiMessage>(`/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });
}

export function deleteMessage(messageId: number) {
  return request<{ message: string }>(`/messages/${messageId}`, {
    method: 'DELETE',
  });
}

// ---- Search ----

export interface SearchResult {
  id: number;
  type: 'message' | 'dm';
  content: string;
  createdAt: string;
  user: { id: number; name: string; email: string; avatar?: string | null };
  channel?: { id: number; name: string };
  participant?: { id: number; name: string; email: string };
  /** 그룹 DM 메시지면 그룹 id */
  groupId?: number | null;
  /** 스레드 답글이면 부모 메시지 id */
  threadId?: number | null;
  /** content 안의 일치 구간 [시작, 끝) 목록. 프런트가 <mark>로 렌더한다 */
  highlights?: Array<[number, number]>;
}

export interface SearchFileResult {
  id: number;
  type: 'file';
  filename: string;
  mimetype: string;
  size: number;
  url: string;
  createdAt: string;
  user: { id: number; name: string; avatar?: string | null };
  channel?: { id: number; name: string };
  groupId?: number | null;
  participantId?: number | null;
  messageId?: number | null;
  dmId?: number | null;
  highlights?: Array<[number, number]>;
}

export interface SearchPersonResult {
  id: number;
  type: 'person';
  name: string;
  avatar?: string | null;
  highlights?: Array<[number, number]>;
}

export interface SearchChannelResult {
  id: number;
  type: 'channel';
  name: string;
  topic?: string | null;
  isPrivate: boolean;
  isMember: boolean;
  archived: boolean;
  highlights?: Array<[number, number]>;
}

export type SearchTab = 'messages' | 'files' | 'people' | 'channels';
export type SearchSort = 'relevance' | 'recent';

/** 서버가 질의에서 해석한 필터. 연산자 이름은 번역하지 않는 고정 문법이다 */
export interface SearchParsedFilters {
  terms: string[];
  from: string[];
  in: string[];
  before?: string;
  after?: string;
  on?: string;
  has: string[];
  is: string[];
  /** 무시된 토큰: 상한을 넘은 연산자 값·키워드(limit) 또는 한 글자 키워드(short) */
  ignored?: Array<{ token: string; reason: 'limit' | 'short' }>;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  /** 이번 페이지에 담긴 결과의 종류별 개수다. 전체 일치 개수가 아니다 */
  counts: { messages: number; dms: number; total: number };
  parsedFilters?: SearchParsedFilters;
  hasMore?: boolean;
  /** 결과가 상한(450)에 닿아 잘렸으면 true */
  truncated?: boolean;
  nextCursor?: string | null;
}

export interface SearchPageResponse extends Omit<SearchResponse, 'results'> {
  results: Array<SearchResult | SearchFileResult | SearchPersonResult | SearchChannelResult>;
}

/** 날짜 연산자(on:, before:, after:)를 사용자의 하루 경계로 해석하도록 서버에 보내는 IANA 시간대 */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function searchMessages(query: string, channelId?: number, limit?: number) {
  const params = new URLSearchParams({ q: query, tz: localTimeZone() });
  if (channelId) params.set('channelId', String(channelId));
  if (limit) params.set('limit', String(limit));
  return request<SearchResponse>(`/search?${params}`);
}

/** 검색 페이지용: 탭, 정렬, 커서를 지원한다. 메시지 탭은 채널 메시지와 DM을 함께 돌려준다 */
export function searchAll(query: string, opts: { tab: SearchTab; sort: SearchSort; cursor?: string | null; limit?: number }) {
  const params = new URLSearchParams({ q: query, type: opts.tab === 'messages' ? 'all' : opts.tab, sort: opts.sort, tz: localTimeZone() });
  params.set('limit', String(opts.limit ?? 20));
  if (opts.cursor) params.set('cursor', opts.cursor);
  return request<SearchPageResponse>(`/search?${params}`);
}

// ---- Files ----

export interface ApiFile {
  id: number;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  url: string;
}

export interface ApiFileWithUser extends ApiFile {
  createdAt: string;
  user: { id: number; name: string; email: string; avatar?: string | null };
}

export function getChannelFiles(channelId: number) {
  return request<ApiFileWithUser[]>(`/channels/${channelId}/files`);
}

export function getUserFiles() {
  return request<ApiFileWithUser[]>('/files');
}

export async function uploadFile(file: File): Promise<ApiFile> {
  const token = localStorage.getItem('token');
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/files', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: t('errors:client.uploadFailed') }));
    throw new ApiError(body.error || t('errors:client.uploadFailed'), res.status);
  }

  return res.json();
}

// ---- Users ----

export function getUsers(search?: string) {
  const params = new URLSearchParams({ limit: '50' });
  if (search) params.set('search', search);
  return request<AuthUser[]>(`/users?${params}`);
}

// ---- User Profile ----

export interface UserProfile {
  id: number;
  email: string;
  name: string;
  avatar?: string | null;
  role?: 'ADMIN' | 'MEMBER' | 'GUEST';
  locale?: string | null;
  timeZone?: string | null;
  status?: string;
  bio?: string | null;
  createdAt: string;
  _count?: { messages: number; channels: number };
  customStatus?: CustomStatus | null;
  dnd?: Dnd;
}

export function getMyProfile() {
  return request<UserProfile>('/users/me');
}

export function updateMyProfile(data: { name?: string; avatar?: string | null; status?: string; bio?: string | null; locale?: string | null; timeZone?: string | null }) {
  return request<UserProfile>('/users/me', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function uploadAvatar(file: Blob): Promise<UserProfile> {
  const token = localStorage.getItem('token');
  const formData = new FormData();
  formData.append('avatar', file);

  const res = await fetch('/users/me/avatar', {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: t('errors:client.uploadFailed') }));
    throw new ApiError(body.error || t('errors:client.uploadFailed'), res.status);
  }

  return res.json();
}

export function getUserProfile(userId: number) {
  return request<UserProfile>(`/users/${userId}`);
}

// ---- 커스텀 상태와 방해금지 ----

export interface StatusResult {
  id: number;
  customStatus: CustomStatus | null;
  dnd: Dnd;
}

export function setCustomStatus(data: { emoji?: string | null; text?: string | null; expiresAt?: string | null; pauseNotifications?: boolean }) {
  return request<StatusResult>('/users/me/custom-status', { method: 'PUT', body: JSON.stringify(data) });
}

export function clearCustomStatus() {
  return request<StatusResult>('/users/me/custom-status', { method: 'DELETE' });
}

export function getDnd() {
  return request<Dnd>('/users/me/dnd');
}

export function startDnd(data: { minutes?: number; until?: string }) {
  return request<Dnd>('/users/me/dnd', { method: 'POST', body: JSON.stringify(data) });
}

export function endDnd() {
  return request<Dnd>('/users/me/dnd', { method: 'DELETE' });
}

// ---- Direct Messages ----

export interface ApiDMConversation {
  otherUser: { id: number; name: string; email: string; avatar?: string | null; status?: string; customStatus?: CustomStatus | null; dnd?: Dnd };
  lastMessage: { content: string; createdAt: string; fromUserId: number } | null;
  unreadCount: number;
  mentionCount?: number;
  isStarred?: boolean;
}

export interface ApiDMReaction {
  id: number;
  emoji: string;
  userId: number;
  dmId: number;
  user: { id: number; name: string };
}

export interface ApiDirectMessage {
  id: number;
  content: string;
  fromUserId: number;
  /** 그룹 DM 메시지는 null (groupId로 먼저 분기한다) */
  toUserId: number | null;
  groupId?: number | null;
  threadId?: number | null;
  isPinned?: boolean;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  fromUser: { id: number; name: string; email: string; avatar?: string | null };
  toUser: { id: number; name: string; email: string; avatar?: string | null } | null;
  reactions?: ApiDMReaction[];
  files?: ApiMessageFile[];
  _count?: { replies: number };
  threadParticipants?: { id: number; name: string; avatar: string | null }[];
}

export function getDirectMessages() {
  return request<ApiDMConversation[]>('/dms');
}

/** 안 읽음 구분선 기준점(?withUnread=1일 때만). 열기 직전 값이고, unreadCount는 내 메시지를 포함한다 */
export interface ApiDMUnreadBaseline {
  lastReadId?: number | null;
  unreadCount?: number;
}

export function getConversation(userId: number, cursor?: number, around?: number, withUnread?: boolean) {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', String(cursor));
  if (around) params.set('around', String(around));
  if (withUnread) params.set('withUnread', '1');
  return request<{ messages: ApiDirectMessage[]; hasMore: boolean } & ApiDMUnreadBaseline>(`/dms/${userId}?${params}`);
}

export function markDMRead(userId: number) {
  return request<{ markedAsRead: number }>(`/dms/${userId}/read`, { method: 'POST' });
}

export function sendDM(toUserId: number, content: string, fileIds?: number[]) {
  return request<ApiDirectMessage>('/dms', {
    method: 'POST',
    body: JSON.stringify({ toUserId, content, fileIds }),
  });
}

export function editDM(dmId: number, content: string) {
  return request<ApiDirectMessage>(`/dms/messages/${dmId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });
}

export function deleteDM(dmId: number) {
  return request<{ message: string }>(`/dms/messages/${dmId}`, {
    method: 'DELETE',
  });
}

export function getDMThread(dmId: number) {
  return request<{ parent: ApiDirectMessage; replies: ApiDirectMessage[] }>(
    `/dms/messages/${dmId}/thread`,
  );
}

export function replyToDM(dmId: number, content: string, fileIds?: number[]) {
  return request<ApiDirectMessage>(`/dms/messages/${dmId}/reply`, {
    method: 'POST',
    body: JSON.stringify({ content, fileIds }),
  });
}

export function addDMReaction(dmId: number, emoji: string) {
  return request<ApiDMReaction>(`/dms/messages/${dmId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
}

export function removeDMReaction(dmId: number, emoji: string) {
  return request<{ message: string }>(`/dms/messages/${dmId}/reactions/${encodeURIComponent(emoji)}`, {
    method: 'DELETE',
  });
}

// ---- Group DMs ----

export interface ApiDMGroupMember {
  id: number;
  name: string;
  avatar: string | null;
  status: string | null;
}

export interface ApiDMGroup {
  id: number;
  name: string | null;
  createdBy: number;
  createdAt: string;
  members: ApiDMGroupMember[];
}

export interface ApiGroupConversation {
  type: 'group';
  group: ApiDMGroup;
  lastMessage: { id: number; content: string; fromUserId: number; createdAt: string } | null;
  unreadCount: number;
  mentionCount: number;
  isStarred: boolean;
}

export function getDMGroups() {
  return request<ApiGroupConversation[]>('/dms/groups');
}

export function createDMGroup(userIds: number[]) {
  return request<{ group: ApiDMGroup; created: boolean }>('/dms/groups', {
    method: 'POST',
    body: JSON.stringify({ userIds }),
  });
}

export function renameDMGroup(groupId: number, name: string | null) {
  return request<{ group: ApiDMGroup }>(`/dms/groups/${groupId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export function getDMGroupMessages(groupId: number, cursor?: number, around?: number, withUnread?: boolean) {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', String(cursor));
  if (around) params.set('around', String(around));
  if (withUnread) params.set('withUnread', '1');
  // group은 첫 페이지(cursor 없음)에만 실린다
  return request<{ group?: ApiDMGroup; messages: ApiDirectMessage[]; hasMore: boolean } & ApiDMUnreadBaseline>(
    `/dms/groups/${groupId}/messages?${params}`,
  );
}

export function sendDMGroupMessage(groupId: number, content: string, fileIds?: number[]) {
  return request<ApiDirectMessage>(`/dms/groups/${groupId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content, fileIds }),
  });
}

export function addDMGroupMembers(groupId: number, userIds: number[]) {
  return request<{ group: ApiDMGroup; addedUserIds: number[] }>(`/dms/groups/${groupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userIds }),
  });
}

export function leaveDMGroup(groupId: number) {
  return request<{ left: boolean }>(`/dms/groups/${groupId}/members/me`, { method: 'DELETE' });
}

export function markDMGroupRead(groupId: number, messageId?: number) {
  return request<{ lastReadDmId: number | null }>(`/dms/groups/${groupId}/read`, {
    method: 'POST',
    body: JSON.stringify(messageId ? { messageId } : {}),
  });
}

export function getDMGroupPins(groupId: number) {
  return request<ApiDirectMessage[]>(`/dms/groups/${groupId}/pins`);
}

export function starDMGroup(groupId: number) {
  return request<{ groupId: number; isStarred: boolean }>(`/dms/groups/${groupId}/star`, { method: 'PUT' });
}

export function unstarDMGroup(groupId: number) {
  return request<{ groupId: number; isStarred: boolean }>(`/dms/groups/${groupId}/star`, { method: 'DELETE' });
}

// ---- Bookmarks ----

export interface ApiBookmark {
  messageId: number;
  createdAt: string;
}

export function getBookmarks() {
  return request<ApiBookmark[]>('/bookmarks');
}

export function addBookmark(messageId: number) {
  return request<ApiBookmark>(`/messages/${messageId}/bookmark`, { method: 'POST' });
}

export function removeBookmark(messageId: number) {
  return request<{ message: string }>(`/messages/${messageId}/bookmark`, { method: 'DELETE' });
}

// ---- Reminders ----

export interface ApiReminder {
  id: number;
  messageId: number | null;
  dmId: number | null;
  channelId: number | null;
  text: string | null;
  remindAt: string;
  firedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  channel: { id: number; name: string } | null;
  messageDeleted: boolean;
  message: { id: number; excerpt: string; user: { id: number; name: string }; threadId: number | null } | null;
  dmUserId: number | null;
  dmGroupId: number | null;
}

export function getReminders(status: 'pending' | 'done', cursor?: number) {
  const params = new URLSearchParams({ status });
  if (cursor) params.set('cursor', String(cursor));
  return request<{ items: ApiReminder[]; nextCursor: number | null }>(`/reminders?${params}`);
}

export function createReminder(body: { messageId?: number; dmId?: number; text?: string; remindAt: string }) {
  // 푸시 문구 언어를 정하도록 앱 언어를 Accept-Language로 알린다
  return request<ApiReminder>('/reminders', {
    method: 'POST',
    headers: { 'Accept-Language': i18n.language || 'ko' },
    body: JSON.stringify(body),
  });
}

export function updateReminder(id: number, body: { remindAt: string } | { completed: boolean }) {
  return request<ApiReminder>(`/reminders/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export function deleteReminder(id: number) {
  return request<{ message: string }>(`/reminders/${id}`, { method: 'DELETE' });
}

// ---- Unreads ----

export function getUnreadMessages(cursor?: number, limit = 50) {
  const params = new URLSearchParams({ limit: limit.toString() });
  if (cursor) params.append('cursor', cursor.toString());
  return request<{
    messages: ApiMessage[];
    nextCursor?: number;
    hasMore: boolean;
  }>(`/unreads?${params}`);
}

// ---- Channel Members ----

export interface ChannelMember {
  userId: number;
  channelId: number;
  channelRole?: 'OWNER' | 'MODERATOR' | 'MEMBER';
  joinedAt: string;
  user: {
    id: number;
    name: string;
    email: string;
    avatar?: string | null;
    status: string;
    isOnline: boolean;
    lastSeen?: string;
  };
}

export function getChannelMembers(channelId: number) {
  return request<ChannelMember[]>(`/channels/${channelId}/members`);
}

export function addChannelMember(channelId: number, userId: number) {
  return request<{ message: string }>(`/channels/${channelId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export function removeChannelMember(channelId: number, userId: number) {
  return request<{ message: string }>(`/channels/${channelId}/members/${userId}`, {
    method: 'DELETE',
  });
}

// ---- Scheduled Messages ----

export interface ApiScheduledMessage {
  id: number;
  content: string;
  channelId: number;
  userId: number;
  scheduledAt: string;
  createdAt: string;
  sent: boolean;
  channel: { id: number; name: string };
}

export function scheduleMessage(channelId: number, content: string, scheduledAt: Date) {
  return request<ApiScheduledMessage>('/messages/schedule', {
    method: 'POST',
    body: JSON.stringify({ channelId, content, scheduledAt: scheduledAt.toISOString() }),
  });
}

export function getScheduledMessages() {
  return request<ApiScheduledMessage[]>('/messages/scheduled');
}

export function cancelScheduledMessage(id: number) {
  return request<{ success: boolean }>(`/messages/scheduled/${id}`, { method: 'DELETE' });
}

export function editScheduledMessage(id: number, data: { content?: string; scheduledAt?: string }) {
  return request<ApiScheduledMessage>(`/messages/scheduled/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function sendScheduledMessageNow(id: number) {
  return request<{ success: boolean; message: unknown }>(`/messages/scheduled/${id}/send`, {
    method: 'POST',
  });
}

// ---- Admin ----

export interface AdminUser {
  id: number;
  email: string;
  name: string;
  avatar?: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
  status?: string;
  deactivatedAt?: string | null;
  createdAt: string;
}

export interface AdminChannel {
  id: number;
  name: string;
  isPrivate: boolean;
  createdBy?: number | null;
  archivedAt?: string | null;
  createdAt: string;
  _count: { members: number; messages: number };
}

export interface AuditLogEntry {
  id: number;
  action: string;
  actorId: number;
  targetType: string;
  targetId?: number | null;
  targetName?: string | null;
  details?: string | null;
  createdAt: string;
  actor: { id: number; name: string; avatar?: string | null } | null;
}

export interface AuditLogFilter {
  action: string[];
  actorId?: number;
  targetType?: string;
  /** ISO 8601 (UTC 기준으로 해석된다) */
  from?: string;
  to?: string;
}

export interface AuditLogPage {
  items: AuditLogEntry[];
  nextCursor: number | null;
}

export interface AdminInvite {
  id: number;
  code: string;
  createdBy: number;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST';
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  createdAt: string;
  creator: { id: number; name: string };
}

export function adminGetUsers() {
  return request<AdminUser[]>('/admin/users');
}

export function adminTransferOwnership(userId: number) {
  return request<{ message: string }>('/admin/transfer-ownership', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export function adminUpdateUserRole(userId: number, role: 'ADMIN' | 'MEMBER' | 'GUEST') {
  return request<AdminUser>(`/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

/** 로그인된 기기 한 개(E7). current는 이 요청을 보낸 기기다. */
export interface UserSession {
  id: string;
  current: boolean;
  /** 서버가 코드와 고유명사만 보낸다. 문구는 화면이 번역 키로 만든다. */
  device: { client: 'desktop' | 'browser' | 'unknown'; browser: string | null; os: string | null } | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export function listMySessions() {
  return request<UserSession[]>('/users/me/sessions');
}

export function revokeMySession(id: string) {
  return request<{ message: string; current: boolean }>(`/users/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function revokeOtherSessions() {
  return request<{ revoked: number }>('/users/me/sessions', { method: 'DELETE' });
}

export function adminForceLogout(userId: number) {
  return request<{ message: string }>(`/admin/users/${userId}/force-logout`, { method: 'POST' });
}

export function adminDeactivateUser(userId: number) {
  return request<AdminUser>(`/admin/users/${userId}/deactivate`, { method: 'POST' });
}

export function adminReactivateUser(userId: number) {
  return request<AdminUser>(`/admin/users/${userId}/reactivate`, { method: 'POST' });
}

export function adminGetChannels() {
  return request<AdminChannel[]>('/admin/channels');
}

export function adminDeleteChannel(channelId: number) {
  return request<{ message: string }>(`/admin/channels/${channelId}`, { method: 'DELETE' });
}

export function adminArchiveChannel(channelId: number) {
  return request<AdminChannel>(`/admin/channels/${channelId}/archive`, { method: 'POST' });
}

export function adminUnarchiveChannel(channelId: number) {
  return request<AdminChannel>(`/admin/channels/${channelId}/unarchive`, { method: 'POST' });
}

export function adminEditChannel(channelId: number, data: { name?: string; isPrivate?: boolean }) {
  return request<AdminChannel>(`/admin/channels/${channelId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function adminRemoveChannelMember(channelId: number, userId: number) {
  return request<{ message: string }>(`/admin/channels/${channelId}/members/${userId}`, {
    method: 'DELETE',
  });
}

function auditQuery(filter: AuditLogFilter): URLSearchParams {
  const q = new URLSearchParams();
  for (const a of filter.action) q.append('action', a);
  if (filter.actorId) q.set('actorId', String(filter.actorId));
  if (filter.targetType) q.set('targetType', filter.targetType);
  if (filter.from) q.set('from', filter.from);
  if (filter.to) q.set('to', filter.to);
  return q;
}

export function adminListAuditLogs(filter: AuditLogFilter, cursor?: number | null, limit = 50, signal?: AbortSignal) {
  const q = auditQuery(filter);
  q.set('limit', String(limit));
  if (cursor) q.set('cursor', String(cursor));
  return request<AuditLogPage>(`/admin/audit-logs?${q.toString()}`, { signal });
}

/**
 * 내보내기 주소를 만든다. 60초짜리 1회용 토큰을 받아 주소에 붙인다. 브라우저가 이 주소로 파일을 디스크에 바로 받는다(메모리에 올리지 않는다).
 * 토큰은 형식과 필터에 묶여 있어서 같은 값으로 URL을 만든다.
 */
export async function adminAuditExportUrl(filter: AuditLogFilter, format: 'csv' | 'json'): Promise<string> {
  const { token } = await request<{ token: string }>('/admin/audit-logs/export-token', {
    method: 'POST',
    body: JSON.stringify({ ...filter, format }),
  });
  const q = auditQuery(filter);
  q.set('format', format);
  q.set('token', token);
  return `/admin/audit-logs/export?${q.toString()}`;
}

export function adminGetInvites() {
  return request<AdminInvite[]>('/admin/invites');
}

export function adminCreateInvite(data: { role?: string; maxUses?: number | null; expiresAt?: string | null }) {
  return request<AdminInvite>('/admin/invites', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function adminDeleteInvite(inviteId: number) {
  return request<{ message: string }>(`/admin/invites/${inviteId}`, { method: 'DELETE' });
}

// ---- Webhooks ----

export interface AdminWebhook {
  id: number;
  name: string;
  channelId: number;
  token: string;
  createdBy: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  channel: { id: number; name: string };
  creator: { id: number; name: string };
}

export function adminGetWebhooks(channelId?: number) {
  const params = channelId ? `?channelId=${channelId}` : '';
  return request<AdminWebhook[]>(`/webhooks${params}`);
}

export function adminCreateWebhook(data: { name: string; channelId: number }) {
  return request<AdminWebhook>('/webhooks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function adminDeleteWebhook(webhookId: number) {
  return request<{ message: string }>(`/webhooks/${webhookId}`, { method: 'DELETE' });
}

// ---- Huddles ----

export function getHuddleConfig() {
  return request<{ iceServers: RTCIceServer[] }>('/huddles/config');
}

// ---- Personal access tokens (MCP) ----

export type AccessTokenScope =
  | 'channels:read' | 'channels:history' | 'users:read' | 'chat:write' | 'reactions:write'
  | 'im:read' | 'im:history' | 'im:write' | 'search:read' | 'files:read';

export interface AccessToken {
  id: number;
  name: string;
  /** 목록에 보여 주는 앞부분(scpat_xxxxxxxxxxxx). 비밀 부분은 서버도 모른다. */
  prefix: string;
  scopes: AccessTokenScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  expired: boolean;
}

/** 발급 응답에만 원문 token이 들어 있다. 다시 받을 수 없다. */
export interface CreatedAccessToken extends AccessToken {
  token: string;
}

export function listAccessTokens() {
  return request<{ items: AccessToken[]; nextCursor: null }>('/tokens');
}

export function createAccessToken(data: { name: string; scopes: AccessTokenScope[]; expiresInDays: number | null }) {
  return request<CreatedAccessToken>('/tokens', { method: 'POST', body: JSON.stringify(data) });
}

export function renameAccessToken(id: number, name: string) {
  return request<AccessToken>(`/tokens/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

export function revokeAccessToken(id: number) {
  return request<AccessToken>(`/tokens/${id}`, { method: 'DELETE' });
}
