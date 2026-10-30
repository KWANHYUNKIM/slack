import { forwardRef, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface EmojiOption {
  id: string;
  native: string;
  name: string;
}

interface EmojiAutocompleteProps {
  emojis: EmojiOption[];
  selectedIndex: number;
  query: string;
  onSelect: (emoji: EmojiOption) => void;
}

export const EmojiAutocomplete = forwardRef<HTMLDivElement, EmojiAutocompleteProps>(
  function EmojiAutocomplete({ emojis, selectedIndex, query, onSelect }, ref) {
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => {
      itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    if (emojis.length === 0) return null;

    return (
      <div
        data-testid="emoji-autocomplete"
        ref={ref}
        className="absolute bottom-full left-0 mb-1 w-[320px] max-h-[260px] overflow-y-auto rounded-lg border border-slack-border bg-white shadow-lg z-50"
      >
        {emojis.map((emoji, index) => {
          // Bold the matched portion of the id
          const colonId = `:${emoji.id}:`;
          const matchIdx = emoji.id.indexOf(query);
          let label: React.ReactNode = colonId;
          if (matchIdx >= 0) {
            const before = colonId.slice(0, matchIdx + 1); // includes leading ':'
            const match = colonId.slice(matchIdx + 1, matchIdx + 1 + query.length);
            const after = colonId.slice(matchIdx + 1 + query.length);
            label = (
              <>
                {before}
                <span className="font-bold text-slack-primary">{match}</span>
                {after}
              </>
            );
          }

          return (
            <button
              key={emoji.id}
              ref={(el) => { itemRefs.current[index] = el; }}
              onClick={() => onSelect(emoji)}
              className={cn(
                'flex w-full items-center gap-3 px-3 py-1.5 text-left text-sm hover:bg-slack-link hover:text-white',
                index === selectedIndex ? 'bg-slack-link text-white' : 'text-slack-secondary',
              )}
            >
              <span className="text-xl leading-none flex-shrink-0">{emoji.native}</span>
              <span className="truncate">{label}</span>
            </button>
          );
        })}
        <div className="flex items-center gap-4 border-t border-slack-border px-3 py-1.5 text-[11px] text-slack-hint">
          <span><kbd className="font-semibold">↑↓</kbd> to navigate</span>
          <span><kbd className="font-semibold">↵</kbd> to select</span>
          <span><kbd className="font-semibold">esc</kbd> to dismiss</span>
        </div>
      </div>
    );
  },
);
