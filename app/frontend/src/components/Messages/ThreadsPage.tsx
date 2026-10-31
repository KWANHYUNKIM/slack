import { useState, useEffect, useRef } from 'react';
import { MessagesSquare, Hash, Menu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { formatDateTime } from '@/lib/i18n/format';
import { replyToMessage, type ApiMessage, type ApiThreadItem } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { renderMessageContent } from '@/lib/renderMessageContent';
import { useMobileStore } from '@/stores/useMobileStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { shouldClearAlsoSend } from '@/lib/alsoSend';

function ThreadLine({ msg }: { msg: ApiMessage }) {
  const { t } = useTranslation('messages');
  const deleted = !!msg.deletedAt;
  return (
    <div className="flex items-start gap-3 py-1.5">
      <Avatar src={msg.user.avatar} alt={msg.user.name} fallback={msg.user.name} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold text-slack-primary">{msg.user.name}</span>
          <span className="text-[12px] text-slack-secondary">{formatDateTime(msg.createdAt)}</span>
        </div>
        <div className="whitespace-pre-wrap break-words text-[15px] leading-[22px] text-slack-primary line-clamp-6">
          {deleted ? (
            // 삭제된 부모는 자리표시자만 보여 준다
            <span data-testid="deleted-placeholder" className="italic text-slack-secondary">{t('message.deletedPlaceholder')}</span>
          ) : renderMessageContent(msg.content)}
        </div>
      </div>
    </div>
  );
}

function ThreadCard({ item }: { item: ApiThreadItem }) {
  const { t } = useTranslation('messages');
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [alsoSend, setAlsoSend] = useState(false);
  // 사용자가 체크를 바꾼 횟수. 전송 응답이 올 때 그사이 바뀌었는지 확인하는 데 쓴다
  const alsoSendVersion = useRef(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(false);
  const unread = item.unreadCount > 0;
  const hiddenCount = item.replyCount - item.replies.length;

  const openThread = () =>
    navigate(`/c/${item.channel.id}`, { state: { openThreadId: item.parent.id } });

  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
    const sentAlsoSend = alsoSend;
    const sentAlsoSendVersion = alsoSendVersion.current;
    setSending(true);
    setError(false);
    try {
      await replyToMessage(item.parent.id, content, undefined, sentAlsoSend);
      setText('');
      if (shouldClearAlsoSend(sentAlsoSendVersion, alsoSendVersion.current)) setAlsoSend(false);
      // thread:updated가 목록을 갱신한다. 이벤트가 늦어도 보이게 앞쪽만 직접 한 번 더 합친다.
      void useThreadStore.getState().refreshHead();
    } catch {
      setError(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <section
      data-testid="thread-card"
      data-unread={unread || undefined}
      className={cn('rounded-lg border border-slack-border p-3', unread && 'bg-slack-hover/40')}
    >
      <div className="mb-1 flex items-center gap-2 text-[13px] text-slack-secondary">
        <button
          type="button"
          data-testid="thread-card-channel"
          onClick={() => navigate(`/c/${item.channel.id}`)}
          className="inline-flex items-center gap-1 hover:underline"
        >
          <Hash className="h-3 w-3" />
          <span className={cn(unread && 'font-bold text-slack-primary')}>{item.channel.name}</span>
        </button>
        {unread && (
          <span data-testid="thread-card-unread" className="rounded-full bg-red-500 px-1.5 text-[11px] text-white">
            {t('threads.newReplies', { count: item.unreadCount })}
          </span>
        )}
        <button type="button" onClick={openThread} className="ms-auto text-slack-link hover:underline">
          {t('threads.openThread')}
        </button>
      </div>

      <ThreadLine msg={item.parent} />
      <div className="my-1 ms-12 text-[12px] text-slack-secondary">
        {t('threads.replyCount', { count: item.replyCount })}
        {hiddenCount > 0 && <span className="ms-2">{t('threads.olderReplies')}</span>}
      </div>
      <div className="ms-6 border-s border-slack-border ps-3">
        {item.replies.map((r) => <ThreadLine key={r.id} msg={r} />)}
      </div>

      <div className="mt-2 ms-12">
        <input
          data-testid="thread-card-input"
          value={text}
          onChange={(e) => { setText(e.target.value); setError(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
          placeholder={t('threads.replyPlaceholder')}
          aria-label={t('threads.replyPlaceholder')}
          className="w-full rounded border border-slack-border-light px-3 py-1.5 text-[15px] outline-none focus:border-slack-link"
        />
        {error && <p className="mt-1 text-xs text-slack-error">{t('threads.replyFailed')}</p>}
        <div className="mt-1 flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-[13px] text-slack-secondary">
            <input
              type="checkbox"
              data-testid="thread-card-also-send"
              checked={alsoSend}
              onChange={(e) => {
                alsoSendVersion.current += 1;
                setAlsoSend(e.target.checked);
              }}
            />
            {t('threads.alsoSendToChannel')}
          </label>
          <button
            type="button"
            data-testid="thread-card-send"
            onClick={() => void send()}
            disabled={!text.trim() || sending}
            className="rounded bg-slack-btn px-3 py-1 text-sm text-white hover:bg-slack-btn-hover disabled:opacity-50"
          >
            {t('threads.send')}
          </button>
        </div>
      </div>
    </section>
  );
}

export function ThreadsPage() {
  const { t } = useTranslation(['messages', 'common']);
  const { items, nextCursor, isLoading, isLoadingMore, loadError, fetchFirstPage, fetchMore } = useThreadStore();

  useEffect(() => {
    useThreadStore.getState().setActive(true);
    void fetchFirstPage();
    return () => useThreadStore.getState().setActive(false);
  }, [fetchFirstPage]);

  return (
    <div data-testid="threads-page" className="flex h-full flex-col">
      <div className="flex flex-shrink-0 flex-col border-b border-slack-border pt-[env(safe-area-inset-top)]">
        <div className="flex h-[49px] items-center px-5">
          <button
            onClick={useMobileStore.getState().openSidebar}
            aria-label={t('messages:threads.menu')}
            className="me-2 flex h-8 w-8 items-center justify-center rounded hover:bg-slack-hover md:hidden"
          >
            <Menu className="h-5 w-5 text-slack-secondary" />
          </button>
          <MessagesSquare className="me-2 h-5 w-5 text-slack-secondary" />
          <span className="text-[18px] font-bold text-slack-primary">{t('messages:threads.title')}</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading && items.length === 0 ? (
          <div className="text-center text-sm text-slack-hint">{t('common:status.loading')}</div>
        ) : loadError && items.length === 0 ? (
          <div className="text-center text-sm text-slack-error">{t('messages:threads.loadFailed')}</div>
        ) : items.length === 0 ? (
          <div data-testid="threads-empty" className="py-8 text-center text-slack-hint">
            <div className="text-[15px] font-bold text-slack-secondary">{t('messages:threads.empty')}</div>
            <div className="mt-1 text-sm">{t('messages:threads.emptyHint')}</div>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item) => <ThreadCard key={item.parent.id} item={item} />)}
            {nextCursor !== null && (
              <button
                type="button"
                onClick={() => void fetchMore()}
                disabled={isLoadingMore}
                className="mx-auto block text-sm text-slack-link hover:underline"
              >
                {t('messages:threads.loadMore')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
