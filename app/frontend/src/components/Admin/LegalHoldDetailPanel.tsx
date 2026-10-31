import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, X, UserPlus } from 'lucide-react';
import * as api from '@/lib/api';
import type { LegalHold, LegalHoldDetail } from '@/lib/api';
import { formatDateTime, DATE_TIME_MEDIUM } from '@/lib/i18n/format';
import { HOLD_NAME_MAX, HOLD_DESCRIPTION_MAX } from '@/lib/legalHolds';
import { useAdminStore } from '@/stores/useAdminStore';
import { useAdminAction } from '@/hooks/useAdminAction';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { ConfirmDialog } from './ConfirmDialog';
import { EdiscoveryPanel } from './EdiscoveryPanel';

interface Props {
  holdId: number;
  onChanged: (hold: LegalHold) => void;
}

// 보존 건 하나: 이름·설명 수정, 대상자 추가·제거, 해제, 그리고 eDiscovery 검색·내보내기
export function LegalHoldDetailPanel({ holdId, onChanged }: Props) {
  const { t } = useTranslation('admin');
  const users = useAdminStore((s) => s.users);
  const [hold, setHold] = useState<LegalHoldDetail | null>(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [addUserId, setAddUserId] = useState('');
  const [confirmRelease, setConfirmRelease] = useState(false);
  const editAction = useAdminAction('admin:legalHolds.errors.update');
  const custodianAction = useAdminAction('admin:legalHolds.errors.custodians');
  const releaseAction = useAdminAction('admin:legalHolds.errors.release');

  useEffect(() => {
    let cancelled = false;
    api
      .adminGetLegalHold(holdId)
      .then((h) => {
        if (!cancelled) setHold(h);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t('legalHolds.errors.load'));
      });
    return () => {
      cancelled = true;
    };
  }, [holdId, t]);

  if (!hold) return loadError ? <ErrorBanner message={loadError} onDismiss={() => setLoadError('')} /> : null;

  const released = hold.releasedAt !== null;
  const custodianIds = new Set(hold.custodians.map((c) => c.id));
  const candidates = users.filter((u) => !custodianIds.has(u.id));

  const apply = (next: LegalHoldDetail) => {
    setHold(next);
    onChanged(next);
  };

  const startEdit = () => {
    setName(hold.name);
    setDescription(hold.description ?? '');
    editAction.reset();
    setEditing(true);
  };

  const saveEdit = async () => {
    const ok = await editAction.run(async () => {
      apply(await api.adminUpdateLegalHold(hold.id, { name: name.trim(), description: description.trim() || null }));
    });
    if (ok) setEditing(false);
  };

  const addCustodian = async () => {
    const userId = Number(addUserId);
    if (!userId) return;
    const ok = await custodianAction.run(async () => apply(await api.adminAddLegalHoldCustodians(hold.id, [userId])));
    if (ok) setAddUserId('');
  };

  const removeCustodian = (userId: number) =>
    custodianAction.run(async () => apply(await api.adminRemoveLegalHoldCustodian(hold.id, userId)));

  const release = async () => {
    const ok = await releaseAction.run(async () => apply(await api.adminReleaseLegalHold(hold.id)));
    if (ok) setConfirmRelease(false);
  };

  return (
    <div className="space-y-5">
      {/* 머리: 이름·설명·상태 */}
      <section className="rounded-lg border border-slack-border p-4">
        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
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
            {editAction.error && <p role="alert" className="text-sm text-slack-error">{editAction.error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>{t('legalHolds.cancel')}</Button>
              <Button type="submit" size="sm" disabled={!name.trim() || editAction.busy}>{t('legalHolds.save')}</Button>
            </div>
          </form>
        ) : (
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold text-slack-primary">
                <span className="break-words">{hold.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${released ? 'bg-gray-100 text-slack-secondary' : 'bg-amber-100 text-amber-700'}`}>
                  {released ? t('legalHolds.status.released') : t('legalHolds.status.active')}
                </span>
              </h3>
              {hold.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slack-secondary">{hold.description}</p>}
              <p className="mt-2 text-[12px] text-slack-hint">
                {t('legalHolds.createdBy', { name: hold.creator?.name ?? t('legalHolds.unknownUser'), date: formatDateTime(hold.createdAt, DATE_TIME_MEDIUM) })}
                {hold.releasedAt && (
                  <>
                    <br />
                    {t('legalHolds.releasedBy', { name: hold.releaser?.name ?? t('legalHolds.unknownUser'), date: formatDateTime(hold.releasedAt, DATE_TIME_MEDIUM) })}
                  </>
                )}
              </p>
            </div>
            {!released && (
              <div className="flex flex-shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={startEdit} aria-label={t('legalHolds.edit')}>
                  <Pencil className="me-1 h-3.5 w-3.5" />{t('legalHolds.edit')}
                </Button>
                <Button variant="destructive" size="sm" onClick={() => setConfirmRelease(true)}>{t('legalHolds.release.open')}</Button>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 대상자 */}
      <section>
        <h4 className="mb-2 text-sm font-semibold text-slack-primary">
          {t('legalHolds.custodians.heading')} <span className="font-normal text-slack-hint">({hold.custodians.length})</span>
        </h4>
        {!released && (
          <div className="mb-2 flex items-center gap-2">
            <select
              aria-label={t('legalHolds.custodians.pick')}
              value={addUserId}
              onChange={(e) => setAddUserId(e.target.value)}
              className="h-9 min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 text-sm"
            >
              <option value="">{t('legalHolds.custodians.pick')}</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
              ))}
            </select>
            <Button size="sm" onClick={() => void addCustodian()} disabled={!addUserId || custodianAction.busy}>
              <UserPlus className="me-1 h-4 w-4" />{t('legalHolds.custodians.add')}
            </Button>
          </div>
        )}
        {custodianAction.error && <ErrorBanner message={custodianAction.error} onDismiss={custodianAction.reset} />}
        {hold.custodians.length === 0 ? (
          <p className="py-3 text-sm text-slack-hint">{t('legalHolds.custodians.empty')}</p>
        ) : (
          <ul className="divide-y divide-slack-border rounded-lg border border-slack-border">
            {hold.custodians.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                <Avatar src={c.avatar ?? undefined} alt={c.name} fallback={c.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slack-primary">
                    {c.name}
                    {c.deactivatedAt && <span className="ms-1.5 text-[11px] font-normal text-slack-hint">{t('legalHolds.custodians.deactivated')}</span>}
                  </span>
                  <span className="block truncate text-[12px] text-slack-hint">{c.email}</span>
                </div>
                {!released && (
                  <button
                    onClick={() => void removeCustodian(c.id)}
                    disabled={custodianAction.busy}
                    aria-label={t('legalHolds.custodians.remove', { name: c.name })}
                    title={t('legalHolds.custodians.remove', { name: c.name })}
                    className="rounded p-1 text-slack-hint hover:bg-gray-100 hover:text-slack-primary disabled:opacity-50"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <EdiscoveryPanel holdId={hold.id} />

      {confirmRelease && (
        <ConfirmDialog
          title={t('legalHolds.release.title')}
          message={t('legalHolds.release.message', { name: hold.name })}
          confirmLabel={t('legalHolds.release.confirm')}
          error={releaseAction.error}
          busy={releaseAction.busy}
          onConfirm={() => void release()}
          onCancel={() => {
            setConfirmRelease(false);
            releaseAction.reset();
          }}
        />
      )}
    </div>
  );
}
