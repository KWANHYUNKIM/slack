import { useRef, useEffect } from 'react';
import { Link2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface LinkModalProps {
  linkUrl: string;
  linkText: string;
  onLinkUrlChange: (url: string) => void;
  onLinkTextChange: (text: string) => void;
  onSave: () => void;
  onClose: () => void;
}

export function LinkModal({
  linkUrl,
  linkText,
  onLinkUrlChange,
  onLinkTextChange,
  onSave,
  onClose,
}: LinkModalProps) {
  const linkUrlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => linkUrlInputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  const handleClose = () => {
    onLinkUrlChange('');
    onLinkTextChange('');
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onSave();
    if (e.key === 'Escape') handleClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Modal panel */}
      <div className="relative z-10 w-[440px] rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slack-border-light px-5 py-4">
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-slack-link" />
            <h2 className="text-[17px] font-bold text-slack-primary">Add link</h2>
          </div>
          <Button variant="toolbar" size="icon-sm" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-semibold text-slack-primary">URL</label>
            <input
              ref={linkUrlInputRef}
              data-testid="link-url-input"
              type="url"
              value={linkUrl}
              onChange={(e) => onLinkUrlChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="https://example.com"
              className="h-9 w-full rounded-md border border-slack-border-dark px-3 text-[14px] text-slack-primary placeholder-slack-secondary outline-none focus:border-slack-link focus:ring-1 focus:ring-slack-link"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-semibold text-slack-primary">
              Display text <span className="font-normal text-slack-secondary">(optional)</span>
            </label>
            <input
              data-testid="link-text-input"
              type="text"
              value={linkText}
              onChange={(e) => onLinkTextChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Link text"
              className="h-9 w-full rounded-md border border-slack-border-dark px-3 text-[14px] text-slack-primary placeholder-slack-secondary outline-none focus:border-slack-link focus:ring-1 focus:ring-slack-link"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slack-border-light px-5 py-3">
          <Button
            variant="outline"
            onClick={handleClose}
            className="border-slack-border-dark px-4 py-1.5 text-[14px] font-medium text-slack-primary hover:bg-slack-hover"
          >
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={!linkUrl.trim()}
            className={cn(
              'px-4 py-1.5 text-[14px] font-medium',
              !linkUrl.trim() && 'bg-slack-border cursor-not-allowed hover:bg-slack-border',
            )}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
