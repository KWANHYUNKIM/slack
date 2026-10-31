import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { isToday, isYesterday, isSameDay } from 'date-fns';
import { t } from '@/lib/i18n';
import { formatDate, DATE_WEEKDAY } from '@/lib/i18n/format';
import { useMessageStore } from '@/stores/useMessageStore';
import { useChannelStore } from '@/stores/useChannelStore';
import { useUnreadStore } from '@/stores/useUnreadStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { useToastStore } from '@/stores/useToastStore';
import { getChannel, markChannelRead, markChannelReadBaseline } from '@/lib/api';
import { computeUnread, hasUnreadOutOfRange } from '@/lib/unread';
import { Message } from './Message';
import { ChannelIntro } from './ChannelIntro';
import { UnreadDivider } from './UnreadDivider';
import { NewMessagesBar } from './NewMessagesBar';
import type { Message as MessageType } from '@/lib/types';

interface MessageListProps {
  channelId: number;
  onOpenThread?: (messageId: number) => void;
  readOnly?: boolean;
}

function formatDateSeparator(date: Date): string {
  if (isToday(date)) {
    return t('common:dates.today');
  }
  if (isYesterday(date)) {
    return t('common:dates.yesterday');
  }
  return formatDate(date, DATE_WEEKDAY);
}

function shouldShowDateSeparator(
  currentMessage: MessageType,
  previousMessage: MessageType | undefined
): boolean {
  if (!previousMessage) return true;
  return !isSameDay(currentMessage.createdAt, previousMessage.createdAt);
}

function shouldShowAvatar(
  currentMessage: MessageType,
  previousMessage: MessageType | undefined
): boolean {
  if (!previousMessage) return true;
  if (!isSameDay(currentMessage.createdAt, previousMessage.createdAt)) return true;
  if (currentMessage.userId !== previousMessage.userId) return true;
  // Show avatar if more than 5 minutes apart
  const timeDiff =
    currentMessage.createdAt.getTime() - previousMessage.createdAt.getTime();
  return timeDiff > 5 * 60 * 1000;
}

