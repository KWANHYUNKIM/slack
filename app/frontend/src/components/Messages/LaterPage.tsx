import { useState, useEffect, useCallback } from 'react';
import { Bookmark, Hash, Menu, Clock, AlarmClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/i18n/format';
import { getBookmarks } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { renderMessageContent } from '@/lib/renderMessageContent';
import { useBookmarkStore } from '@/stores/useBookmarkStore';
import { useNavigate } from 'react-router-dom';
import { useMobileStore } from '@/stores/useMobileStore';
import { ScheduledMessagesTab } from './ScheduledMessagesTab';
import { RemindersTab } from './RemindersTab';
import { cn } from '@/lib/utils';

interface BookmarkedMessage {
  messageId: number;
  createdAt: string;
  message: {
    id: number;
    content: string;
    createdAt: string;
    user: { id: number; name: string; email: string; avatar?: string | null };
    channel: { id: number; name: string };
  };
}

type Tab = 'saved' | 'scheduled' | 'reminders';

export function LaterPage() {
  const { t } = useTranslation('messages');
  const [activeTab, setActiveTab] = useState<Tab>('saved');
  const [bookmarks, setBookmarks] = useState<BookmarkedMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toggle = useBookmarkStore((s) => s.toggle);
  const navigate = useNavigate();

  const fetchBookmarks = useCallback(() => {
    setIsLoading(true);
    getBookmarks()
      .then((data) => {
        setBookmarks(data as BookmarkedMessage[]);
        setLoadError(null);
      })
      .catch(() => setLoadError(t('later.loadFailed')))
      .finally(() => setIsLoading(false));
  }, [t]);

  useEffect(() => {
    fetchBookmarks();
  }, [fetchBookmarks]);

  const handleRemove = async (messageId: number) => {
    // Optimistically remove from local list immediately
    setBookmarks((prev) => prev.filter((b) => b.messageId !== messageId));
    try {
      await toggle(messageId);
    } catch {
      // If toggle fails, refetch bookmarks to restore accurate state
      fetchBookmarks();
    }
  };

  return (
    <div data-testid="later-page" className="flex h-full flex-col">
      <div className="flex flex-col flex-shrink-0 border-b border-slack-border pt-[env(safe-area-inset-top)]">
        <div className="flex h-[49px] items-center px-5">
          <button
            onClick={useMobileStore.getState().openSidebar}
          aria-label={t('later.menu')}
            className="me-2 flex h-8 w-8 items-center justify-center rounded hover:bg-slack-hover md:hidden"
          >
            <Menu className="h-5 w-5 text-slack-secondary" />
          </button>
          <Bookmark className="h-5 w-5 text-slack-secondary me-2" />
          <span className="text-[18px] font-bold text-slack-primary">{t('later.title')}</span>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 px-5 pb-1">
          <button
            data-testid="later-tab-saved"
            onClick={() => setActiveTab('saved')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
              activeTab === 'saved'
                ? 'bg-slack-active-tab text-slack-primary'
                : 'text-slack-secondary hover:bg-slack-hover'
            )}
          >
            <Bookmark className="h-3.5 w-3.5" />
            {t('later.saved')}
          </button>
          <button
            data-testid="later-tab-scheduled"
            onClick={() => setActiveTab('scheduled')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
              activeTab === 'scheduled'
                ? 'bg-slack-active-tab text-slack-primary'
                : 'text-slack-secondary hover:bg-slack-hover'
            )}
          >
            <Clock className="h-3.5 w-3.5" />
            {t('later.scheduled')}
          </button>
          <button
            data-testid="later-tab-reminders"
            onClick={() => setActiveTab('reminders')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors',
              activeTab === 'reminders'
                ? 'bg-slack-active-tab text-slack-primary'
                : 'text-slack-secondary hover:bg-slack-hover'
            )}
          >
            <AlarmClock className="h-3.5 w-3.5" />
            {t('later.reminders')}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {activeTab === 'scheduled' ? (
          <ScheduledMessagesTab />
        ) : activeTab === 'reminders' ? (
          <RemindersTab />
        ) : isLoading ? (
          <div className="text-center text-sm text-slack-hint">{t('common:status.loading')}</div>
        ) : loadError ? (
          <div className="text-center text-sm text-slack-error">{loadError}</div>
        ) : bookmarks.length === 0 ? (
          <div className="text-center text-sm text-slack-hint py-8">
            {t('later.empty')}
          </div>
        ) : (
          <div className="space-y-1">
            {bookmarks.map((bm) => (
              <div
                key={bm.messageId}
                className="flex items-start gap-3 rounded-lg p-3 hover:bg-slack-hover cursor-pointer group"
                onClick={() => navigate(`/c/${bm.message.channel.id}`, { state: { scrollToMessageId: bm.messageId } })}
              >
                <Avatar
                  src={bm.message.user.avatar ?? undefined}
                  alt={bm.message.user.name}
                  fallback={bm.message.user.name}
                  size="md"
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-bold text-slack-primary">
                      {bm.message.user.name}
                    </span>
                    <span className="text-[12px] text-slack-secondary">
                      {formatDateTime(bm.message.createdAt)}
                    </span>
                  </div>
                  <div className="text-[15px] text-slack-primary leading-[22px] whitespace-pre-wrap break-words line-clamp-3">
                    {renderMessageContent(bm.message.content)}
                  </div>
                  <div className="flex items-center gap-1 mt-1 text-[12px] text-slack-hint">
                    <Hash className="h-3 w-3" />
                    <span>{bm.message.channel.name}</span>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemove(bm.messageId);
                  }}
                  className="flex-shrink-0 flex h-8 w-8 items-center justify-center rounded hover:bg-slack-border-light transition-opacity"
                  title={t('later.removeSaved')}
                >
                  <Bookmark className="h-4 w-4 text-slack-warning fill-slack-warning" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
