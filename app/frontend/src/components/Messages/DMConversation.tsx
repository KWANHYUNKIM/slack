import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { isToday, isYesterday } from 'date-fns';
import { AuthFileImage, AuthFileMedia, AuthFileLink, AuthFileLightbox } from './AuthFile';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { usePermalinkStore } from '@/stores/usePermalinkStore';
import { copyPermalink } from '@/hooks/useCopyPermalink';
import { formatDate, formatTime, formatTimeShort, formatDateTime } from '@/lib/i18n/format';
import { t as translate } from '@/lib/i18n';
import {
  Pin,
  FileText,
  Star,
  Menu,
  Download,
  FileIcon,
  Search,
  Users,
  UserPlus,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { useAuthStore } from '@/stores/useAuthStore';
import { useDMStore, groupConversationKey } from '@/stores/useDMStore';
import { useChannelStore } from '@/stores/useChannelStore';
import { useUnreadStore } from '@/stores/useUnreadStore';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useMessageEdit } from '@/hooks/useMessageEdit';
import { useProfileStore } from '@/stores/useProfileStore';
import { useBookmarkStore } from '@/stores/useBookmarkStore';
import { MessageToolbar } from './MessageToolbar';
import { MessageActionsMenu } from './MessageActionsMenu';
import { MessageReactions } from './MessageReactions';
import { ThreadIndicator } from './ThreadIndicator';
import { UnreadDivider } from './UnreadDivider';
import { NewMessagesBar } from './NewMessagesBar';
import { PortalEmojiPicker } from '@/components/ui/emoji-picker';
import { MessageInput } from './MessageInput';
import { ThreadPanel } from './ThreadPanel';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { HeaderSearch } from './HeaderSearch';
import { HeaderNotifications } from './HeaderNotifications';
import { HeaderTabs } from './HeaderTabs';
import { MobileSearchOverlay } from './MobileSearchOverlay';
import { PanelHeader } from './PanelHeader';
import { HuddleButton } from '@/components/Huddle/HuddleButton';
import { HuddleSystemMessage } from '@/components/Huddle/HuddleInvite';
import { renderMessageContent } from '@/lib/renderMessageContent';
import {
  markDMUnread, markDMRead, markDMGroupRead, pinDM, unpinDM, getPinnedDMs, getDMGroupPins, createDMGroup,
  type ApiDirectMessage, type AuthUser,
} from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { dmUnreadScope, type UnreadCandidate } from '@/lib/unread';
import { useUnreadDivider } from '@/hooks/useUnreadDivider';
import { groupDisplayName, otherMembers, MAX_GROUP_OTHERS } from '@/lib/groupDM';
import { AddTeammatesDialog } from '@/components/Sidebar/AddTeammatesDialog';
import { GroupMembersPanel } from './GroupMembersPanel';
import { useMobileStore } from '@/stores/useMobileStore';
import type { DMMessage } from '@/stores/useDMStore';

// 1:1 DM은 상대 userId, 그룹 DM은 groupId로 연다. 메시지 목록·전송·편집·리액션은 같은 화면을 쓴다.
type DMConversationProps =
  | { userId: number; userName: string; userAvatar?: string; groupId?: undefined }
  | { groupId: number; userId?: undefined; userName?: undefined; userAvatar?: undefined };

function formatDateSeparator(date: Date): string {
  if (isToday(date)) return translate('common:dates.today');
  if (isYesterday(date)) return translate('common:dates.yesterday');
  return formatDate(date, { weekday: 'long', month: 'long', day: 'numeric' });
}


const EMPTY_MESSAGES: DMMessage[] = [];

const NO_GROUP = { name: null, members: [] };

