import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Menu, X, Hash, Lock, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { formatDateTime, formatFileSize } from '@/lib/i18n/format';
import {
  searchAll, type SearchPageResponse, type SearchParsedFilters, type SearchResult,
  type SearchFileResult, type SearchPersonResult, type SearchChannelResult, type SearchTab, type SearchSort,
} from '@/lib/api';
import { chipsOf, removeChip, stripFilters, type FilterChip } from '@/lib/searchQuery';
import { highlightNode } from '@/lib/highlightNode';
import { renderMessageContent } from '@/lib/renderMessageContent';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { useMobileStore } from '@/stores/useMobileStore';
import { useProfileStore } from '@/stores/useProfileStore';

type Item = SearchPageResponse['results'][number];

const TABS: SearchTab[] = ['messages', 'files', 'people', 'channels'];

/** 이름·파일명 같은 일반 문자열에서 키워드를 <mark>로 감싼다. 문자열을 HTML로 넣지 않는다. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return <>{highlightNode(text, terms)}</>;
}

const itemKey = (item: Item) => `${item.type}-${item.id}`;

export function SearchPage() {
  const { t } = useTranslation(['messages', 'common']);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const tab: SearchTab = TABS.includes(params.get('tab') as SearchTab) ? (params.get('tab') as SearchTab) : 'messages';
  const sort: SearchSort = params.get('sort') === 'recent' ? 'recent' : 'relevance';

  const [draft, setDraft] = useState(q);
  const [items, setItems] = useState<Item[]>([]);
  const [filters, setFilters] = useState<SearchParsedFilters | undefined>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const requestRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(q), [q]);

  // 질의, 탭, 정렬이 바뀌면 처음부터 다시 조회한다. 늦게 온 이전 응답은 버린다.
  useEffect(() => {
    const id = ++requestRef.current;
    setItems([]);
    setNextCursor(null);
    setLoadError(false);
    setMoreError(false);
    setTruncated(false);
    if (!q.trim()) {
      setFilters(undefined);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    searchAll(q, { tab, sort })
      .then((data) => {
        if (id !== requestRef.current) return;
        setItems(data.results);
        setFilters(data.parsedFilters);
        setNextCursor(data.nextCursor ?? null);
        setTruncated(!!data.truncated);
      })
      .catch(() => { if (id === requestRef.current) setLoadError(true); })
      .finally(() => { if (id === requestRef.current) setIsLoading(false); });
  }, [q, tab, sort]);

  const loadMore = useCallback(() => {
    if (!nextCursor || isLoadingMore || isLoading) return;
    const id = requestRef.current;
    setIsLoadingMore(true);
    setMoreError(false);
    searchAll(q, { tab, sort, cursor: nextCursor })
      .then((data) => {
        if (id !== requestRef.current) return;
        // 페이지 경계에서 겹친 항목은 종류와 id로 걸러 낸다
        setItems((prev) => {
          const seen = new Set(prev.map(itemKey));
          return [...prev, ...data.results.filter((r) => !seen.has(itemKey(r)))];
        });
        setNextCursor(data.nextCursor ?? null);
        setTruncated(!!data.truncated);
      })
      .catch(() => { if (id === requestRef.current) setMoreError(true); })
      .finally(() => setIsLoadingMore(false));
  }, [nextCursor, isLoadingMore, isLoading, q, tab, sort]);

  // 목록 끝이 보이면 다음 20개를 불러온다(무한 스크롤). 실패하면 자동 재시도를 멈추고 버튼으로만 다시 시도한다.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !nextCursor || moreError || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) loadMore(); });
    io.observe(el);
    return () => io.disconnect();
  }, [nextCursor, moreError, loadMore]);

  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v === null || v === '' ? p.delete(k) : p.set(k, v)));
    setParams(p);
  };

  const chips = useMemo(() => chipsOf(filters), [filters]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    update({ q: draft.trim() });
  };

  const openItem = (item: Item) => {
    if (item.type === 'message' || item.type === 'dm') {
      const r = item as SearchResult;
      // 결과로 이동하는 방식은 기존 around 점프(scrollToMessageId)를 쓴다. 퍼말링크(07)가 머지되면 바꾼다.
      if (r.channel) navigate(`/c/${r.channel.id}`, { state: { scrollToMessageId: r.id } });
      else if (r.groupId) navigate(`/g/${r.groupId}`, { state: { scrollToMessageId: r.id } });
      else if (r.participant) navigate(`/d/${r.participant.id}`, { state: { scrollToMessageId: r.id } });
    } else if (item.type === 'file') {
      const f = item as SearchFileResult;
      const state = f.messageId ? { scrollToMessageId: f.messageId } : f.dmId ? { scrollToMessageId: f.dmId } : undefined;
      if (f.channel) navigate(`/c/${f.channel.id}`, { state });
      else if (f.groupId) navigate(`/g/${f.groupId}`, { state });
      else if (f.participantId) navigate(`/d/${f.participantId}`, { state });
    } else if (item.type === 'person') {
      useProfileStore.getState().openProfile((item as SearchPersonResult).id);
    } else if (item.type === 'channel') {
      navigate(`/c/${(item as SearchChannelResult).id}`);
    }
  };

  const rowKey = itemKey;
  const terms = filters?.terms ?? [];
  const ignored = filters?.ignored ?? [];
  const hasFilters = chips.length > 0;

  return (
    <div data-testid="search-page" className="flex h-full flex-col">
      <div className="flex flex-shrink-0 flex-col border-b border-slack-border pt-[env(safe-area-inset-top)]">
        <div className="flex h-[49px] items-center gap-2 px-5">
          <button
            onClick={useMobileStore.getState().openSidebar}
            aria-label={t('messages:threads.menu')}
            className="flex h-8 w-8 items-center justify-center rounded hover:bg-slack-hover md:hidden"
          >
            <Menu className="h-5 w-5 text-slack-secondary" />
          </button>
          <form onSubmit={onSubmit} className="relative min-w-0 flex-1">
            <Search className="absolute start-2 top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-slack-secondary" />
            <input
              data-testid="search-page-input"
              type="text"
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t('messages:search.placeholder')}
              aria-label={t('messages:search.placeholder')}
              className="h-8 w-full rounded-md border border-slack-border bg-white ps-7 pe-2 text-[14px] placeholder:text-slack-secondary focus:border-slack-link focus:outline-none"
            />
          </form>
        </div>

        {(hasFilters || ignored.length > 0) && (
          <div data-testid="search-chips" className="flex flex-wrap items-center gap-1.5 px-5 pb-2">
            {chips.map((chip: FilterChip) => (
              <span key={chip.label} data-testid="search-chip" className="inline-flex items-center gap-1 rounded-full bg-slack-hover px-2 py-0.5 text-[12px] text-slack-primary">
                {chip.label}
                <button
                  type="button"
                  data-testid="search-chip-remove"
                  aria-label={t('messages:search.removeFilter', { filter: chip.label })}
                  onClick={() => update({ q: removeChip(q, chip).trim() })}
                  className="flex h-4 w-4 items-center justify-center rounded-full hover:bg-slack-border"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {ignored.map((ig, i) => (
              <span key={`${ig.token}-${i}`} data-testid="search-chip-ignored" className="inline-flex items-center rounded-full border border-dashed border-slack-border px-2 py-0.5 text-[12px] text-slack-hint">
                {t(ig.reason === 'limit' ? 'messages:search.ignoredLimitChip' : 'messages:search.ignoredChip', { token: ig.token })}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 px-5">
          <div role="tablist" aria-label={t('messages:search.tabs.label')} className="flex items-center gap-0.5">
            {TABS.map((id) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                data-testid={`search-tab-${id}`}
                onClick={() => update({ tab: id === 'messages' ? null : id })}
                className={cn(
                  'border-b-2 px-3 py-2 text-[13px]',
                  tab === id ? 'border-slack-link font-bold text-slack-primary' : 'border-transparent text-slack-secondary hover:text-slack-primary',
                )}
              >
                {t(`messages:search.tabs.${id}`)}
              </button>
            ))}
          </div>
          {tab === 'messages' && (
            <label className="flex items-center gap-1 text-[12px] text-slack-secondary">
              {t('messages:search.sort.label')}
              <select
                data-testid="search-sort"
                value={sort}
                onChange={(e) => update({ sort: e.target.value === 'recent' ? 'recent' : null })}
                className="rounded border border-slack-border bg-white px-1 py-0.5 text-[12px] text-slack-primary"
              >
                <option value="relevance">{t('messages:search.sort.relevance')}</option>
                <option value="recent">{t('messages:search.sort.recent')}</option>
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!q.trim() ? (
          <div data-testid="search-empty-query" className="py-8 text-center text-sm text-slack-hint">{t('messages:search.emptyQuery')}</div>
        ) : isLoading ? (
          <div className="text-center text-sm text-slack-hint">{t('messages:search.searching')}</div>
        ) : loadError && items.length === 0 ? (
          <div className="text-center text-sm text-slack-error">{t('messages:search.loadFailed')}</div>
        ) : items.length === 0 ? (
          <div data-testid="search-no-results" className="py-8 text-center text-slack-hint">
            <div className="text-[15px] font-bold text-slack-secondary">{t('messages:search.noResults')}</div>
            <div className="mt-1 text-sm">{t('messages:search.noResultsHint')}</div>
            {hasFilters && (
              <button
                type="button"
                data-testid="search-clear-filters"
                onClick={() => update({ q: stripFilters(q, chips).trim() })}
                className="mt-2 text-sm text-slack-link hover:underline"
              >
                {t('messages:search.clearFilters')}
              </button>
            )}
          </div>
        ) : (
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={rowKey(item)}>
                <button
                  type="button"
                  data-testid="search-page-result"
                  onClick={() => openItem(item)}
                  className="w-full rounded-lg border border-slack-border-light px-3 py-2 text-start hover:bg-slack-hover"
                >
                  <ResultRow item={item} terms={terms} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {nextCursor !== null && !moreError && (
          <div ref={sentinelRef} className="py-3 text-center">
            <button type="button" onClick={loadMore} disabled={isLoadingMore} className="text-sm text-slack-link hover:underline">
              {t('messages:search.loadMore')}
            </button>
          </div>
        )}
        {moreError && (
          <div data-testid="search-more-error" className="py-3 text-center text-sm">
            <div className="text-slack-error">{t('messages:search.loadFailed')}</div>
            <button type="button" data-testid="search-retry" onClick={loadMore} className="mt-1 text-slack-link hover:underline">
              {t('messages:search.retry')}
            </button>
          </div>
        )}
        {truncated && nextCursor === null && (
          <div data-testid="search-truncated" className="py-3 text-center text-sm text-slack-hint">{t('messages:search.truncatedNotice')}</div>
        )}
      </div>
    </div>
  );
}

function ResultRow({ item, terms }: { item: Item; terms: string[] }) {
  const { t } = useTranslation('messages');

  if (item.type === 'person') {
    const p = item as SearchPersonResult;
    return (
      <div className="flex items-center gap-3">
        <Avatar src={p.avatar ?? undefined} alt={p.name} fallback={p.name} size="md" />
        <span className="text-[15px] font-bold text-slack-primary"><Highlighted text={p.name} terms={terms} /></span>
      </div>
    );
  }

  if (item.type === 'channel') {
    const c = item as SearchChannelResult;
    return (
      <div className="flex items-center gap-2">
        {c.isPrivate ? <Lock className="h-4 w-4 text-slack-secondary" /> : <Hash className="h-4 w-4 text-slack-secondary" />}
        <span className="text-[15px] font-bold text-slack-primary"><Highlighted text={c.name} terms={terms} /></span>
        {c.isMember && <span className="text-[12px] text-slack-secondary">{t('search.joined')}</span>}
        {c.archived && <span className="text-[12px] text-slack-secondary">{t('search.archivedChannel')}</span>}
        {c.topic && <span className="truncate text-[13px] text-slack-hint">{c.topic}</span>}
      </div>
    );
  }

  if (item.type === 'file') {
    const f = item as SearchFileResult;
    return (
      <div className="flex items-start gap-3">
        <FileText className="mt-0.5 h-5 w-5 flex-shrink-0 text-slack-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold text-slack-primary"><Highlighted text={f.filename} terms={terms} /></div>
          <div className="flex flex-wrap items-center gap-1 text-xs text-slack-hint">
            <span>{f.user.name}</span>
            <span>{formatDateTime(f.createdAt)}</span>
            <span>{formatFileSize(f.size)}</span>
            {f.channel && <span>{t('search.inChannel', { channel: f.channel.name })}</span>}
          </div>
        </div>
      </div>
    );
  }

  const r = item as SearchResult;
  return (
    <div className="flex items-start gap-3">
      <Avatar src={r.user.avatar ?? undefined} alt={r.user.name} fallback={r.user.name} size="md" className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1 text-xs text-slack-hint">
          <span className="font-medium text-slack-primary">{r.user.name}</span>
          <span>{formatDateTime(r.createdAt)}</span>
          {r.channel && <span>{t('search.inChannel', { channel: r.channel.name })}</span>}
          {!r.channel && (r.groupId ? <span>{t('search.groupMessage')}</span> : <span>{t('search.directMessage')}</span>)}
          {r.threadId && <span className="rounded bg-slack-hover px-1">{t('search.threadReply')}</span>}
        </div>
        <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-[15px] text-slack-primary">
          {highlightNode(renderMessageContent(r.content), terms)}
        </div>
      </div>
    </div>
  );
}
