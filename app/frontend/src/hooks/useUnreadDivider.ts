import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { t } from '@/lib/i18n';
import { useUnreadStore } from '@/stores/useUnreadStore';
import { useToastStore } from '@/stores/useToastStore';
import { computeUnread, hasUnreadOutOfRange, type UnreadCandidate } from '@/lib/unread';

interface Options {
  /** useUnreadStore 범위 번호(채널은 channelId, DM은 dmUnreadScope) */
  scope: number;
  /** 로드된 메시지(오래된 순) */
  candidates: readonly UnreadCandidate[];
  myUserId: number | null | undefined;
  /** 메시지 로드가 끝났고 하나 이상 있다 */
  loaded: boolean;
  /** 검색·활동에서 온 점프 대상이 있다(첫 위치는 점프 쪽이 잡는다) */
  hasJumpTarget: boolean;
  containerRef: RefObject<HTMLElement | null>;
  endRef: RefObject<HTMLElement | null>;
  isAtBottom: MutableRefObject<boolean>;
  /** id 주변 메시지를 불러온다. 불러온 목록의 가장 오래된 id를, 실패하면 null을 돌려준다 */
  fetchAround: (id: number) => Promise<number | null>;
  /** 마지막 메시지까지 읽은 것으로 저장한다(배지와 서버) */
  markRead: (lastMessageId: number) => void;
}

/**
 * 채널과 DM이 함께 쓰는 안 읽음 구분선 상태: 기준점 고정, 구분선 위치, 범위 밖 판정, 첫 위치 스크롤,
 * 상단 바(위로 이동, 읽음으로 표시). 기준점을 받는 일(begin, 조회, reset)은 호출하는 쪽이 한다.
 */
export function useUnreadDivider({
  scope, candidates, myUserId, loaded, hasJumpTarget, containerRef, endRef, isAtBottom, fetchAround, markRead,
}: Options) {
  const unread = useUnreadStore(useShallow((s) => ({
    channelId: s.channelId, ready: s.ready, lastReadId: s.lastReadId, total: s.total, pinnedBeforeId: s.pinnedBeforeId,
  })));
  const ready = unread.ready && unread.channelId === scope;
  const lastReadId = ready ? unread.lastReadId : null;
  const unreadInfo = useMemo(
    () => (ready ? computeUnread(candidates, lastReadId, myUserId) : { dividerBeforeId: null, unreadLoaded: 0 }),
    [ready, candidates, lastReadId, myUserId],
  );
  // 열 때 안 읽음이 없었다면(false) 보는 중에 온 새 메시지로 구분선을 새로 만들지 않는다. 열 때 있었으면 계속 유지한다.
  const [dividerAllowed, setDividerAllowed] = useState<boolean | null>(null);
  // 안 읽음이 로드 범위 밖인가: 열 때 한 번만 판정해 고정한다. 범위 밖인 동안은 구분선 대신 상단 바만 보인다.
  const [outOfRange, setOutOfRange] = useState(false);
  const pinnedLoaded = ready && unread.pinnedBeforeId !== null && candidates.some((m) => m.id === unread.pinnedBeforeId);
  const dividerBeforeId = pinnedLoaded
    ? unread.pinnedBeforeId
    : dividerAllowed === false || outOfRange ? null : unreadInfo.dividerBeforeId;
  const dividerRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);
  const [dividerAbove, setDividerAbove] = useState(false);
  const lastMessageId = candidates.length > 0 ? candidates[candidates.length - 1].id : null;

  /** 대화를 새로 열 때 부른다 */
  const resetOpen = useCallback(() => {
    initialScrollDone.current = false;
    setDividerAllowed(null);
    setOutOfRange(false);
  }, []);

  // 처음 열 때의 위치: 구분선이 있으면 첫 안 읽음이 맨 위에 오게(최신이 한 화면이면 바닥에 닿는다), 없으면 바닥
  useEffect(() => {
    if (initialScrollDone.current || !ready || !loaded) return;
    initialScrollDone.current = true;
    const openOutOfRange = hasUnreadOutOfRange(candidates, lastReadId, unread.total);
    setOutOfRange(openOutOfRange);
    setDividerAllowed(unreadInfo.dividerBeforeId !== null || openOutOfRange);
    if (hasJumpTarget) return;
    if (dividerRef.current && !openOutOfRange) {
      dividerRef.current.scrollIntoView({ block: 'start' });
      const c = containerRef.current;
      isAtBottom.current = c ? c.scrollHeight - c.scrollTop - c.clientHeight < 100 : false;
    } else {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
      isAtBottom.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loaded, hasJumpTarget, unreadInfo.dividerBeforeId]);

  // 구분선이 화면 위로 벗어났는지(바를 보일지)는 IntersectionObserver로 본다
  useEffect(() => {
    const divider = dividerRef.current;
    const container = containerRef.current;
    if (!divider || !container || typeof IntersectionObserver === 'undefined') {
      setDividerAbove(false);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      const rootTop = entry.rootBounds?.top ?? 0;
      setDividerAbove(!entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop);
    }, { root: container });
    observer.observe(divider);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dividerBeforeId]);

  // 범위 밖 안 읽음에서 바를 눌러 주변을 불러온 뒤에는 구분선으로 한 번 스크롤한다
  const [pendingDividerScroll, setPendingDividerScroll] = useState(false);
  useEffect(() => {
    if (!pendingDividerScroll || !dividerRef.current) return;
    dividerRef.current.scrollIntoView({ block: 'start' });
    setPendingDividerScroll(false);
  }, [pendingDividerScroll, dividerBeforeId]);

  const jumping = useRef(false);
  const jumpToDivider = async () => {
    if (!outOfRange) {
      dividerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // 안 읽음이 로드 범위 밖: 기준점 주변을 불러온 뒤 구분선으로 간다.
    // 전부 안 읽음(기준점 없음)이면 가장 오래된 메시지부터 불러온다(id 1 주변 = 맨 앞 구간).
    if (jumping.current) return;
    jumping.current = true;
    let ok = false;
    try {
      const oldest = await fetchAround(lastReadId ?? 1);
      // 실패했거나 같은 창을 돌려줘서 기준점이 여전히 창 밖이면 이동하지 않는다
      ok = oldest !== null && (lastReadId === null || oldest <= lastReadId);
    } finally {
      jumping.current = false;
      if (ok) {
        setOutOfRange(false);
        setPendingDividerScroll(true);
      } else {
        useToastStore.getState().show(t('messages:unread.jumpFailed'), 'error');
      }
    }
  };

  const markAllRead = () => {
    if (lastMessageId === null) return;
    useUnreadStore.getState().markReadUpTo(scope, lastMessageId);
    setDividerAllowed(false); // 읽은 뒤 새로 온 메시지로 구분선이 다시 생기지 않게 한다
    setOutOfRange(false);
    markRead(lastMessageId);
  };

  return {
    ready,
    dividerBeforeId,
    dividerRef,
    initialScrollDone,
    resetOpen,
    jumpToDivider,
    markAllRead,
    showBar: outOfRange || (dividerBeforeId !== null && dividerAbove),
    barCount: outOfRange ? unread.total : unreadInfo.unreadLoaded,
    barAtLeast: outOfRange,
  };
}
