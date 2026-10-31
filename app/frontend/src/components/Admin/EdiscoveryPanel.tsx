import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Search, Hash, Lock, MessageSquare, Paperclip } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as api from '@/lib/api';
import type { DiscoveryFilter, DiscoveryKind, DiscoveryPage, DiscoveryRecord } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { formatDateTime, formatFileSize, DATE_TIME_MEDIUM } from '@/lib/i18n/format';
import { DISCOVERY_QUERY_MAX, localDayBoundary } from '@/lib/legalHolds';
import { useAdminAction } from '@/hooks/useAdminAction';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBanner } from '@/components/ui/ErrorBanner';

const KINDS: DiscoveryKind[] = ['channel', 'dm', 'file'];

/** 화면에 보이는 결과. 어떤 종류·필터로 받은 것인지 함께 둔다(더 보기는 같은 종류·필터일 때만 잇는다). */
interface Results {
  kind: DiscoveryKind;
  filter: DiscoveryFilter;
  items: DiscoveryRecord[];
  nextCursor: number | null;
}

// 대상자 데이터 검색과 JSONL 내보내기. 결과에는 비공개 채널과 DM 내용이 들어 있으므로 관리자 화면에서만 보인다.
// 검색어 강조나 서식 없이 원문 텍스트로만 보여 준다(React가 이스케이프한다).
//
// 요청 순서: 탭을 빠르게 바꾸거나 검색을 다시 누르면 응답이 뒤바뀌어 올 수 있다. 요청마다 세대 번호를 붙이고 이전 요청은 끊으며,
// 최신 요청의 응답만 반영한다. 선택된 탭(kind)과 적용된 필터(applied)도 응답을 반영할 때 확정한다.
export function EdiscoveryPanel({ holdId }: { holdId: number }) {
  const { t } = useTranslation('admin');
  const [form, setForm] = useState({ q: '', from: '', to: '' });
  const [results, setResults] = useState<Results | null>(null);
  const [counts, setCounts] = useState<DiscoveryPage['counts']>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const exportAction = useAdminAction('admin:legalHolds.errors.export');
  const generation = useRef(0);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => () => inflight.current?.abort(), []);

  const current: DiscoveryFilter = {
    holdId,
    q: form.q.trim() || undefined,
    from: localDayBoundary(form.from, 'start'),
    to: localDayBoundary(form.to, 'end'),
  };
  const applied = results?.filter ?? null;
  const formMatchesApplied = applied !== null && api.sameDiscoveryFilter(current, applied);

  const run = async (filter: DiscoveryFilter, kind: DiscoveryKind, cursor?: number | null) => {
    const gen = ++generation.current;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const sameFilter = applied !== null && api.sameDiscoveryFilter(filter, applied);
    setSearching(true);
    setSearchError('');
    try {
      const res = await api.adminDiscoverySearch(filter, kind, {
        cursor,
        // 필터가 같고 이미 건수가 있으면 다시 세지 않는다(서버도 같은 필터면 생략한다)
        wantCounts: !cursor && (!sameFilter || !counts),
        signal: controller.signal,
      });
      if (gen !== generation.current) return;
      setResults((prev) =>
        cursor && prev && prev.kind === kind && api.sameDiscoveryFilter(prev.filter, filter)
          ? { ...prev, items: [...prev.items, ...res.items], nextCursor: res.nextCursor }
          : { kind, filter, items: res.items, nextCursor: res.nextCursor },
      );
      if (res.counts) setCounts(res.counts);
      else if (!sameFilter) setCounts(undefined);
    } catch (err) {
      if (gen !== generation.current || controller.signal.aborted) return;
      setSearchError(apiErrorMessage(err, 'admin:legalHolds.errors.search'));
    } finally {
      if (gen === generation.current) setSearching(false);
    }
  };

  const handleSearch = () => void run(current, results?.kind ?? 'channel');

  const switchKind = (next: DiscoveryKind) => {
    if (applied) void run(applied, next);
  };

  // 토큰이 든 주소로 이동해 브라우저가 파일을 바로 받게 한다(감사 로그 내보내기와 같은 방식).
  // 화면에 보이는 마지막 검색과 같은 조건으로만 내보낸다.
  const download = () =>
    exportAction.run(async () => {
      if (!applied || !formMatchesApplied) return;
      const url = await api.adminDiscoveryExportUrl(applied);
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

  return (
    <section className="rounded-lg border border-slack-border p-4">
      <h4 className="text-sm font-semibold text-slack-primary">{t('legalHolds.discovery.heading')}</h4>
      <p className="mb-3 text-[12px] text-slack-hint">{t('legalHolds.discovery.hint')}</p>
      <form
        className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          handleSearch();
        }}
      >
        <label className="text-[12px] text-slack-hint">
          {t('legalHolds.discovery.query')}
          <Input value={form.q} maxLength={DISCOVERY_QUERY_MAX} onChange={(e) => setForm({ ...form, q: e.target.value })} />
        </label>
        <label className="text-[12px] text-slack-hint">
          {t('legalHolds.discovery.from')}
          <Input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </label>
        <label className="text-[12px] text-slack-hint">
          {t('legalHolds.discovery.to')}
          <Input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
        </label>
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={searching}>
            <Search className="me-1 h-4 w-4" />{t('legalHolds.discovery.search')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ms-auto"
            disabled={exportAction.busy || !formMatchesApplied}
            aria-describedby="ediscovery-export-hint"
            onClick={() => void download()}
          >
            <Download className="me-1 h-4 w-4" />{t('legalHolds.discovery.export')}
          </Button>
        </div>
      </form>
      <p id="ediscovery-export-hint" className="mt-1 text-[11px] text-slack-hint">
        {formMatchesApplied ? t('legalHolds.discovery.exportHint') : t('legalHolds.discovery.searchFirst')}
      </p>

      {searchError && <ErrorBanner message={searchError} onDismiss={() => setSearchError('')} />}
      {exportAction.error && <ErrorBanner message={exportAction.error} onDismiss={exportAction.reset} />}

      {results && (
        <>
          <div role="tablist" className="mt-4 flex border-b border-slack-border">
            {KINDS.map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={results.kind === k}
                onClick={() => switchKind(k)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
                  results.kind === k ? 'border-slack-btn text-slack-btn' : 'border-transparent text-slack-secondary hover:text-slack-primary',
                )}
              >
                {t(`legalHolds.discovery.kinds.${k}`)}
                {counts && <span className="ms-1 text-[12px] text-slack-hint">{counts[k]}</span>}
              </button>
            ))}
          </div>
          {results.items.length === 0 && <p className="py-6 text-center text-sm text-slack-hint">{t('legalHolds.discovery.empty')}</p>}
          <ul className="divide-y divide-slack-border" aria-busy={searching}>
            {results.items.map((r) => <ResultRow key={`${r.kind}-${r.id}`} record={r} />)}
          </ul>
          {results.nextCursor && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2 w-full"
              disabled={searching}
              onClick={() => void run(results.filter, results.kind, results.nextCursor)}
            >
              {t('legalHolds.loadMore')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}


function ResultRow({ record }: { record: DiscoveryRecord }) {
  const { t } = useTranslation('admin');
  const when = formatDateTime(record.createdAt, DATE_TIME_MEDIUM);

  if (record.kind === 'file') {
    return (
      <li className="py-2 text-sm">
        <span className="flex items-center gap-1.5 font-medium text-slack-primary">
          <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-slack-hint" />
          <span className="truncate">{record.originalName}</span>
          {record.attachedToDeleted && <Badge label={t('legalHolds.discovery.deleted')} />}
        </span>
        <span className="block text-[12px] text-slack-hint">
          {record.uploader.name} · {formatFileSize(record.size)} · {record.mimetype} · {when}
          {record.channel && ` · #${record.channel.name}`}
        </span>
      </li>
    );
  }

  const where =
    record.kind === 'channel' ? (
      <span className="inline-flex items-center gap-0.5">
        {record.channel.isPrivate ? <Lock className="h-3 w-3" /> : <Hash className="h-3 w-3" />}
        {record.channel.name}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1">
        <MessageSquare className="h-3 w-3" />
        {record.group
          ? record.group.name || t('legalHolds.discovery.groupDm', { id: record.group.id })
          : t('legalHolds.discovery.directMessage', { from: record.from.name, to: record.to?.name ?? '' })}
      </span>
    );
  const author = record.kind === 'channel' ? record.author.name : record.from.name;

  return (
    <li className="py-2 text-sm">
      <span className="flex flex-wrap items-center gap-2 text-[12px] text-slack-hint">
        <span className="font-semibold text-slack-primary">{author}</span>
        {where}
        <span>{when}</span>
        {record.threadId !== null && <Badge label={t('legalHolds.discovery.reply')} />}
        {record.editedAt && <Badge label={t('legalHolds.discovery.edited')} />}
        {record.deleted && <Badge label={t('legalHolds.discovery.deleted')} tone="danger" />}
      </span>
      <p className={cn('mt-0.5 whitespace-pre-wrap break-words text-slack-primary', record.deleted && 'text-slack-secondary')}>{record.content}</p>
      {record.files.length > 0 && (
        <span className="mt-0.5 block text-[12px] text-slack-hint">
          <Paperclip className="me-1 inline h-3 w-3" />
          {record.files.map((f) => f.originalName).join(', ')}
        </span>
      )}
    </li>
  );
}

function Badge({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'danger' }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', tone === 'danger' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-slack-secondary')}>
      {label}
    </span>
  );
}
