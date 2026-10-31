import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Hash, Lock, RotateCcw } from 'lucide-react';
import * as api from '@/lib/api';
import type { RetentionChannel, RetentionPolicy } from '@/lib/api';
import { useAdminAction } from '@/hooks/useAdminAction';
import { ConfirmDialog } from './ConfirmDialog';

type Mode = 'inherit' | 'forever' | 'days';
interface Draft {
  mode: Mode;
  days: string;
}

// 서버 값을 편집용 초안으로 바꾼다. 워크스페이스 설정에는 inherit이 없다.
function toDraft(value: { days: number | null } | null): Draft {
  if (value === null) return { mode: 'inherit', days: '' };
  return value.days === null ? { mode: 'forever', days: '' } : { mode: 'days', days: String(value.days) };
}

function parseDays(draft: Draft, min: number, max: number): number | null | undefined {
  if (draft.mode === 'days') {
    const n = Number(draft.days);
    return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
  }
  return null; // inherit·forever는 days 없음
}

const sameDraft = (a: Draft, b: Draft) => a.mode === b.mode && (a.mode !== 'days' || a.days === b.days);

interface EditorProps {
  draft: Draft;
  modes: Mode[];
  min: number;
  max: number;
  idPrefix: string;
  onChange: (next: Draft) => void;
}

function PolicyEditor({ draft, modes, min, max, idPrefix, onChange }: EditorProps) {
  const { t } = useTranslation('admin');
  const invalid = draft.mode === 'days' && parseDays(draft, min, max) === undefined;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        aria-label={t('retention.channels.columns.policy')}
        value={draft.mode}
        onChange={(e) => onChange({ ...draft, mode: e.target.value as Mode })}
        className="rounded border border-slack-border px-2 py-1.5 text-sm focus:border-slack-focus focus:outline-none"
      >
        {modes.map((m) => (
          <option key={m} value={m}>{t(`retention.mode.${m}`)}</option>
        ))}
      </select>
      {draft.mode === 'days' && (
        <input
          id={`${idPrefix}-days`}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft.days}
          aria-label={t('retention.daysLabel')}
          aria-invalid={invalid ? true : undefined}
          title={t('retention.daysHint', { min, max })}
          onChange={(e) => onChange({ ...draft, days: e.target.value })}
          className="w-24 rounded border border-slack-border px-2 py-1.5 text-sm focus:border-slack-focus focus:outline-none aria-[invalid=true]:border-slack-error"
        />
      )}
    </div>
  );
}

// 확인 대화상자에서 적용할 변경 하나
type Pending = { kind: 'workspace'; days: number } | { kind: 'channel'; channelId: number; days: number | null; reset?: boolean };

