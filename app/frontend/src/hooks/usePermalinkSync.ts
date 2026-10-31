import { useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, locateMessage } from '@/lib/api';
import { buildConversationPath, buildPermalinkPath, parsePermalink, type PermalinkTarget } from '@/lib/permalink';
import { useChannelStore } from '@/stores/useChannelStore';
import { usePermalinkStore } from '@/stores/usePermalinkStore';

export const PERMALINK_NOT_FOUND_PATH = '/message-not-found';

/**
 * 퍼말링크 라우트(/c|d|g/:id/m/:messageId)를 처리한다.
 * 서버에 메시지의 소속을 물어 권한을 확인하고(없음/삭제됨/권한 없음은 같은 화면),
 * 대화를 열면서 그 메시지로 스크롤·강조한다. 대화 쪽 로직(around 조회, 2초 강조)은 기존 scrollToMessageId를 재사용한다.
 * 같은 링크를 다시 눌러도 location.key가 바뀌어 이동과 강조가 다시 일어난다.
 */
export function usePermalinkSync(): void {
  const { messageId } = useParams<{ messageId?: string }>();
  const { pathname, search, key } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!messageId) return;
    const link = parsePermalink(pathname + search);
    if (!link) {
      navigate(PERMALINK_NOT_FOUND_PATH, { replace: true });
      return;
    }

    let cancelled = false;
    const openConversation = (kind: PermalinkTarget['kind'], id: number, scrollTo?: number) => {
      const store = useChannelStore.getState();
      if (kind === 'channel') store.setActiveChannel(id, scrollTo);
      else if (kind === 'dm') store.setActiveDM(id, scrollTo);
      else store.setActiveGroup(id, scrollTo);
    };

    locateMessage(link.replyId ?? link.messageId, link.kind === 'channel' ? 'channel' : 'dm')
      .then((found) => {
        if (cancelled) return;
        const top = found.parentId ?? found.messageId;
        const actual: PermalinkTarget = found.channelId !== undefined
          ? { kind: 'channel', conversationId: found.channelId, messageId: top }
          : found.groupId !== undefined
            ? { kind: 'group', conversationId: found.groupId, messageId: top }
            : { kind: 'dm', conversationId: found.dmUserId!, messageId: top };
        if (found.parentId) actual.replyId = found.messageId;

        // 답글 id만 있는 링크이거나 주소의 대화가 실제와 다르면 올바른 주소로 바로잡는다(바로잡은 주소로 다시 처리된다)
        const sameConversation = actual.kind === link.kind && actual.conversationId === link.conversationId;
        if (!sameConversation || actual.messageId !== link.messageId || actual.replyId !== link.replyId) {
          navigate(buildPermalinkPath(actual), { replace: true });
          return;
        }

        // 답글 링크, 삭제된 부모(자리표시자) 링크는 스레드 패널을 연다. 그 뒤 주소는 대화 주소로 정리한다.
        if (link.replyId !== undefined || found.deleted) {
          usePermalinkStore.getState().setPendingThread({
            kind: actual.kind,
            conversationId: actual.conversationId,
            parentId: top,
            replyId: link.replyId,
          });
          // 스레드를 연 뒤에는 주소를 대화 주소로 정리해, 새로고침하거나 패널을 닫은 뒤 다시 열리지 않게 한다
          navigate(buildConversationPath(actual), { replace: true, state: found.deleted ? { scrollToMessageId: top } : undefined });
          return;
        }
        openConversation(actual.kind, actual.conversationId, top);
      })
      .catch((err) => {
        if (cancelled) return;
        // 403/404는 존재 여부를 숨기려 같은 화면으로 보낸다. 네트워크 오류 등은 대화만 연다.
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          navigate(PERMALINK_NOT_FOUND_PATH, { replace: true });
          return;
        }
        openConversation(link.kind, link.conversationId);
      });

    return () => {
      cancelled = true;
    };
  }, [messageId, pathname, search, key, navigate]);
}