export function DMConversation(props: DMConversationProps) {
  const { t } = useTranslation('channels');
  const navigate = useNavigate();
  const groupId = props.groupId;
  const isGroup = groupId !== undefined;
  const group = useChannelStore((s) => (isGroup ? s.groupDMs.find((g) => g.id === groupId) : undefined));
  const currentUserIdForName = useAuthStore((s) => s.user?.id);
  // 이 화면에서 userId는 대화 키다(그룹이면 groupConversationKey). 1:1 전용 동작은 isGroup으로 막는다.
  const userId = isGroup ? groupConversationKey(groupId) : props.userId;
  const userName = isGroup ? groupDisplayName(group ?? NO_GROUP, currentUserIdForName) : props.userName;
  const userAvatar = props.userAvatar;
  const messages = useDMStore((s) => s.messages[userId]) ?? EMPTY_MESSAGES;
  const isLoading = useDMStore((s) => s.isLoading);
  const loadError = useDMStore((s) => s.loadError);
  const fetchConversation = useDMStore((s) => s.fetchConversation);
  const sendError = useDMStore((s) => s.sendError);
  const clearSendError = useDMStore((s) => s.clearSendError);
  const storeSendMessage = useDMStore((s) => s.sendMessage);
  const storeEditMessage = useDMStore((s) => s.editMessage);
  const storeDeleteMessage = useDMStore((s) => s.deleteMessage);
  const storeAddReaction = useDMStore((s) => s.addReaction);
  const storeRemoveReaction = useDMStore((s) => s.removeReaction);
  const updateReplyCount = useDMStore((s) => s.updateReplyCount);

  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<number | null>(null);
  const [showMoreMenuId, setShowMoreMenuId] = useState<number | null>(null);
  const [showEmojiPickerId, setShowEmojiPickerId] = useState<number | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState<ApiDirectMessage[]>([]);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [showAddPeople, setShowAddPeople] = useState(false);
  const [addPeopleError, setAddPeopleError] = useState<string | null>(null);
  const toggleDMStar = useChannelStore((s) => s.toggleDMStar);
  const toggleGroupStar = useChannelStore((s) => s.toggleGroupStar);
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [lightboxFileId, setLightboxFileId] = useState<number | null>(null);
  const [lightboxAlt, setLightboxAlt] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const didScrollToTarget = useRef(false);
  const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const currentUser = useAuthStore((s) => s.user);
  const openSidebar = useMobileStore((s) => s.openSidebar);
  const isSelf = !isGroup && userId === currentUser?.id;
  const dmEntry = useChannelStore((s) => (isGroup ? undefined : s.directMessages.find((d) => d.userId === userId)));
  const isStarred = (isGroup ? group?.isStarred : dmEntry?.isStarred) ?? false;
  const openProfile = useProfileStore((s) => s.openProfile);
  const toggleBookmark = useBookmarkStore((s) => s.toggle);
  const bookmarkedIds = useBookmarkStore((s) => s.bookmarkedIds);
  const {
    editingId, editContent, editError, setEditContent, editInputRef,
    startEdit, cancelEdit, saveEdit, handleEditKeyDown,
  } = useMessageEdit({
    onSave: (id, content) => storeEditMessage(id, content, userId),
  });

  const dmScrollToMessageId = useChannelStore((s) => s.dmScrollToMessageId);

  // 안 읽음 구분선: 열 때 받은 기준점을 고정해 쓴다(채널과 같은 훅·컴포넌트)
  const unreadScope = dmUnreadScope(userId);
  const candidates = useMemo<UnreadCandidate[]>(
    () => messages.map((m) => ({ id: m.id, userId: m.fromUserId, threadId: m.threadId })),
    [messages],
  );
  // 서버 읽음 처리: 1:1은 상대 메시지 전부, 그룹은 읽음 커서
  const markServerRead = useCallback((messageId?: number) => {
    (groupId !== undefined ? markDMGroupRead(groupId, messageId) : markDMRead(userId)).catch(() => {});
  }, [groupId, userId]);
  const divider = useUnreadDivider({
    scope: unreadScope,
    candidates,
    myUserId: currentUser?.id,
    loaded: !isLoading && messages.length > 0,
    hasJumpTarget: !!dmScrollToMessageId,
    containerRef: scrollContainerRef,
    endRef: messagesEndRef,
    isAtBottom,
    fetchAround: async (id) => {
      await fetchConversation(userId, id);
      const state = useDMStore.getState();
      if (state.loadError) return null;
      return state.messages[userId]?.[0]?.id ?? null;
    },
    markRead: (lastId) => {
      if (groupId !== undefined) {
        useChannelStore.setState((st) => ({ groupDMs: st.groupDMs.map((g) => (g.id === groupId ? { ...g, unreadCount: 0 } : g)) }));
      } else {
        useChannelStore.getState().markDMAsRead(userId);
      }
      markServerRead(lastId);
    },
  });
  const { dividerBeforeId, dividerRef, initialScrollDone, resetOpen } = divider;

  // Fetch when the conversation changes. The jump target is read once from the store (not a dep),
  // so clearing it later never triggers another fetch.
  const requestedAroundRef = useRef<number | null>(null);
  useEffect(() => {
    isAtBottom.current = true;
    resetOpen();
    const target = useChannelStore.getState().dmScrollToMessageId;
    requestedAroundRef.current = target;
    // 안 읽음 기준점은 같은 응답으로 받는다(서버가 읽음 처리보다 먼저 계산). 점프 대상이 있으면 구분선 없이 연다.
    const unreadStore = useUnreadStore.getState();
    unreadStore.begin(unreadScope);
    if (target) unreadStore.setUnknown(unreadScope);
    fetchConversation(userId, target ?? undefined, !target).then(() => {
      // around로 열면 조회가 읽음 처리를 하지 않으므로 조회가 끝난 뒤에 서버 읽음 처리를 한다
      if (target && !useDMStore.getState().loadError) markServerRead();
    });
    return () => useUnreadStore.getState().reset();
    // groupId·unreadScope는 userId(대화 키)에서 정해진다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, fetchConversation]);

  // Jump to a target message (search result, activity item). While the target is set and
  // loaded it is also the highlighted message; the store clears it after 2s.
  const hasMessages = messages.length > 0;
  const targetLoaded = dmScrollToMessageId !== null && messages.some((m) => m.id === dmScrollToMessageId);
  const highlightedId = targetLoaded ? dmScrollToMessageId : null;
  const scrolledTargetRef = useRef<number | null>(null);
  useEffect(() => {
    if (dmScrollToMessageId === null) {
      scrolledTargetRef.current = null;
      return;
    }
    if (scrolledTargetRef.current === dmScrollToMessageId) return;
    if (targetLoaded) {
      const el = messageRefs.current.get(dmScrollToMessageId);
      if (!el) return;
      scrolledTargetRef.current = dmScrollToMessageId;
      didScrollToTarget.current = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (hasMessages && !isLoading && requestedAroundRef.current !== dmScrollToMessageId) {
      // Target is older than what is loaded: fetch the page around it once
      requestedAroundRef.current = dmScrollToMessageId;
      // 열려 있는 대화에서 점프해도 조회가 끝나면 서버 읽음 처리를 한다(around 조회는 읽음 처리를 하지 않는다)
      fetchConversation(userId, dmScrollToMessageId).then(() => {
        if (!useDMStore.getState().loadError) markServerRead();
      });
    }
  }, [dmScrollToMessageId, targetLoaded, hasMessages, isLoading, userId, fetchConversation, markServerRead]);

  // Clear the target (and so the highlight) 2s after it was reached
  useEffect(() => {
    if (!highlightedId) return;
    const timer = setTimeout(() => useChannelStore.setState({ dmScrollToMessageId: null }), 2000);
    return () => clearTimeout(timer);
  }, [highlightedId]);

  // Auto-scroll to bottom on new messages (not when targeting a specific message)
  useEffect(() => {
    if (dmScrollToMessageId) return;
    if (!initialScrollDone.current) return; // 처음 위치는 훅이 잡는다(구분선이 있으면 구분선에서 시작)
    if (didScrollToTarget.current) {
      didScrollToTarget.current = false;
      return;
    }
    // 구분선에서 읽는 중이면(바닥이 아니면) 새 메시지가 와도 끌어내리지 않는다. 내가 보낸 메시지는 바닥으로 간다.
    if (!isAtBottom.current && messages[messages.length - 1]?.fromUserId !== currentUser?.id) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    // 마지막 메시지 작성자만 읽는다: 길이가 바뀔 때만 실행한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, dmScrollToMessageId]);

  // Track whether user is scrolled to the bottom
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleScroll = () => {
      isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Re-anchor scroll when thread panel opens/closes (width reflow shifts content)
  useLayoutEffect(() => {
    if (isAtBottom.current) {
      messagesEndRef.current?.scrollIntoView();
    }
  }, [activeThreadId, showPins, showFiles, showMembers]);

  const handleStartEdit = (msg: { id: number; content: string }) => {
    startEdit(msg.id, msg.content);
    setShowMoreMenuId(null);
  };

  const handleDelete = (msgId: number) => {
    setShowMoreMenuId(null);
    setDeleteConfirmId(msgId);
  };

  const confirmDelete = async () => {
    if (deleteConfirmId == null) return;
    setDeleteConfirmId(null);
    await storeDeleteMessage(deleteConfirmId, userId);
  };

  const keepToolbarOpen = (msgId: number) =>
    showMoreMenuId === msgId || editingId === msgId || showEmojiPickerId === msgId;

  const handleOpenThread = useCallback((messageId: number) => {
    setActiveThreadId(messageId);
    setShowPins(false);
    setShowFiles(false);
    setShowMembers(false);
  }, []);

  const loadPins = useCallback(
    () => (groupId !== undefined ? getDMGroupPins(groupId) : getPinnedDMs(userId)),
    [groupId, userId],
  );

  // 1:1에서 사람을 추가하면 새 그룹 DM을 만든다(1:1 대화는 그대로 남는다)
  const handleAddPeopleToDM = async (users: AuthUser[]) => {
    try {
      setAddPeopleError(null);
      const { group: created } = await createDMGroup([userId, ...users.map((u) => u.id)]);
      useChannelStore.getState().upsertGroupDM(created);
      setShowAddPeople(false);
      navigate(`/g/${created.id}`);
    } catch (err) {
      setAddPeopleError(apiErrorMessage(err, 'sidebar:groupDM.createError'));
    }
  };

  const handleCloseThread = useCallback(() => {
    setActiveThreadId(null);
  }, []);

  // Fetch pinned messages when pins panel is opened
  useEffect(() => {
    if (!showPins) return;
    loadPins().then(setPinnedMessages).catch(() => {});
  }, [showPins, loadPins]);

  const handleTogglePin = useCallback(async (msg: DMMessage) => {
    setShowMoreMenuId(null);
    try {
      if (msg.isPinned) {
        await unpinDM(msg.id);
      } else {
        await pinDM(msg.id);
      }
      // Refresh messages to reflect pin state
      fetchConversation(userId);
      // Refresh pins panel if open
      if (showPins) {
        loadPins().then(setPinnedMessages).catch(() => {});
      }
    } catch { /* ignore */ }
  }, [userId, fetchConversation, showPins, loadPins]);

  const handleReplyCountChange = useCallback((messageId: number, count: number, fromSelf?: boolean) => {
    const participant = fromSelf && currentUser
      ? { id: currentUser.id, name: currentUser.name, avatar: currentUser.avatar ?? null }
      : undefined;
    updateReplyCount(messageId, userId, count, participant);
  }, [updateReplyCount, userId, currentUser]);

  // Stabilize onSend callback to prevent MessageInput re-renders
  const handleSendDM = useCallback(
    async (content: string, fileIds?: number[]) => {
      await storeSendMessage(userId, content, fileIds);
    },
    [userId, storeSendMessage]
  );

  // Close thread panel when switching conversations
  const [threadUserId, setThreadUserId] = useState(userId);
  if (threadUserId !== userId) {
    setThreadUserId(userId);
    setActiveThreadId(null);
    setShowMembers(false);
  }

  // 퍼말링크(답글, 삭제된 부모)가 요청한 스레드를 연다. 한 번 쓰면 비운다.
  const [permalinkReplyId, setPermalinkReplyId] = useState<number | null>(null);
  const pendingThread = usePermalinkStore((s) => s.pendingThread);
  const conversationKind = isGroup ? 'group' : 'dm';
  const conversationId = isGroup ? groupId : props.userId;
  const [consumedThread, setConsumedThread] = useState<typeof pendingThread>(null);
  if (pendingThread && pendingThread !== consumedThread && pendingThread.kind === conversationKind && pendingThread.conversationId === conversationId) {
    setConsumedThread(pendingThread);
    setActiveThreadId(pendingThread.parentId);
    setPermalinkReplyId(pendingThread.replyId ?? null);
  }
  useEffect(() => {
    if (consumedThread) usePermalinkStore.getState().setPendingThread(null);
  }, [consumedThread]);

  // 링크 복사가 가리킬 대화: 그룹 DM은 그룹 id, 1:1은 상대 userId
  const permalinkBase = isGroup
    ? { kind: 'group' as const, conversationId: groupId }
    : { kind: 'dm' as const, conversationId: props.userId };

  // Memoize dmParticipantIds to prevent MessageInput re-renders
  const currentUserId = currentUser?.id;
  const groupMemberKey = group?.members.map((m) => m.id).join(',');
  const dmParticipantIds = useMemo(
    () => {
      if (isGroup) return groupMemberKey ? groupMemberKey.split(',').map(Number) : [];
      return currentUserId !== undefined ? [currentUserId, userId] : [userId];
    },
    [isGroup, groupMemberKey, currentUserId, userId]
  );
  const [firstMember, secondMember] = otherMembers(group ?? NO_GROUP, currentUserId);

  // Memoize placeholder to prevent MessageInput re-renders
  const placeholder = useMemo(() => t('dm.messagePlaceholder', { name: userName }), [t, userName]);

  return (
    <div data-testid="dm-conversation" className="flex h-full flex-col">
      {/* Header */}
      <header className="flex flex-col flex-shrink-0 border-b border-slack-border bg-white pt-[env(safe-area-inset-top)]">
        {/* Top Row */}
        <div className="flex h-[49px] items-center justify-between px-4">
          {/* Left Section */}
          <div className="flex items-center gap-1">
            <button
              onClick={openSidebar}
              className="me-1 flex h-8 w-8 items-center justify-center rounded hover:bg-slack-hover md:hidden"
            >
              <Menu className="h-5 w-5 text-slack-secondary" />
            </button>
            {isGroup ? (
              <button
                data-testid="group-header-name"
                onClick={() => setShowMembers((prev) => !prev)}
                className="flex min-w-0 items-center gap-2 cursor-pointer"
                title={t('groupDM.members', { count: group?.members.length ?? 0 })}
              >
                <span className="relative h-9 w-9 flex-shrink-0">
                  {firstMember && (
                    <Avatar src={firstMember.avatar ?? undefined} alt={firstMember.name} fallback={firstMember.name} size="sm" className="absolute start-0 top-0 h-6 w-6" />
                  )}
                  {secondMember && (
                    <Avatar src={secondMember.avatar ?? undefined} alt={secondMember.name} fallback={secondMember.name} size="sm" className="absolute bottom-0 end-0 h-6 w-6 ring-2 ring-white" />
                  )}
                </span>
                <span className="truncate text-[18px] font-bold text-slack-primary hover:underline">{userName}</span>
              </button>
            ) : (
              <>
                <button onClick={() => openProfile(userId)} disabled={isSelf} className={cn(!isSelf && 'cursor-pointer')}>
                  <Avatar
                    src={userAvatar || undefined}
                    alt={userName}
                    fallback={userName}
                    size="md"
                    status={dmEntry?.userStatus || 'offline'}
                  />
                </button>
                <button
                  onClick={() => openProfile(userId)}
                  disabled={isSelf}
                  className={cn('ms-2 text-[18px] font-bold text-slack-primary', !isSelf && 'cursor-pointer hover:underline')}
                >
                  {userName}{isSelf && <span className="font-normal text-slack-hint"> {t('dm.you')}</span>}
                </button>
              </>
            )}
            <Button
              variant="toolbar"
              size="icon-xs"
              data-testid="dm-star-button"
              onClick={() => (isGroup ? toggleGroupStar(groupId) : toggleDMStar(userId))}
              title={isStarred ? t('dm.unstar') : t('dm.star')}
              aria-label={isStarred ? t('dm.unstar') : t('dm.star')}
            >
              <Star className={cn('h-4 w-4', isStarred ? 'fill-yellow-400 text-yellow-400' : 'text-slack-secondary')} />
            </Button>
          </div>

          {/* Right Section */}
          <div className="flex items-center gap-2">
            {isGroup ? (
              <Button
                variant="toolbar"
                size="sm"
                data-testid="group-members-button"
                onClick={() => setShowMembers((prev) => !prev)}
                aria-label={t('groupDM.members', { count: group?.members.length ?? 0 })}
                title={t('groupDM.members', { count: group?.members.length ?? 0 })}
              >
                <Users className="h-4 w-4 text-slack-secondary" />
                <span className="text-[13px] text-slack-secondary">{group?.members.length ?? 0}</span>
              </Button>
            ) : !isSelf && (
              <>
                <Button
                  variant="toolbar"
                  size="icon-xs"
                  data-testid="dm-add-people"
                  onClick={() => { setAddPeopleError(null); setShowAddPeople(true); }}
                  aria-label={t('groupDM.addPeople')}
                  title={t('groupDM.addPeople')}
                >
                  <UserPlus className="h-4 w-4 text-slack-secondary" />
                </Button>
                <HuddleButton userId={userId} />
              </>
            )}
            <HeaderNotifications testIdPrefix="dm" />
            <div className="hidden sm:block h-4 w-px bg-slack-border" />
            <div className="hidden sm:block">
              <HeaderSearch testIdPrefix="dm" />
            </div>
            <button
              onClick={() => setShowMobileSearch(true)}
              className="flex h-8 w-8 items-center justify-center rounded hover:bg-slack-hover sm:hidden"
              data-testid="dm-mobile-search-button"
              aria-label={t('common:actions.search')}
            >
              <Search className="h-4 w-4 text-slack-secondary" />
            </button>
          </div>
        </div>
        {/* Tabs Row */}
        <HeaderTabs
          showPins={showPins}
          showFiles={showFiles}
          onTogglePins={() => { setShowPins((prev) => !prev); setShowFiles(false); setShowMembers(false); }}
          onToggleFiles={() => { setShowFiles((prev) => !prev); setShowPins(false); setShowMembers(false); }}
          testIdPrefix="dm"
        />

        {/* Mobile search overlay */}
        {showMobileSearch && (
          <MobileSearchOverlay onClose={() => setShowMobileSearch(false)} testIdPrefix="dm" />
        )}
      </header>

      {/* Body: messages column + optional side panel */}
      <div className="relative flex min-h-0 flex-1">
        {/* Messages column */}
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {divider.showBar && (
            <NewMessagesBar
              count={divider.barCount}
              atLeast={divider.barAtLeast}
              onJump={divider.jumpToDivider}
              onMarkRead={divider.markAllRead}
            />
          )}
          {/* Messages list */}
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto bg-white px-5 pb-4 pt-5">
            {isLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-slack-hint">
                {t('dm.loadingMessages')}
              </div>
            ) : loadError ? (
              <div className="flex h-full items-center justify-center text-sm text-slack-error">
                {loadError}
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-slack-hint">
                <p className="text-lg font-medium">
                  {isSelf
                    ? t('dm.selfSpace')
                    : isGroup
                      ? t('groupDM.conversationStart', { names: userName })
                      : t('dm.conversationStart', { name: userName })}
                </p>
                <p className="text-sm">{t('dm.sendToBegin')}</p>
              </div>
            ) : (
              <>
                {messages.map((msg, i) => {
                  const prevMsg = messages[i - 1];
                  const showDate =
                    !prevMsg ||
                    (!isToday(prevMsg.createdAt) &&
                      new Date(msg.createdAt).toDateString() !==
                        new Date(prevMsg.createdAt).toDateString());
                  const showAvatar = !prevMsg || prevMsg.fromUserId !== msg.fromUserId;
                  const isOwner = currentUser?.id === msg.fromUserId;
                  const isHovered = hoveredMessageId === msg.id;
                  const isEditing = editingId === msg.id;

                  return (
                    <div
                      key={msg.id}
                      ref={(el) => {
                        if (el) messageRefs.current.set(msg.id, el);
                        else messageRefs.current.delete(msg.id);
                      }}
                      className={highlightedId === msg.id ? 'transition-colors duration-700 bg-yellow-100' : ''}
                    >
                      {showDate && (
                        <div className="relative my-[10px] flex items-center">
                          <div className="flex-1 border-t border-slack-border-light" />
                          <span className="flex-shrink-0 rounded-full border border-slack-border-light bg-white px-3 py-[2px] text-[13px] font-semibold text-slack-primary">
                            {formatDateSeparator(msg.createdAt)}
                          </span>
                          <div className="flex-1 border-t border-slack-border-light" />
                        </div>
                      )}
                      {msg.id === dividerBeforeId && <UnreadDivider ref={dividerRef} />}
                      <div
                        data-testid={`dm-message-${msg.id}`}
                        className={cn(
                          'group relative flex px-0 hover:bg-slack-hover',
                          showAvatar ? 'pt-2 pb-0.5' : 'py-px',
                        )}
                        onMouseEnter={() => {
                          clearTimeout(hoverLeaveTimer.current);
                          setHoveredMessageId(msg.id);
                        }}
                        onMouseLeave={() => {
                          hoverLeaveTimer.current = setTimeout(() => {
                            setHoveredMessageId(null);
                            setShowMoreMenuId(null);
                          }, 150);
                        }}
                        onTouchStart={() => {
                          setHoveredMessageId((prev) => prev === msg.id ? null : msg.id);
                        }}
                      >
                        <div className="me-2 w-9 flex-shrink-0">
                          {showAvatar ? (
                            <button
                              onClick={() => openProfile(msg.fromUserId)}
                            >
                              <Avatar
                                src={msg.fromUser.avatar || undefined}
                                alt={msg.fromUser.name}
                                fallback={msg.fromUser.name}
                                size="md"
                                className="mt-[5px]"
                              />
                            </button>
                          ) : (
                            <span className="hidden text-[12px] leading-[22px] text-slack-secondary group-hover:inline">
                              {formatTimeShort(msg.createdAt)}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          {showAvatar && (
                            <div className="flex items-baseline gap-2">
                              <button
                                onClick={() => openProfile(msg.fromUserId)}
                                className="text-[15px] font-bold text-slack-primary hover:underline"
                              >
                                {msg.fromUser.name}
                              </button>
                              <span className="text-[12px] text-slack-secondary">
                                {formatTime(msg.createdAt)}
                              </span>
                              {msg.editedAt && (
                                <span className="text-[12px] text-slack-secondary">{t('dm.edited')}</span>
                              )}
                            </div>
                          )}
                          {isEditing ? (
                            <div className="mt-1">
                              <textarea
                                ref={editInputRef}
                                data-testid="dm-edit-input"
                                value={editContent}
                                onChange={(e) => { setEditContent(e.target.value); }}
                                onKeyDown={(e) => handleEditKeyDown(e, msg.content)}
                                className={cn(
                                  "w-full resize-none rounded border bg-white p-2 text-[15px] leading-[22px] text-slack-primary outline-none",
                                  editError ? "border-red-500" : "border-slack-link"
                                )}
                                rows={2}
                              />
                              {editError && (
                                <p className="mt-1 text-[12px] text-red-600">{editError}</p>
                              )}
                              <div className="mt-1 flex items-center gap-2 text-[12px]">
                                <button
                                  onClick={cancelEdit}
                                  className="text-slack-secondary hover:underline"
                                >
                                  {t('common:actions.cancel')}
                                </button>
                                <button
                                  data-testid="dm-edit-save"
                                  onClick={() => saveEdit(msg.content)}
                                  className="rounded bg-slack-btn px-3 py-1 text-white hover:bg-slack-btn-hover"
                                >
                                  {t('common:actions.save')}
                                </button>
                              </div>
                            </div>
                          ) : msg.content.startsWith('[huddle:') || msg.content === 'Started a huddle. Join to talk!' ? (
                              <HuddleSystemMessage content={msg.content} fromUserId={msg.fromUserId} />
                          ) : (
                            <div className="whitespace-pre-wrap break-words text-[15px] leading-[22px] text-slack-primary">
                              {renderMessageContent(msg.content)}
                              {!showAvatar && msg.editedAt && (
                                <span className="ms-1 text-[12px] text-slack-secondary">{t('dm.edited')}</span>
                              )}
                            </div>
                          )}
                          {msg.files && msg.files.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-2">
                              {msg.files.map((file) => (
                                <div key={file.id} className="rounded-lg border border-slack-border overflow-hidden">
                                  {file.mimetype.startsWith('audio/') || (file.mimetype === 'video/webm' && file.originalName.startsWith('voice-message')) ? (
                                    <div className="px-3 py-2.5">
                                      <AuthFileMedia kind="audio" fileId={file.id} controls playsInline controlsList="nodownload noplaybackrate" preload="metadata" className="h-8"  />
                                    </div>
                                  ) : file.mimetype.startsWith('video/') ? (
                                    <div>
                                      <AuthFileMedia kind="video" fileId={file.id} controls playsInline preload="metadata" className="max-h-[300px] max-w-[400px]"  />
                                      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-slack-border">
                                        <span className="text-[13px] text-slack-link truncate max-w-[200px]">{file.originalName}</span>
                                        <AuthFileLink fileId={file.id} forceDownload download={file.originalName.replace(/[/\\:\0]/g, '_')} rel="noopener" className="ms-auto flex-shrink-0 text-slack-disabled hover:text-slack-primary" onClick={(e) => e.stopPropagation()}>
                                          <Download className="h-4 w-4" />
                                        </AuthFileLink>
                                      </div>
                                    </div>
                                  ) : file.mimetype.startsWith('image/') ? (
                                    <div>
                                      <button
                                        onClick={() => { setLightboxFileId(file.id); setLightboxAlt(file.originalName); }}
                                        className="block cursor-zoom-in focus:outline-none"
                                      >
                                        <AuthFileImage fileId={file.id} alt={file.originalName} className="max-h-[200px] max-w-[300px] object-contain" />
                                      </button>
                                      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-slack-border">
                                        <span className="text-[13px] text-slack-link truncate max-w-[200px]">{file.originalName}</span>
                                        <AuthFileLink fileId={file.id} forceDownload download={file.originalName.replace(/[/\\:\0]/g, '_')} rel="noopener" className="ms-auto flex-shrink-0 text-slack-disabled hover:text-slack-primary" onClick={(e) => e.stopPropagation()}>
                                          <Download className="h-4 w-4" />
                                        </AuthFileLink>
                                      </div>
                                    </div>
                                  ) : (
                                    <AuthFileLink fileId={file.id} forceDownload download={file.originalName.replace(/[/\\:\0]/g, '_')} rel="noopener" className="flex items-center gap-2 px-3 py-2">
                                      <FileIcon className="h-5 w-5 text-slack-secondary flex-shrink-0" />
                                      <span className="text-[13px] text-slack-link truncate max-w-[200px]">{file.originalName}</span>
                                    </AuthFileLink>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                          {msg.reactions.length > 0 && (
                            <MessageReactions
                              reactions={msg.reactions}
                              messageId={msg.id}
                              onAddReaction={(id, emoji) => storeAddReaction(id, emoji, userId)}
                              onRemoveReaction={(id, emoji) => storeRemoveReaction(id, emoji, userId)}
                            />
                          )}
                          {msg.replyCount > 0 && (
                            <ThreadIndicator
                              testId={`dm-thread-count-${msg.id}`}
                              replyCount={msg.replyCount}
                              author={{ id: msg.fromUserId, name: msg.fromUser.name, avatar: msg.fromUser.avatar ?? null }}
                              participants={msg.threadParticipants}
                              onClick={() => handleOpenThread(msg.id)}
                            />
                          )}
                        </div>

                        {/* Hover action toolbar */}
                        {(isHovered || keepToolbarOpen(msg.id)) && !isEditing && (
                          <MessageToolbar
                            className="absolute -top-4 end-2"
                            testIdPrefix="dm"
                            onEmojiClick={() => setShowEmojiPickerId((prev) => prev === msg.id ? null : msg.id)}
                            onBookmarkClick={() => toggleBookmark(msg.id)}
                            isBookmarked={bookmarkedIds.has(msg.id)}
                            onThreadClick={() => handleOpenThread(msg.id)}
                            onMoreClick={() =>
                              setShowMoreMenuId((prev) =>
                                prev === msg.id ? null : msg.id,
                              )}
                          />
                        )}

                        {/* Emoji Picker from hover toolbar */}
                        {showEmojiPickerId === msg.id && (
                          <PortalEmojiPicker
                            anchorClassName="absolute -top-4 end-2 mt-9"
                            onEmojiSelect={(emoji) => {
                              storeAddReaction(msg.id, emoji.native, userId);
                              setShowEmojiPickerId(null);
                            }}
                            onClickOutside={() => setShowEmojiPickerId(null)}
                          />
                        )}

                        {/* More actions dropdown */}
                        {showMoreMenuId === msg.id && (
                          <MessageActionsMenu
                            anchorClassName="absolute -top-4 end-2 mt-9"
                            onClose={() => setShowMoreMenuId(null)}
                            reminderTarget={{ dmId: msg.id }}
                            testIdPrefix="dm"
                            showOwnerActions={isOwner}
                            onEdit={() => handleStartEdit(msg)}
                            onDelete={() => handleDelete(msg.id)}
                            onCopyLink={() => {
                              setShowMoreMenuId(null);
                              void copyPermalink({ ...permalinkBase, messageId: msg.id });
                            }}
                            onPin={() => handleTogglePin(msg)}
                            isPinned={msg.isPinned}
                            // 서버는 상대가 보낸 메시지만 안 읽음으로 돌릴 수 있다: 내 메시지에는 항목을 숨긴다
                            onMarkUnread={isGroup || isOwner ? undefined : () => {
                              setShowMoreMenuId(null);
                              const prevBadge = dmEntry?.unreadCount ?? 0;
                              const { ready, lastReadId: prevLast, total, pinnedBeforeId } = useUnreadStore.getState();
                              // Count unread messages from this point forward
                              const unreadCount = messages.filter((m) => m.id >= msg.id).length;
                              const setBadge = (count: number) => useChannelStore.setState((s) => ({
                                directMessages: s.directMessages.map((dm) =>
                                  dm.userId === userId ? { ...dm, unreadCount: count } : dm
                                ),
                              }));
                              setBadge(unreadCount);
                              // 그 메시지 앞에 구분선을 긋는다
                              useUnreadStore.getState().markUnreadFrom(unreadScope, msg.id, candidates);
                              markDMUnread(userId, msg.id).catch(() => {
                                // 저장에 실패하면 배지와 구분선을 원래대로 되돌린다
                                setBadge(prevBadge);
                                if (useUnreadStore.getState().channelId === unreadScope) {
                                  useUnreadStore.setState({ ready, lastReadId: prevLast, total, pinnedBeforeId });
                                }
                              });
                            }}
                          />
                        )}

                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Input */}
          <MessageInput
            placeholder={placeholder}
            onSend={handleSendDM}
            sendError={sendError}
            clearSendError={clearSendError}
            dmParticipantIds={dmParticipantIds}
            testIdPrefix="dm"
          />
        </div>

        {/* Pins Panel */}
        {showPins && (
          <div
            data-testid="dm-pins-panel"
            className="flex w-full md:w-[300px] flex-col border-s border-slack-border bg-white absolute inset-0 md:static md:inset-auto z-30 md:z-auto"
          >
            <PanelHeader icon={Pin} title={t('dm.pinnedMessages')} onClose={() => setShowPins(false)} />
            <div className="flex-1 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {pinnedMessages.length === 0 ? (
                <div className="text-center text-sm text-slack-hint py-4">{t('dm.noPins')}</div>
              ) : (
                pinnedMessages.map((msg) => (
                  <div key={msg.id} className="mb-3 rounded border border-slack-border p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Avatar
                        src={msg.fromUser?.avatar}
                        alt={msg.fromUser?.name || ''}
                        fallback={msg.fromUser?.name || '?'}
                        size="sm"
                      />
                      <span className="text-[13px] font-bold text-slack-primary">{msg.fromUser?.name}</span>
                      <span className="text-[11px] text-slack-hint">
                        {formatDateTime(msg.createdAt)}
                      </span>
                    </div>
                    <div className="text-[13px] text-slack-primary">{renderMessageContent(msg.content)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* Files Panel */}
        {showFiles && (
          <div
            data-testid="dm-files-panel"
            className="flex w-full md:w-[300px] flex-col border-s border-slack-border bg-white absolute inset-0 md:static md:inset-auto z-30 md:z-auto"
          >
            <PanelHeader icon={FileText} title={t('dm.files')} onClose={() => setShowFiles(false)} />
            <div className="flex-1 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-sm text-slack-hint">
              {t('dm.noFiles')}
            </div>
          </div>
        )}

        {/* Group members panel */}
        {isGroup && showMembers && group && (
          <GroupMembersPanel group={group} onClose={() => setShowMembers(false)} />
        )}

        {/* Thread Panel */}
        {activeThreadId && (
          <ThreadPanel
            key={activeThreadId}
            messageId={activeThreadId}
            variant="dm"
            onClose={handleCloseThread}
            onReplyCountChange={handleReplyCountChange}
            highlightReplyId={permalinkReplyId}
            permalinkBase={permalinkBase}
          />
        )}
      </div>

      {/* Image Lightbox */}
      {lightboxFileId !== null && (
        <AuthFileLightbox fileId={lightboxFileId} alt={lightboxAlt} onClose={() => setLightboxFileId(null)} />
      )}

      {/* 1:1에서 사람 추가 → 새 그룹 DM */}
      {!isGroup && (
        <AddTeammatesDialog
          open={showAddPeople}
          mode="pick"
          onClose={() => setShowAddPeople(false)}
          onConfirm={handleAddPeopleToDM}
          excludeIds={currentUserId !== undefined ? [userId, currentUserId] : [userId]}
          maxSelected={MAX_GROUP_OTHERS - 1}
          title={t('groupDM.addPeople')}
          confirmLabel={t('groupDM.createWith')}
          error={addPeopleError}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirmId !== null && (
        <DeleteConfirmDialog
          onCancel={() => setDeleteConfirmId(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}
