import { cn } from '@/lib/utils';

interface UnreadBadgeProps {
  count: number;
  /** Unread messages that mention me; shown as a red number instead of the plain count */
  mentionCount?: number;
  isActive: boolean;
}

export function UnreadBadge({ count, mentionCount = 0, isActive }: UnreadBadgeProps) {
  if (mentionCount > 0) {
    return (
      <span
        data-testid="mention-badge"
        className="text-[12px] ms-1 min-w-[20px] h-5 flex items-center justify-center rounded-full px-1.5 bg-red-500 text-white font-bold"
      >
        {mentionCount}
      </span>
    );
  }
  if (count <= 0) return null;
  return (
    <span className={cn(
      'text-[12px] ms-1 min-w-[20px] h-5 flex items-center justify-center rounded-full px-1.5',
      isActive ? 'bg-slack-primary text-white' : 'bg-slack-badge text-white'
    )}>
      {count}
    </span>
  );
}