export function MessageList({ channelId, onOpenThread, readOnly }: MessageListProps) {
  const { t } = useTranslation('messages');
  const { getMessagesForChannel, fetchMessages, isLoading, loadError } = useMessageStore();
  const { markChannelAsRead } = useChannelStore();
  const scrollToMessageId = useChannelStore((s) => s.scrollToMessageId);
  const messages = getMessagesForChannel(channelId);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const didScrollToTarget = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true); // Start true since we auto-scroll on load
  const myUserId = useAuthStore((s) => s.user?.id);

  // 안 읽음 구분선 기준점: 열 때 한 번 받아 고정한다. 아직 받기 전(또는 다른 채널 값)이면 ready가 false다.
  const unread = useUnreadStore(useShallow((s) => ({
    channelId: s.channelId, ready: s.ready, lastReadId: s.lastReadId, total: s.total, pinnedBeforeId: s.pinnedBeforeId,
  })));
  const unreadReady = unread.ready && unread.channelId === channelId;
  const lastReadId = unreadReady ? unread.lastReadId : null;
  const unreadInfo = unreadReady ? computeUnread(messages, lastReadId, myUserId) : { dividerBeforeId: null, unreadLoaded: 0 };
  // 열 때 안 읽음이 없었다면(false) 보는 중에 온 새 메시지로 구분선을 새로 만들지 않는다. 열 때 있었으면 계속 유지한다.
  const [dividerAllowed, setDividerAllowed] = useState<boolean | null>(null);
  const pinnedLoaded = unreadReady && unread.pinnedBeforeId !== null && messages.some((m) => m.id === unread.pinnedBeforeId);
  // 안 읽음이 로드 범위 밖인가: 열 때(첫 로드 직후) 한 번만 판정해 고정한다. 실시간 메시지가 와도 바뀌지 않는다.
  // 범위 밖인 동안은 구분선을 숨기고 상단 바만 보인다.
  const [outOfRange, setOutOfRange] = useState(false);
  const dividerBeforeId = pinnedLoaded
    ? unread.pinnedBeforeId
    : dividerAllowed === false || outOfRange ? null : unreadInfo.dividerBeforeId;
  const dividerRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);
  const [dividerAbove, setDividerAbove] = useState(false);

  // Check if user is at/near bottom of message list
  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    isAtBottom.current = distanceFromBottom < 100; // Within 100px of bottom
  };

  // 구분선이 화면 위로 벗어났는지(바를 보일지)는 IntersectionObserver로 본다
  useEffect(() => {
    const divider = dividerRef.current;
    const container = containerRef.current;
    if (!divider || !container) {
      setDividerAbove(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      const rootTop = entry.rootBounds?.top ?? 0;
      setDividerAbove(!entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop);
    }, { root: container });
    observer.observe(divider);
    return () => observer.disconnect();
  }, [dividerBeforeId]);

  // Fetch when the channel changes. The jump target is read once from the store (not a dep),
  // so clearing it later never triggers another fetch.
  const requestedAroundRef = useRef<number | null>(null);
  useEffect(() => {
    isAtBottom.current = true; // Reset to true when switching channels
    initialScrollDone.current = false;
    setDividerAllowed(null);
    setOutOfRange(false);
    const target = useChannelStore.getState().scrollToMessageId;
    requestedAroundRef.current = target;
    fetchMessages(channelId, target ?? undefined);

    // 읽음 기준점은 /read보다 먼저 받아 둔다(read 효과가 unreadReady를 기다린다). 이탈하면 버린다.
    const unreadStore = useUnreadStore.getState();
    unreadStore.begin(channelId);
    if (readOnly) {
      unreadStore.setUnknown(channelId);
    } else {
      // 기준점 조회가 끝난 뒤에야 읽음 기준선(baseline)과 /read를 부른다. 순서를 바꾸면 처음 여는 채널에서
      // baseline이 먼저 커서를 최신으로 옮겨 기준점이 덮인다.
      getChannel(channelId, { withUnread: true })
        .then((detail) => {
          useUnreadStore.getState().setBaseline(channelId, detail.lastReadMessageId ?? null, detail.unreadCount ?? 0);
          markChannelReadBaseline(channelId).catch(() => {});
        })
        .catch(() => useUnreadStore.getState().setUnknown(channelId));
    }
    return () => useUnreadStore.getState().reset();
    // readOnly는 의도적으로 뺐다: 채널에 가입해도 구분선 기준점을 다시 받지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, fetchMessages]);

  // After messages load, persist the read state to the backend so the
  // unread badge does not reappear on page reload.
  // Only mark as read if user is at/near the bottom of the message list.
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (readOnly || lastMessageId === null || !unreadReady) return;
    // Update in-memory unread count immediately (clears badge)
    markChannelAsRead(channelId);
    // Only persist to backend if user is at/near bottom
    if (isAtBottom.current) {
      markChannelRead(channelId, lastMessageId).catch(() => {
        // Silently ignore errors (e.g. if the user isn't a member)
      });
    }
  }, [channelId, lastMessageId, markChannelAsRead, readOnly, unreadReady]);

  // Jump to a target message (search result, activity item). While the target is set and
  // loaded it is also the highlighted message; the store clears it after 2s.
  const hasMessages = messages.length > 0;
  const targetLoaded = scrollToMessageId !== null && messages.some((m) => m.id === scrollToMessageId);
  const highlightedId = targetLoaded ? scrollToMessageId : null;
  const scrolledTargetRef = useRef<number | null>(null);
  useEffect(() => {
    if (scrollToMessageId === null) {
      scrolledTargetRef.current = null;
      return;
    }
    if (scrolledTargetRef.current === scrollToMessageId) return;
    if (targetLoaded) {
      const el = messageRefs.current.get(scrollToMessageId);
      if (!el) return;
      scrolledTargetRef.current = scrollToMessageId;
      didScrollToTarget.current = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (hasMessages && !isLoading && requestedAroundRef.current !== scrollToMessageId) {
      // Target is older than what is loaded: fetch the page around it once
      requestedAroundRef.current = scrollToMessageId;
      fetchMessages(channelId, scrollToMessageId);
    }
  }, [scrollToMessageId, targetLoaded, hasMessages, isLoading, channelId, fetchMessages]);

  // Clear the target (and so the highlight) 2s after it was reached
  useEffect(() => {
    if (!highlightedId) return;
    const timer = setTimeout(() => useChannelStore.setState({ scrollToMessageId: null }), 2000);
    return () => clearTimeout(timer);
  }, [highlightedId]);

  // Auto-scroll to bottom on new messages (only when not targeting a specific message)
  useEffect(() => {
    if (scrollToMessageId) return;
    if (!initialScrollDone.current) return; // 첫 위치 잡기는 아래 효과가 한다
    if (didScrollToTarget.current) {
      didScrollToTarget.current = false;
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    isAtBottom.current = true; // Mark as at bottom after auto-scroll
  }, [messages.length, scrollToMessageId]);

  // 처음 열 때의 위치: 구분선이 있으면 첫 안 읽음이 맨 위에 오게(최신이 한 화면이면 바닥에 닿는다), 없으면 바닥
  useEffect(() => {
    if (initialScrollDone.current || !unreadReady || isLoading || messages.length === 0) return;
    initialScrollDone.current = true;
    const openOutOfRange = hasUnreadOutOfRange(messages, lastReadId, unread.total);
    setOutOfRange(openOutOfRange);
    setDividerAllowed(dividerBeforeId !== null || openOutOfRange);
    if (scrollToMessageId) return; // 점프 대상이 있으면 그쪽 효과가 위치를 잡는다
    if (dividerRef.current && !openOutOfRange) {
      dividerRef.current.scrollIntoView({ block: 'start' });
      isAtBottom.current = false;
      handleScroll();
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      isAtBottom.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadReady, isLoading, messages.length, scrollToMessageId, dividerBeforeId]);

  // 범위 밖 안 읽음에서 바를 눌러 기준점 주변을 불러온 뒤에는 구분선으로 한 번 스크롤한다
  const [pendingDividerScroll, setPendingDividerScroll] = useState(false);
  useEffect(() => {
    if (!pendingDividerScroll || !dividerRef.current) return;
    dividerRef.current.scrollIntoView({ block: 'start' });
    setPendingDividerScroll(false);
  }, [pendingDividerScroll, dividerBeforeId]);

  const jumping = useRef(false);
  const jumpToDivider = async () => {
    if (!outOfRange || lastReadId === null) {
      dividerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // 안 읽음이 로드 범위 밖: 기준점 주변을 불러온 뒤 구분선으로 간다
    if (jumping.current) return;
    jumping.current = true;
    let ok = false;
    try {
      await fetchMessages(channelId, lastReadId);
      const state = useMessageStore.getState();
      const first = state.messages.find((m) => m.channelId === channelId);
      // 실패했거나 같은 창을 돌려줘서 기준점이 여전히 창 밖이면 이동하지 않는다
      ok = !state.loadError && !!first && first.id <= lastReadId;
    } finally {
      jumping.current = false;
      if (ok) {
        setOutOfRange(false);
        setPendingDividerScroll(true);
      } else {
        useToastStore.getState().show(t('unread.jumpFailed'), 'error');
      }
    }
  };

  const markAllRead = () => {
    if (lastMessageId === null) return;
    useUnreadStore.getState().markReadUpTo(channelId, lastMessageId);
    setDividerAllowed(false); // 읽은 뒤 새로 온 메시지로 구분선이 다시 생기지 않게 한다
    setOutOfRange(false);
    markChannelAsRead(channelId);
    markChannelRead(channelId, lastMessageId).catch(() => {});
  };

  if (isLoading && messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-slack-hint">
        <p className="text-sm">{t('list.loading')}</p>
      </div>
    );
  }

  if (loadError && messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-slack-error">{loadError}</p>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col justify-end">
        <ChannelIntro channelId={channelId} readOnly={readOnly} />
        <div className="flex flex-col items-center pb-8 text-slack-hint">
        <p className="text-lg font-medium">{t('list.empty')}</p>
        <p className="text-sm">{readOnly ? t('list.emptyReadOnly') : t('list.emptyFirst')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
    {(outOfRange || (dividerBeforeId !== null && dividerAbove)) && (
      <NewMessagesBar
        count={outOfRange ? unread.total : unreadInfo.unreadLoaded}
        atLeast={outOfRange}
        onJump={jumpToDivider}
        onMarkRead={markAllRead}
      />
    )}
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto pt-5 pb-4 bg-white">
      {messages.map((message, index) => {
        const previousMessage = messages[index - 1];
        const showDateSeparator = shouldShowDateSeparator(message, previousMessage);
        const showAvatar = shouldShowAvatar(message, previousMessage);

        return (
          <div
            key={message.id}
            ref={(el) => {
              if (el) messageRefs.current.set(message.id, el);
              else messageRefs.current.delete(message.id);
            }}
            className={highlightedId === message.id ? 'transition-colors duration-700 bg-yellow-100' : ''}
          >
            {showDateSeparator && (
              <div className="relative my-[10px] flex items-center">
                <div className="flex-1 border-t border-slack-border-light" />
                <button className="flex-shrink-0 rounded-full border border-slack-border-light bg-white px-3 py-[2px] text-[13px] font-semibold text-slack-primary hover:bg-slack-hover transition-colors">
                  {formatDateSeparator(message.createdAt)}
                </button>
                <div className="flex-1 border-t border-slack-border-light" />
              </div>
            )}
            {message.id === dividerBeforeId && <UnreadDivider ref={dividerRef} />}
            <Message
              message={message}
              showAvatar={showAvatar}
              onOpenThread={onOpenThread}
              readOnly={readOnly}
            />
          </div>
        );
      })}
      <div ref={messagesEndRef} />
    </div>
    </div>
  );
}
