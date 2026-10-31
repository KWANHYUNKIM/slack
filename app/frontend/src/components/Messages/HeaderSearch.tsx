import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatTime } from '@/lib/i18n/format';
import { searchMessages, type SearchResult } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { renderMessageContent } from '@/lib/renderMessageContent';
import { useClickOutside } from '@/hooks/useClickOutside';

/** 드롭다운 미리보기에 보여 줄 최대 결과 수 */
const PREVIEW_LIMIT = 5;

interface HeaderSearchProps {
  testIdPrefix?: string;
}

export function HeaderSearch({ testIdPrefix = '' }: HeaderSearchProps) {
  const { t } = useTranslation('messages');
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeResults = useCallback(() => setShowResults(false), []);
  useClickOutside(searchRef, closeResults, showResults);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  const handleSearch = async (query?: string) => {
    const q = (query ?? searchQuery).trim();
    if (q.length < 2) {
      setShowResults(false);
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    setShowResults(true);
    try {
      const data = await searchMessages(q, undefined, PREVIEW_LIMIT);
      setSearchResults(data.results);
    } catch {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (value.trim().length < 2) {
      setShowResults(false);
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(() => {
      handleSearch(value);
    }, 300);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      const q = searchQuery.trim();
      if (!q) return;
      // Enter는 전체 검색 페이지로 보낸다. 드롭다운은 입력 중 미리보기(상위 5건)다.
      navigate(`/search?${new URLSearchParams({ q })}`);
      setSearchQuery('');
      setShowResults(false);
      setSearchResults([]);
    } else if (e.key === 'Escape') {
      setSearchQuery('');
      setShowResults(false);
      setSearchResults([]);
    }
  };

  const handleResultClick = (result: SearchResult) => {
    if (result.channel) {
      navigate(`/c/${result.channel.id}`, { state: { scrollToMessageId: result.id } });
    } else if (result.groupId) {
      navigate(`/g/${result.groupId}`, { state: { scrollToMessageId: result.id } });
    } else if (result.participant) {
      navigate(`/d/${result.participant.id}`, { state: { scrollToMessageId: result.id } });
    }
    setSearchQuery('');
    setShowResults(false);
    setSearchResults([]);
  };

  const prefix = testIdPrefix ? `${testIdPrefix}-` : '';

  return (
    <div className="relative" ref={searchRef}>
      <Search className="absolute start-2 top-1/2 h-[14px] w-[14px] -translate-y-1/2 text-slack-secondary" />
      <input
        type="text"
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        value={searchQuery}
        onChange={handleSearchChange}
        onKeyDown={handleSearchKeyDown}
        className="h-[26px] w-[140px] rounded-md border border-slack-border bg-white ps-7 pe-2 text-[13px] placeholder:text-slack-secondary focus:outline-none focus:border-slack-link focus:w-[240px] transition-all"
      />
      {showResults && (
        <div data-testid={`${prefix}search-results-dropdown`} className="absolute end-0 top-8 z-50 w-[360px] max-h-[400px] overflow-y-auto rounded-lg border border-slack-border bg-white shadow-lg">
          {isSearching ? (
            <div className="p-4 text-center text-sm text-slack-hint">{t('search.searching')}</div>
          ) : searchResults.length === 0 ? (
            <div className="p-4 text-center text-sm text-slack-hint">{t('search.noResults')}</div>
          ) : (
            <div>
              <div className="px-3 py-2 text-xs font-medium text-slack-hint border-b">
                {t('search.resultCount', { count: searchResults.length })}
              </div>
              {searchResults.map((result) => (
                <button
                  key={`${result.type}-${result.id}`}
                  data-testid="search-result-item"
                  onClick={() => handleResultClick(result)}
                  className="w-full text-start px-3 py-2 hover:bg-slack-hover border-b border-slack-border-light last:border-b-0"
                >
                  <div className="flex items-start gap-2">
                    <Avatar
                      src={result.user.avatar ?? undefined}
                      alt={result.user.name}
                      fallback={result.user.name}
                      size="sm"
                      className="flex-shrink-0 mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 text-xs text-slack-hint">
                        <span className="font-medium text-slack-primary">{result.user.name}</span>
                        <span data-testid="search-result-timestamp" className="text-slack-disabled">
                          {formatTime(result.createdAt)}
                        </span>
                        {result.channel && (
                          <span>{t('search.inChannel', { channel: result.channel.name })}</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-sm text-slack-primary line-clamp-2">{renderMessageContent(result.content)}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
