import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Menu } from 'lucide-react';
import { format } from 'date-fns';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { renderMessageContent } from '@/lib/renderMessageContent';
import { useMobileStore } from '@/stores/useMobileStore';
import { useActivityStore } from '@/stores/useActivityStore';
import type { ActivityFilter, ApiActivity } from '@/lib/api';

// UI strings (to be moved to translation keys)
const TEXT = {
  title: 'Activity',
  markAllRead: 'Mark all as read',
  loading: 'Loading...',
  loadingMore: 'Loading more...',
  loadFailed: 'Failed to load activity.',
  empty: 'No activity yet.',
  unread: 'Unread',
  tabs: {
    all: 'All',
    mentions: 'Mentions',
    threads: 'Threads',
    reactions: 'Reactions',
  } satisfies Record<ActivityFilter, string>,
  someone: 'Someone',
  directMessage: 'a direct message',
  describe: {
    mention: (actor: string, where: string) => `${actor} mentioned you in ${where}`,
    channelMention: (actor: string, where: string) => `${actor} mentioned @channel in ${where}`,
    hereMention: (actor: string, where: string) => `${actor} mentioned @here in ${where}`,
    threadReply: (actor: string, where: string) => `${actor} replied to a thread in ${where}`,
    reaction: (actor: string, emoji: string, where: string) => `${actor} reacted ${emoji} to your message in ${where}`,
  },
} as const;

const TAB_ORDER: ActivityFilter[] = ['all', 'mentions', 'threads', 'reactions'];
const LOAD_MORE_THRESHOLD_PX = 200;

function describeActivity(item: ApiActivity): string {
  const actor = item.actor.name || TEXT.someone;
  const where = item.channel ? `#${item.channel.name}` : TEXT.directMessage;
  switch (item.type) {
    case 'MENTION': return TEXT.describe.mention(actor, where);
    case 'CHANNEL_MENTION': return TEXT.describe.channelMention(actor, where);
    case 'HERE_MENTION': return TEXT.describe.hereMention(actor, where);
    case 'THREAD_REPLY': return TEXT.describe.threadReply(actor, where);
    case 'REACTION': return TEXT.describe.reaction(actor, item.emoji ?? '', where);
  }
}

export function ActivityPage() {
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
    if (item.dmId !== null) {
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
            aria-label="Menu"
            onClick={useMobileStore.getState().openSidebar}
            className="mr-2 flex h-8 w-8 items-center justify-center rounded hover:bg-slack-hover md:hidden"
          >
            <Menu className="h-5 w-5 text-slack-secondary" />
          </button>
          <Bell className="h-5 w-5 text-slack-secondary mr-2" />
          <span className="text-[18px] font-bold text-slack-primary">{TEXT.title}</span>
          <button
            data-testid="activity-mark-all-read"
            onClick={() => void useActivityStore.getState().markAllRead()}
            disabled={unreadTotal === 0}
            className="ml-auto rounded px-3 py-1 text-[13px] font-medium text-slack-link hover:bg-slack-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {TEXT.markAllRead}
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
              {TEXT.tabs[tab]}
            </button>
          ))}
        </div>
      </div>

      <div ref={listRef} onScroll={handleScroll} className="flex-1 min-h-0 overflow-y-auto p-4">
        {isLoading && items.length === 0 ? (
          <div className="text-center text-sm text-slack-hint">{TEXT.loading}</div>
        ) : loadError ? (
          <div className="text-center text-sm text-slack-error">{TEXT.loadFailed}</div>
        ) : items.length === 0 ? (
          <div data-testid="activity-empty" className="py-8 text-center text-sm text-slack-hint">{TEXT.empty}</div>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  data-testid="activity-item"
                  data-unread={item.readAt === null}
                  onClick={() => handleOpen(item)}
                  className={cn(
                    'group flex w-full items-start gap-3 rounded-lg p-3 text-left hover:bg-slack-hover',
                    item.readAt === null && 'bg-slack-mention',
                  )}
                >
                  <Avatar src={item.actor.avatar} alt={item.actor.name} fallback={item.actor.name} size="md" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-bold text-slack-primary">{describeActivity(item)}</span>
                      <span className="text-[12px] text-slack-secondary">
                        {format(new Date(item.createdAt), 'MMM d, h:mm a')}
                      </span>
                    </div>
                    <div className="line-clamp-2 break-words text-[14px] text-slack-primary">{renderMessageContent(item.message.excerpt)}</div>
                  </div>
                  {item.readAt === null && (
                    <span aria-label={TEXT.unread} className="mt-2 h-2.5 w-2.5 flex-shrink-0 rounded-full bg-red-500" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {isLoadingMore && <div className="py-2 text-center text-sm text-slack-hint">{TEXT.loadingMore}</div>}
      </div>
    </div>
  );
}