export function AdminRetentionTab() {
  const { t } = useTranslation('admin');
  const [policy, setPolicy] = useState<RetentionPolicy | null>(null);
  const [loadError, setLoadError] = useState('');
  const [wsDraft, setWsDraft] = useState<Draft>({ mode: 'forever', days: '' });
  const [chDrafts, setChDrafts] = useState<Record<number, Draft>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [saved, setSaved] = useState(false);
  const saveAction = useAdminAction('admin:retention.saveError');
  const resetAction = useAdminAction('admin:retention.resetError');
  const dialogAction = useAdminAction('admin:retention.saveError');

  const apply = useCallback((p: RetentionPolicy) => {
    setPolicy(p);
    setWsDraft(toDraft(p.workspace));
    setChDrafts(Object.fromEntries(p.channels.map((c) => [c.id, toDraft(c.override)])));
  }, []);

  // 저장 뒤 서버 값을 다시 읽는다. 실패하면 호출한 동작의 오류로 보인다.
  const load = useCallback(async () => {
    apply(await api.adminGetRetention());
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    api
      .adminGetRetention()
      .then((p) => {
        if (!cancelled) apply(p);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t('retention.loadError'));
      });
    return () => {
      cancelled = true;
    };
  }, [apply, t]);

  if (!policy) {
    return loadError ? <p role="alert" className="text-sm text-slack-error">{loadError}</p> : null;
  }

  const { minDays, maxDays } = policy;
  const wsServer = toDraft(policy.workspace);
  const wsDays = parseDays(wsDraft, minDays, maxDays);
  const wsDirty = !sameDraft(wsDraft, wsServer);

  const flash = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // 저장한다. 삭제가 일어날 수 있는 변경(결과가 N일)은 먼저 확인을 받는다.
  const commit = async (p: Pending | { kind: 'workspace'; days: null }) => {
    if (p.kind === 'workspace') await api.adminSetWorkspaceRetention(p.days);
    else await api.adminSetChannelRetention(p.channelId, p.days);
    await load();
    flash();
  };

  const saveWorkspace = () => {
    if (wsDays === undefined) return;
    if (wsDays === null) void saveAction.run(() => commit({ kind: 'workspace', days: null }));
    else setPending({ kind: 'workspace', days: wsDays });
  };

  const saveChannel = (channel: RetentionChannel) => {
    const draft = chDrafts[channel.id];
    const days = parseDays(draft, minDays, maxDays);
    if (days === undefined) return;
    if (draft.mode === 'inherit') {
      requestReset(channel.id);
      return;
    }
    if (days === null) void saveAction.run(() => commit({ kind: 'channel', channelId: channel.id, days: null }));
    else setPending({ kind: 'channel', channelId: channel.id, days });
  };

  // 덮어쓰기를 지우면 워크스페이스 기본이 적용된다. 기본이 N일이면 확인을 받는다.
  const requestReset = (channelId: number) => {
    if (policy.workspace.days === null) void resetAction.run(() => commitReset(channelId));
    else setPending({ kind: 'channel', channelId, days: policy.workspace.days, reset: true });
  };

  const commitReset = async (channelId: number) => {
    await api.adminClearChannelRetention(channelId);
    await load();
    flash();
  };

  const confirmPending = async () => {
    if (!pending) return;
    const target = pending;
    const ok = await dialogAction.run(async () => {
      if (target.kind === 'channel' && target.reset) await commitReset(target.channelId);
      else await commit(target);
    });
    if (ok) setPending(null);
  };

  const cancelPending = () => {
    setPending(null);
    dialogAction.reset();
  };

  const effectiveLabel = (days: number | null) =>
    days === null ? t('retention.effective.forever') : t('retention.effective.days', { count: days });

  return (
    <div>
      <p className="mb-4 text-sm text-slack-secondary">{t('retention.description')}</p>

      {/* 워크스페이스 기본 */}
      <div className="mb-6 rounded-lg border border-slack-border p-4">
        <h3 className="text-sm font-semibold text-slack-primary">{t('retention.workspace.heading')}</h3>
        <p className="mb-3 text-xs text-slack-hint">{t('retention.workspace.hint')}</p>
        <div className="flex items-center gap-3 flex-wrap">
          <PolicyEditor draft={wsDraft} modes={['forever', 'days']} min={minDays} max={maxDays} idPrefix="retention-ws" onChange={setWsDraft} />
          <button
            onClick={saveWorkspace}
            disabled={!wsDirty || wsDays === undefined || saveAction.busy}
            className="rounded-lg bg-slack-btn px-4 py-1.5 text-sm font-medium text-white hover:bg-slack-btn-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('retention.save')}
          </button>
          {saved && <span role="status" className="text-sm text-green-700">{t('retention.saved')}</span>}
        </div>
        {saveAction.error && <p role="alert" className="mt-2 text-sm text-slack-error">{saveAction.error}</p>}
      </div>

      {/* 채널별 덮어쓰기 */}
      <h3 className="mb-2 text-sm font-semibold text-slack-primary">{t('retention.channels.heading')}</h3>
      {resetAction.error && <p role="alert" className="mb-2 text-sm text-slack-error">{resetAction.error}</p>}
      <div className="rounded-lg border border-slack-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-slack-border">
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('retention.channels.columns.channel')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('retention.channels.columns.policy')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('retention.channels.columns.effective')}</th>
              <th className="text-end px-4 py-2.5 font-medium text-slack-secondary"></th>
            </tr>
          </thead>
          <tbody>
            {policy.channels.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-slack-hint">{t('retention.channels.empty')}</td></tr>
            )}
            {policy.channels.map((channel) => {
              const draft = chDrafts[channel.id] ?? toDraft(channel.override);
              const dirty = !sameDraft(draft, toDraft(channel.override));
              const days = parseDays(draft, minDays, maxDays);
              return (
                <tr key={channel.id} className="border-b border-slack-border last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5 font-medium text-slack-primary">
                      <Hash className="h-3.5 w-3.5 text-slack-hint flex-shrink-0" />
                      {channel.name}
                      {channel.legalHold && (
                        <span className="ms-1 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                          <Lock className="h-3 w-3" />{t('retention.channels.legalHold')}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <PolicyEditor
                      draft={draft}
                      modes={['inherit', 'forever', 'days']}
                      min={minDays}
                      max={maxDays}
                      idPrefix={`retention-ch-${channel.id}`}
                      onChange={(next) => setChDrafts((prev) => ({ ...prev, [channel.id]: next }))}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-slack-secondary">{effectiveLabel(channel.effectiveDays)}</td>
                  <td className="px-4 py-2.5 text-end whitespace-nowrap">
                    <button
                      onClick={() => saveChannel(channel)}
                      disabled={!dirty || days === undefined || saveAction.busy || resetAction.busy}
                      className="rounded-lg bg-slack-btn px-3 py-1 text-sm font-medium text-white hover:bg-slack-btn-hover disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {t('retention.save')}
                    </button>
                    {channel.override !== null && (
                      <button
                        onClick={() => requestReset(channel.id)}
                        disabled={resetAction.busy}
                        title={t('retention.channels.reset')}
                        aria-label={t('retention.channels.reset')}
                        className="ms-2 text-slack-hint hover:text-slack-primary disabled:opacity-50 align-middle"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pending && pending.days !== null && (
        <ConfirmDialog
          title={t('retention.confirm.title')}
          message={t('retention.confirm.message', { count: pending.days })}
          confirmLabel={t('retention.confirm.confirm')}
          error={dialogAction.error}
          busy={dialogAction.busy}
          onConfirm={() => void confirmPending()}
          onCancel={cancelPending}
        />
      )}
    </div>
  );
}
