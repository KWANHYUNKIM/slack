import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Hash, Lock, Moon, Search, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getCollator } from '@/lib/i18n/format';
import { groupDisplayName } from '@/lib/groupDM';
import { buildSwitcherItems, canPruneRecents, pruneRecents, rankSwitcherItems, type SwitcherItem } from '@/lib/switcher';
import { useChannelStore } from '@/stores/useChannelStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { useSwitcherStore } from '@/stores/useSwitcherStore';
import { useCustomStatus, useIsDnd } from '@/stores/useStatusStore';
import { Avatar } from '@/components/ui/avatar';
import { isMacPlatform } from '@/hooks/useGlobalShortcuts';
import { SHORTCUTS, shortcutKeys, type KeyLabelId } from '@/lib/shortcuts';

const optionId = (key: string) => `switcher-opt-${key}`;

interface RowProps {
  item: SwitcherItem;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}

function SwitcherRow({ item, active, onHover, onSelect }: RowProps) {
  const { t } = useTranslation('common');
  // 1:1 DM의 상대 정보(아바타·프레즌스)는 스토어에서 읽고, 상태 이모지·방해금지는 05의 훅을 재사용한다
  const dm = useChannelStore((s) => (item.kind === 'dm' ? s.directMessages.find((d) => d.userId === item.id) : undefined));
  const customStatus = useCustomStatus(item.kind === 'dm' ? item.id : undefined);
  const isDnd = useIsDnd(item.kind === 'dm' ? item.id : undefined);
  const hasUnread = item.unreadCount + item.mentionCount > 0;

  const icon =
    item.kind === 'channel' ? (
      item.isPrivate ? <Lock className="h-4 w-4" aria-hidden="true" /> : <Hash className="h-4 w-4" aria-hidden="true" />
    ) : item.kind === 'dm' ? (
      <Avatar src={dm?.userAvatar} alt={item.label} fallback={item.label} size="sm" status={dm?.userStatus} />
    ) : (
      <Users className="h-4 w-4" aria-hidden="true" />
    );
  const kindLabel = t(`quickSwitcher.kind.${item.kind}`);

  return (
    <li
      id={optionId(item.key)}
      role="option"
      aria-selected={active}
      data-testid="switcher-option"
      data-key={item.key}
      // 입력창의 포커스를 빼앗지 않는다
      onMouseDown={(e) => e.preventDefault()}
      onMouseMove={onHover}
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-[15px]',
        active ? 'bg-slack-link text-white' : 'text-slack-primary',
        hasUnread && 'font-bold',
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{item.label}</span>
      {item.isStarred && <span className="sr-only">{t('quickSwitcher.starred')}</span>}
      {customStatus?.emoji && (
        <span className="shrink-0" title={customStatus.text ?? undefined}>{customStatus.emoji}</span>
      )}
      {isDnd && <Moon className="h-3 w-3 shrink-0 opacity-60" aria-label={t('quickSwitcher.dnd')} />}
      <span className={cn('ms-auto shrink-0 text-[12px]', active ? 'text-white/80' : 'text-slack-hint')}>{kindLabel}</span>
      {hasUnread && (
        <span
          data-testid="switcher-unread-badge"
          className={cn(
            'flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full px-1 text-[10px] text-white',
            item.mentionCount > 0 ? 'bg-red-500' : 'bg-slack-hint',
          )}
        >
          <span className="sr-only">{t('quickSwitcher.unread')}</span>
          {item.mentionCount > 0 ? item.mentionCount : item.unreadCount}
        </span>
      )}
    </li>
  );
}

/** Cmd/Ctrl+K 빠른 전환기(06). 열릴 때마다 새로 마운트해 검색어·선택을 초기화한다. */
export function QuickSwitcher() {
  const open = useSwitcherStore((s) => s.switcherOpen);
  return open ? <SwitcherDialog /> : null;
}

