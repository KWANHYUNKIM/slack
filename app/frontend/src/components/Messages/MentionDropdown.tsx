import { forwardRef, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { MENTION_CHANNEL_ID, MENTION_HERE_ID, type MentionUser } from '@/lib/types';

// UI strings (to be moved to translation keys)
const TEXT = {
  hereLabel: '@here',
  hereHint: 'Notify everyone who is online',
  channelLabel: '@channel',
  channelHint: 'Notify everyone in this channel',
};

interface MentionDropdownProps {
  users: MentionUser[];
  selectedIndex: number;
  onSelect: (user: MentionUser) => void;
}

export const MentionDropdown = forwardRef<HTMLDivElement, MentionDropdownProps>(
  function MentionDropdown({ users, selectedIndex, onSelect }, ref) {
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
      itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    if (users.length === 0) return null;

    return (
      <div
        data-testid="mention-dropdown"
        ref={ref}
        className="absolute bottom-full left-0 mb-1 w-[280px] max-h-[200px] overflow-y-auto rounded-lg border border-slack-border bg-white shadow-lg z-50"
      >
        {users.map((user, index) => {
          const isHere = user.id === MENTION_HERE_ID && user.name === 'here';
          const isChannel = user.id === MENTION_CHANNEL_ID && user.name === 'channel';
          const isBroadcast = isHere || isChannel;
          return (
            <button
              key={user.id}
              ref={(el) => { itemRefs.current[index] = el; }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(user)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slack-link hover:text-white',
                index === selectedIndex ? 'bg-slack-link text-white' : 'text-slack-primary',
              )}
            >
              {isBroadcast ? (
                <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-amber-400 text-[10px] font-bold text-white">@</div>
              ) : (
                <Avatar
                  src={user.avatar ?? undefined}
                  alt={user.name}
                  fallback={user.name}
                  size="sm"
                  className="flex-shrink-0"
                />
              )}
              <div className="flex flex-col truncate">
                <span className="truncate font-medium">{isHere ? TEXT.hereLabel : isChannel ? TEXT.channelLabel : user.name}</span>
                {isBroadcast && <span className="text-xs text-slack-hint truncate">{isHere ? TEXT.hereHint : TEXT.channelHint}</span>}
              </div>
            </button>
          );
        })}
      </div>
    );
  },
);
