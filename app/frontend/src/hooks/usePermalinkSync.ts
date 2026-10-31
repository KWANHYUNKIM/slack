import { useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, locateMessage } from '@/lib/api';
import { buildPermalinkPath, type PermalinkKind, type PermalinkTarget } from '@/lib/permalink';
import { useChannelStore } from '@/stores/useChannelStore';

export const PERMALINK_NOT_FOUND_PATH = '/message-not-found';

function toId(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 퍼말링크 라우트(/c|d|g/:id/m/:messageId)를 처리한다.
 * 서버에 메시지의 소속을 물어 권한을 확인하고(없음/삭제됨/권한 없음은 같은 화면),
 * 대화를 열면서 그 메시지로 스크롤·강조한다. 대화 쪽 로직(around 조회, 2초 강조)은 기존 scrollToMessageId를 재사용한다.
 */
export function usePermalinkSync(): void {
  const { channelId, userId, groupId, messageId } = useParams<{ channelId?: string; userId?: string; groupId?: string; messageId?: string }>();
  const { search } = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!messageId) return;
    const kind: PermalinkKind = channelId ? 'channel' : userId ? 'dm' : 'group';
    const conversationId = toId(channelId ?? userId ?? groupId);
    const targetId = toId(messageId);
    if (!conversationId || !targetId) {
      navigate(PERMALINK_NOT_FOUND_PATH, { replace: true });
      return;
    }

    let cancelled = false;
    locateMessage(targetId, kind === 'channel' ? 'channel' : 'dm')
      .then((found) => {
        if (cancelled) return;
        const actual: PermalinkTarget = found.channelId !== undefined
          ? { kind: 'channel', conversationId: found.channelId, messageId: found.parentId ?? found.messageId }
          : found.groupId !== undefined
            ? { kind: 'group', conversationId: found.groupId, messageId: found.parentId ?? found.messageId }
            : { kind: 'dm', conversationId: found.dmUserId!, messageId: found.parentId ?? found.messageId };
        if (found.parentId) actual.replyId = found.messageId;

        // 답글 id만 있는 링크이거나 주소의 대화가 실제와 다르면 올바른 주소로 바로잡는다
        const sameConversation = actual.kind === kind && actual.conversationId === conversationId;
        const needsReply = actual.replyId !== undefined && new URLSearchParams(search).get('reply') !== String(actual.replyId);
        if (!sameConversation || needsReply) {
          navigate(buildPermalinkPath(actual), { replace: true });
          return;
        }

        const store = useChannelStore.getState();
        if (kind === 'channel') store.setActiveChannel(conversationId, actual.messageId);
        else if (kind === 'dm') store.setActiveDM(conversationId, actual.messageId);
        else store.setActiveGroup(conversationId, actual.messageId);
      })
      .catch((err) => {
        if (cancelled) return;
        // 403/404는 존재 여부를 숨기려 같은 화면으로 보낸다. 네트워크 오류 등은 대화만 연다.
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          navigate(PERMALINK_NOT_FOUND_PATH, { replace: true });
          return;
        }
        const store = useChannelStore.getState();
        if (kind === 'channel') store.setActiveChannel(conversationId);
        else if (kind === 'dm') store.setActiveDM(conversationId);
        else store.setActiveGroup(conversationId);
      });

    return () => {
      cancelled = true;
    };
  }, [channelId, userId, groupId, messageId, search, navigate]);
}