// 후보는 이미 로드된 스토어에서 클라이언트만으로 만든다.
function SwitcherDialog() {
  const { t, i18n } = useTranslation('common');
  const navigate = useNavigate();
  const close = useSwitcherStore((s) => s.closeSwitcher);
  const recents = useSwitcherStore((s) => s.recents);
  const setRecents = useSwitcherStore((s) => s.setRecents);
  const clearRecents = useSwitcherStore((s) => s.clearRecents);
  const channels = useChannelStore((s) => s.channels);
  const directMessages = useChannelStore((s) => s.directMessages);
  const groupDMs = useChannelStore((s) => s.groupDMs);
  const listsReady = useChannelStore(canPruneRecents);
  const myId = useAuthStore((s) => s.user?.id);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const items = useMemo(
    () => buildSwitcherItems({ channels, directMessages, groupDMs, groupName: (g) => groupDisplayName(g, myId) }),
    [channels, directMessages, groupDMs, myId],
  );
  const results = useMemo(
    () => rankSwitcherItems(items, query, recents, getCollator(i18n.language).compare),
    [items, query, recents, i18n.language],
  );

  // 열릴 때: 이전 포커스를 기억하고 입력창에 포커스. 닫힐 때: 포커스 복귀
  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      const el = returnFocusRef.current;
      if (el && document.contains(el)) el.focus();
    };
  }, []);

  // 나가거나 삭제된 대상은 최근 방문 기록에서도 지운다.
  // 목록 로드 중이거나 실패했을 때는 비어 보이는 목록으로 기록을 지우지 않도록 건너뛴다.
  useEffect(() => {
    if (!listsReady) return;
    const alive = pruneRecents(recents, items);
    if (alive.length !== recents.length) setRecents(alive);
  }, [listsReady, recents, items, setRecents]);

  // 선택 항목을 보이는 위치로
  useEffect(() => {
    const item = results[activeIndex];
    if (item) document.getElementById(optionId(item.key))?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, results]);

  const select = (item: SwitcherItem | undefined) => {
    if (!item) return;
    close();
    navigate(item.path);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      select(results[activeIndex]);
    } else if (e.key === 'Escape') {
      // Esc는 여기서만 처리한다. 전파를 막아 아래 레이어(라이트박스 등)는 닫히지 않는다.
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      // 포커스 트랩: 입력창과 목록 사이에서만 움직이므로 Tab은 입력창에 머문다
      e.preventDefault();
    }
  };

  const active = results[activeIndex];
  const keyLabel = (id: KeyLabelId) => t(`shortcuts.keys.${id}`);
  const switcherKeys = shortcutKeys(SHORTCUTS.find((d) => d.id === 'switcher')!, isMacPlatform(), keyLabel).join('+');
  const showingRecents = query.trim().length === 0;

  return (
    <div
      data-testid="quick-switcher-backdrop"
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 px-4 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('quickSwitcher.title')}
        data-testid="quick-switcher"
        className="w-full max-w-[560px] overflow-hidden rounded-xl bg-white shadow-xl"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-slack-border px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-slack-hint" aria-hidden="true" />
          <input
            ref={inputRef}
            data-testid="quick-switcher-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="switcher-listbox"
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active.key) : undefined}
            aria-label={t('quickSwitcher.inputLabel')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder={t('quickSwitcher.placeholder')}
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent text-[16px] text-slack-primary outline-none placeholder:text-slack-hint"
          />
        </div>
        <div className="flex items-center justify-between px-4 pt-2 text-[12px] font-semibold text-slack-hint">
          <span>{showingRecents ? t('quickSwitcher.recent') : t('quickSwitcher.results')}</span>
          {showingRecents && recents.length > 0 && (
            <button
              type="button"
              data-testid="quick-switcher-clear-recents"
              onClick={() => {
                clearRecents();
                inputRef.current?.focus();
              }}
              className="rounded px-1 font-normal text-slack-link hover:underline"
            >
              {t('quickSwitcher.clearRecent')}
            </button>
          )}
        </div>
        <ul
          id="switcher-listbox"
          role="listbox"
          aria-label={t('quickSwitcher.listLabel')}
          className="max-h-[360px] overflow-y-auto p-2"
        >
          {results.map((item, i) => (
            <SwitcherRow
              key={item.key}
              item={item}
              active={i === activeIndex}
              onHover={() => i !== activeIndex && setActiveIndex(i)}
              onSelect={() => select(item)}
            />
          ))}
        </ul>
        {results.length === 0 && (
          <p data-testid="quick-switcher-empty" className="px-4 pb-4 text-[14px] text-slack-hint" role="status">
            {t('quickSwitcher.noResults')}
          </p>
        )}
        <div className="border-t border-slack-border px-4 py-2 text-[12px] text-slack-hint">
          {t('quickSwitcher.footer', { keys: switcherKeys })}
        </div>
      </div>
    </div>
  );
}
