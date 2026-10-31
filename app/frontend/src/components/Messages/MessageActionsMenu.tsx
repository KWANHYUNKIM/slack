import { useRef, useLayoutEffect, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pin, Pencil, Trash2, MailOpen, Link2, AlarmClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useReminderStore } from '@/stores/useReminderStore';
import { ReminderMenu } from './ReminderMenu';
import { alignInline, isRtlDocument } from '@/lib/popoverPosition';

interface MessageActionsMenuProps {
  onPin?: () => void;
  isPinned?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onMarkUnread?: () => void;
  onCopyLink?: () => void;
  /** 있으면 "리마인더" 항목을 보인다. 채널 메시지는 messageId, DM은 dmId */
  reminderTarget?: { messageId?: number; dmId?: number };
  onClose: () => void;
  showOwnerActions: boolean;
  /** Classes applied to the invisible positioning anchor (e.g. absolute -top-4 end-5 mt-9) */
  anchorClassName?: string;
  testIdPrefix?: string;
}

export function MessageActionsMenu({
  onPin,
  isPinned,
  onEdit,
  onDelete,
  onMarkUnread,
  onCopyLink,
  reminderTarget,
  onClose,
  showOwnerActions,
  anchorClassName,
  testIdPrefix,
}: MessageActionsMenuProps) {
  const { t } = useTranslation('messages');
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });
  const [showReminder, setShowReminder] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Position measurement. 리마인더 하위 메뉴가 펼쳐지면 높이가 바뀌므로 다시 잰다.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const menu = menuRef.current;
    if (!anchor || !menu) return;

    const anchorRect = anchor.getBoundingClientRect();
    const menuHeight = menu.offsetHeight;
    const menuWidth = menu.offsetWidth;

    let top = anchorRect.top;
    if (top + menuHeight > window.innerHeight) {
      top = Math.max(0, Math.min(anchorRect.top - menuHeight, window.innerHeight - menuHeight));
    }

    setPos({ top, left: alignInline(anchorRect, menuWidth, window.innerWidth, isRtlDocument()) });
  }, [showReminder]);

  // Close on scroll (matches Slack behavior) and click outside
  useEffect(() => {
    const handleScroll = () => onCloseRef.current();
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    // Delay listeners to avoid catching the opening click/scroll
    const timerId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside, true);
      window.addEventListener('scroll', handleScroll, true);
    }, 0);
    return () => {
      clearTimeout(timerId);
      document.removeEventListener('click', handleClickOutside, true);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, []);

  const hasAnyAction = onPin || showOwnerActions || onMarkUnread || onCopyLink || reminderTarget;

  const menuContent = (
    <div
      ref={menuRef}
      data-testid={testIdPrefix ? `${testIdPrefix}-more-menu` : undefined}
      className="w-48 rounded-lg border border-slack-border bg-white py-1 shadow-lg"
      style={
        pos
          ? { position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }
          : { position: 'fixed', visibility: 'hidden' as const, top: -9999, left: -9999 }
      }
    >
      {!hasAnyAction ? (
        <div className="px-4 py-1.5 text-[13px] text-slack-secondary">
          {t('actionsMenu.noActions')}
        </div>
      ) : (
        <>
          {onMarkUnread && (
            <Button variant="menu-item" onClick={onMarkUnread}>
              <MailOpen className="h-4 w-4" />
              {t('actionsMenu.markUnread')}
            </Button>
          )}
          {onCopyLink && (
            <Button
              variant="menu-item"
              data-testid={testIdPrefix ? `${testIdPrefix}-copy-link-btn` : 'copy-link-btn'}
              onClick={onCopyLink}
            >
              <Link2 className="h-4 w-4" />
              {t('actionsMenu.copyLink')}
            </Button>
          )}
          {reminderTarget && (
            <Button variant="menu-item" data-testid="reminder-menu-item" aria-expanded={showReminder} onClick={() => setShowReminder((v) => !v)}>
              <AlarmClock className="h-4 w-4" />
              {t('actionsMenu.remind')}
            </Button>
          )}
          {reminderTarget && showReminder && (
            <ReminderMenu
              onPick={(date) => {
                onClose();
                void useReminderStore.getState().create({ ...reminderTarget, remindAt: date });
              }}
            />
          )}
          {onPin && (
            <Button variant="menu-item" onClick={onPin}>
              <Pin className="h-4 w-4" />
              {isPinned ? t('actionsMenu.unpin') : t('actionsMenu.pin')}
            </Button>
          )}
          {showOwnerActions && onEdit && (
            <Button
              variant="menu-item"
              data-testid={testIdPrefix ? `${testIdPrefix}-edit-btn` : undefined}
              onClick={onEdit}
            >
              <Pencil className="h-4 w-4" />
              {t('actionsMenu.edit')}
            </Button>
          )}
          {showOwnerActions && onDelete && (
            <Button
              variant="menu-item-danger"
              data-testid={testIdPrefix ? `${testIdPrefix}-delete-btn` : undefined}
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4" />
              {t('actionsMenu.delete')}
            </Button>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      {/* Invisible anchor to measure where the menu should appear */}
      <div ref={anchorRef} className={cn('pointer-events-none', anchorClassName)} style={{ height: 0, overflow: 'hidden' }} />
      {createPortal(menuContent, document.body)}
    </>
  );
}
