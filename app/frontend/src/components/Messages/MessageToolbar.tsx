import { useTranslation } from 'react-i18next';
import { Smile, MessageSquare, MoreHorizontal, Bookmark } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface MessageToolbarProps {
  onEmojiClick?: () => void;
  onThreadClick?: () => void;
  onBookmarkClick?: () => void;
  isBookmarked?: boolean;
  onMoreClick?: () => void;
  className?: string;
  testIdPrefix?: string;
}

export function MessageToolbar({
  onEmojiClick,
  onThreadClick,
  onBookmarkClick,
  isBookmarked,
  onMoreClick,
  className,
  testIdPrefix,
}: MessageToolbarProps) {
  const { t } = useTranslation('messages');
  return (
    <div
      data-testid={testIdPrefix ? `${testIdPrefix}-message-toolbar` : undefined}
      className={cn(
        'flex items-center gap-0.5 rounded-lg border border-slack-border bg-white p-0.5 shadow-sm',
        className,
      )}
      onTouchStart={(e) => e.stopPropagation()}
    >
      {onEmojiClick && (
        <Button
          variant="toolbar"
          size="icon-sm"
          data-testid={testIdPrefix ? `${testIdPrefix}-emoji-btn` : undefined}
          title={t('toolbar.addReaction')}
          onClick={onEmojiClick}
        >
          <Smile className="h-4 w-4 text-slack-secondary" />
        </Button>
      )}
      {onThreadClick && (
        <Button
          variant="toolbar"
          size="icon-sm"
          title={t('toolbar.replyInThread')}
          onClick={onThreadClick}
        >
          <MessageSquare className="h-4 w-4 text-slack-secondary" />
        </Button>
      )}
      {onBookmarkClick && (
        <Button
          variant="toolbar"
          size="icon-sm"
          data-testid="bookmark-button"
          onClick={onBookmarkClick}
          title={isBookmarked ? t('toolbar.removeBookmark') : t('toolbar.bookmark')}
        >
          <Bookmark
            data-testid="bookmark-icon"
            className={cn(
              'h-4 w-4',
              isBookmarked ? 'text-yellow-500 fill-current' : 'text-slack-secondary',
            )}
          />
        </Button>
      )}
      {onMoreClick && (
        <Button
          variant="toolbar"
          size="icon-sm"
          data-testid={testIdPrefix ? `${testIdPrefix}-more-btn` : undefined}
          title={t('toolbar.moreActions')}
          onClick={onMoreClick}
        >
          <MoreHorizontal className="h-4 w-4 text-slack-secondary" />
        </Button>
      )}
    </div>
  );
}
