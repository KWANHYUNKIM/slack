import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Menu } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/i18n/format';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { renderMessageContent } from '@/lib/renderMessageContent';
import { useMobileStore } from '@/stores/useMobileStore';
import { useActivityStore } from '@/stores/useActivityStore';
import type { ActivityFilter, ApiActivity } from '@/lib/api';

const TAB_ORDER: ActivityFilter[] = ['all', 'mentions', 'threads', 'reactions'];
const LOAD_MORE_THRESHOLD_PX = 200;

function describeActivity(item: ApiActivity, t: TFunction<'activity'>): string {
  const actor = item.actor.name || t('page.someone');
  const where = item.channel ? `#${item.channel.name}` : t('page.directMessage');
  switch (item.type) {
    case 'MENTION': return t('describe.mention', { actor, where });
    case 'CHANNEL_MENTION': return t('describe.channelMention', { actor, where });
    case 'HERE_MENTION': return t('describe.hereMention', { actor, where });
    case 'THREAD_REPLY': return t('describe.threadReply', { actor, where });
    case 'REACTION': return t('describe.reaction', { actor, emoji: item.emoji ?? '', where });
    case 'REMINDER': return t('describe.reminder');
  }
}

export function ActivityPage() {
  const { t } = useTranslation('activity');
  const navigate = useNavigate();
  const filter = useActivityStore((s) => s.filter);
  const items = useActivityStore((s) => s.items);
  const isLoading = useActivityStore((s) => s.isLoading);
  const isLoadingMore = useActivityStore((s) => s.isLoadingMore);
  const loadError = useActivityStore((s) => s.loadError);
  const unreadTotal = useActivityStore((s) => s.unreadTotal);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { fetchFirstPage, fetchUnreadCount } = useActivityStore.getState();
    void fetchFirstPage();
    void fetchUnreadCount();
  }, []);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_THRESHOLD_PX) {
      void useActivityStore.getState().fetchMore();
    }
  };

  const handleOpen = (item: ApiActivity) => {
    void useActivityStore.getState().markRead([item.id]);
    // Jump to the thread parent when the activity is a reply, otherwise to the message itself
    const targetId = item.threadId ?? item.messageId ?? item.dmId;
    const state = targetId ? { scrollToMessageId: targetId } : undefined;
    if (item.dmGroupId) {
      navigate(`/g/${item.dmGroupId}`, { state });
    } else if (item.type === 'REMINDER' && item.dmId !== null) {
      // 1:1 DM 리마인더는 활동에 상대 정보가 없다(배우가 본인). 목록에서 열 수 있게 한다
      navigate('/later');
    } else if (item.dmId !== null) {
      navigate(`/d/${item.actor.id}`, { state });
    } else if (item.channelId !== null) {
      navigate(`/c/${item.channelId}`, { state });
    }
  };

  return (
    <div data-testid="activity-page" className="flex h-full flex-col">
      <div className="flex flex-col flex-shrink-0 border-b border-slack-border pt-[env(safe-area-inset-top)]">
        <div className="flex h-[49px] items-center px-5">
          <button
            aria-label={t('page.menu')}
            onClick={useMobileStore.getState().openSidebar}
            className="me-2 flex h-8 w-8 items-center justify-center rounded hover:bg-slack-hover md:hidden"
          >
            <Menu className="h-5 w-5 text-slack-secondary" />
          </button>
          <Bell className="h-5 w-5 text-slack-secondary me-2" />
          <span className="text-[18px] font-bold text-slack-primary">{t('page.title')}</span>
          <button
            data-testid="activity-mark-all-read"
            onClick={() => void useActivityStore.getState().markAllRead()}
            disabled={unreadTotal === 0}
            className="ms-auto rounded px-3 py-1 text-[13px] font-medium text-slack-link hover:bg-slack-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('page.markAllRead')}
          </button>
        </div>
        <div role="tablist" className="flex gap-1 px-4">
          {TAB_ORDER.map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={filter === tab}
              data-testid={`activity-tab-${tab}`}
              onClick={() => void useActivityStore.getState().setFilter(tab)}
              className={cn(
                'border-b-2 px-3 py-2 text-[14px]',
                filter === tab
                  ? 'border-slack-link font-bold text-slack-primary'
                  : 'border-transparent text-slack-secondary hover:text-slack-primary',
              )}
            >
              {t(`tabs.${tab}`)}
            </button>
          ))}
        </div>
      </div>

      <div ref={listRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto p-4">
        {isLoading && items.length === 0 ? (
          <div className="text-center text-sm text-slack-hint">{t('page.loading')}</div>
        ) : loadError ? (
          <div className="text-center text-sm text-slack-error">{t('page.loadFailed')}</div>
        ) : items.length === 0 ? (
          <div data-testid="activity-empty" className="py-8 text-center text-sm text-slack-hint">{t('page.empty')}</div>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  data-testid="activity-item"
                  data-unread={item.readAt === null}
                  onClick={() => handleOpen(item)}
                  className={cn(
                    'group flex w-full items-start gap-3 rounded-lg p-3 text-start hover:bg-slack-hover',
                    item.readAt === null && 'bg-slack-mention',
                  )}
                >
                  <Avatar src={item.actor.avatar} alt={item.actor.name} fallback={item.actor.name} size="md" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-bold text-slack-primary">{describeActivity(item, t)}</span>
                      <span className="text-[12px] text-slack-secondary">
                        {formatDateTime(item.createdAt)}
                      </span>
                    </div>
                    <div className="line-clamp-2 break-words text-[14px] text-slack-primary">
                      {item.reminder?.text && <div>{item.reminder.text}</div>}
                      {item.message ? renderMessageContent(item.message.excerpt) : !item.reminder?.text && t('page.messageDeleted')}
                    </div>
                  </div>
                  {item.readAt === null && (
                    <span aria-label={t('page.unread')} className="mt-2 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-red-500" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {isLoadingMore && <div className="py-2 text-center text-sm text-slack-hint">{t('page.loadingMore')}</div>}
      </div>
    </div>
  );
}
