import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as api from '@/lib/api';
import type { LegalHold, LegalHoldStatus } from '@/lib/api';
import { formatDateTime, DATE_TIME_MEDIUM } from '@/lib/i18n/format';
import { HOLD_NAME_MAX, HOLD_DESCRIPTION_MAX } from '@/lib/legalHolds';
import { useAdminAction } from '@/hooks/useAdminAction';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { LegalHoldDetailPanel } from './LegalHoldDetailPanel';

const STATUSES: LegalHoldStatus[] = ['active', 'released', 'all'];

// 법적 보존(E6): 보존 건 목록과 만들기. 고른 보존 건의 대상자 관리와 eDiscovery는 상세 패널에서 한다.
export function AdminLegalHoldsTab() {
  const { t } = useTranslation('admin');
  const [status, setStatus] = useState<LegalHoldStatus>('active');
  const [holds, setHolds] = useState<LegalHold[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const createAction = useAdminAction('admin:legalHolds.errors.create');

  useEffect(() => {
    let cancelled = false;
    api
      .adminListLegalHolds(status)
      .then((page) => {
        if (cancelled) return;
        setHolds(page.items);
        setNextCursor(page.nextCursor);
        setLoadError('');
      })
      .catch(() => {
        if (!cancelled) setLoadError(t('legalHolds.errors.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [status, t]);

  // 요청을 보낸 뒤 필터가 바뀌었으면 응답을 버린다(다른 필터의 목록에 섞이지 않게)
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const requested = status;
    try {
      const page = await api.adminListLegalHolds(requested, nextCursor);
      if (statusRef.current !== requested) return;
      setHolds((prev) => [...prev, ...page.items.filter((h) => !prev.some((p) => p.id === h.id))]);
      setNextCursor(page.nextCursor);
    } catch {
      if (statusRef.current === requested) setLoadError(t('legalHolds.errors.load'));
    }
  };

  // 상세에서 바뀐 값(이름, 대상자 수, 해제)을 목록에 반영한다. "진행 중" 목록에서 해제된 건은 뺀다(상세 패널은 그대로 열어 둔다).
  const handleChanged = useCallback((hold: LegalHold) => {
    setHolds((prev) =>
      statusRef.current === 'active' && hold.releasedAt
        ? prev.filter((h) => h.id !== hold.id)
        : prev.map((h) => (h.id === hold.id ? { ...h, ...hold } : h)),
    );
  }, []);

  const submitCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ok = await createAction.run(async () => {
      const hold = await api.adminCreateLegalHold({ name: trimmed, description: description.trim() || null });
      setHolds((prev) => (status === 'released' ? prev : [hold, ...prev]));
      setSelectedId(hold.id);
    });
    if (ok) {
      setCreating(false);
      setName('');
      setDescription('');
    }
  };

  return (
    <div>
      <p className="mb-4 text-sm text-slack-secondary">{t('legalHolds.description')}</p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        {/* 목록 */}
        <div>
          <div className="mb-3 flex items-center gap-2">
            <select
              aria-label={t('legalHolds.statusFilter')}
              value={status}
              onChange={(e) => setStatus(e.target.value as LegalHoldStatus)}
              className="h-9 flex-1 rounded-md border border-gray-300 bg-white px-2 text-sm"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>{t(`legalHolds.status.${s}`)}</option>
              ))}
            </select>
            <Button size="sm" onClick={() => setCreating((v) => !v)} aria-expanded={creating}>
              <Plus className="me-1 h-4 w-4" />{t('legalHolds.create.open')}
            </Button>
          </div>

          {creating && (
            <form
              className="mb-3 space-y-2 rounded-lg border border-slack-border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submitCreate();
              }}
            >
              <label className="block text-[12px] text-slack-hint">
                {t('legalHolds.fields.name')}
                <Input value={name} maxLength={HOLD_NAME_MAX} onChange={(e) => setName(e.target.value)} required />
              </label>
              <label className="block text-[12px] text-slack-hint">
                {t('legalHolds.fields.description')}
                <textarea
                  value={description}
                  maxLength={HOLD_DESCRIPTION_MAX}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <p className="text-[12px] text-slack-hint">{t('legalHolds.create.hint')}</p>
              {createAction.error && <p role="alert" className="text-sm text-slack-error">{createAction.error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setCreating(false)}>{t('legalHolds.cancel')}</Button>
                <Button type="submit" size="sm" disabled={!name.trim() || createAction.busy}>{t('legalHolds.create.submit')}</Button>
              </div>
            </form>
          )}

          {loadError && <ErrorBanner message={loadError} onDismiss={() => setLoadError('')} />}
          {holds.length === 0 && !loadError && <p className="py-6 text-center text-sm text-slack-hint">{t('legalHolds.empty')}</p>}
          <ul className="space-y-1">
            {holds.map((hold) => (
              <li key={hold.id}>
                <button
                  onClick={() => setSelectedId(hold.id)}
                  aria-current={selectedId === hold.id ? 'true' : undefined}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 text-start transition-colors',
                    selectedId === hold.id ? 'border-slack-btn bg-blue-50' : 'border-slack-border hover:bg-gray-50',
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-slack-primary">
                    <Lock className="h-3.5 w-3.5 flex-shrink-0 text-amber-700" />
                    <span className="truncate">{hold.name}</span>
                  </span>
                  <span className="mt-0.5 block text-[12px] text-slack-hint">
                    {t('legalHolds.custodianCount', { count: hold.custodianCount })}
                    {' · '}
                    {hold.releasedAt
                      ? t('legalHolds.releasedOn', { date: formatDateTime(hold.releasedAt, DATE_TIME_MEDIUM) })
                      : t('legalHolds.createdOn', { date: formatDateTime(hold.createdAt, DATE_TIME_MEDIUM) })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <Button variant="outline" size="sm" className="mt-2 w-full" onClick={() => void loadMore()}>
              {t('legalHolds.loadMore')}
            </Button>
          )}
        </div>

        {/* 상세 */}
        <div className="min-w-0">
          {selectedId ? (
            <LegalHoldDetailPanel key={selectedId} holdId={selectedId} onChanged={handleChanged} />
          ) : (
            <p className="py-10 text-center text-sm text-slack-hint">{t('legalHolds.selectHint')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
