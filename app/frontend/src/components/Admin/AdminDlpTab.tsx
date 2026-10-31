import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2, Lock } from 'lucide-react';
import * as api from '@/lib/api';
import type { DlpRule } from '@/lib/api';
import { dlpRuleLabel } from '@/lib/apiErrors';
import { useAdminAction } from '@/hooks/useAdminAction';
import { ConfirmDialog } from './ConfirmDialog';

type Action = 'BLOCK' | 'WARN';

interface Draft {
  name: string;
  pattern: string;
  action: Action;
}

const EMPTY_DRAFT: Draft = { name: '', pattern: '', action: 'BLOCK' };
const FIELD_CLASS = 'rounded border border-slack-border px-3 py-1.5 text-sm focus:border-slack-focus focus:outline-none';

// 테스트 대상: 입력란의 패턴 또는 저장된 규칙 id
type TestSource = 'draft' | number;

export function AdminDlpTab() {
  const { t } = useTranslation('admin');
  const [rules, setRules] = useState<DlpRule[] | null>(null);
  const [limits, setLimits] = useState({ patternMax: 200, nameMax: 100, sampleMax: 2000 });
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<DlpRule | null>(null);
  const [testSource, setTestSource] = useState<TestSource>('draft');
  const [sample, setSample] = useState('');
  const [testResult, setTestResult] = useState<boolean | 'timedOut' | null>(null);
  const saveAction = useAdminAction('admin:dlp.saveError');
  const toggleAction = useAdminAction('admin:dlp.toggleError');
  const deleteAction = useAdminAction('admin:dlp.deleteError');
  const testAction = useAdminAction('admin:dlp.testError');

  const load = useCallback(async () => {
    const data = await api.adminListDlpRules();
    setRules(data.items);
    setLimits(data.limits);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .adminListDlpRules()
      .then((data) => {
        if (cancelled) return;
        setRules(data.items);
        setLimits(data.limits);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t('dlp.loadError'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (!rules) {
    return loadError ? <p role="alert" className="text-sm text-slack-error">{loadError}</p> : null;
  }

  const ruleName = (rule: DlpRule) => (rule.builtin ? dlpRuleLabel(rule.name) : rule.name);
  const canSave = draft.name.trim() !== '' && draft.pattern !== '' && !saveAction.busy;

  const resetForm = () => {
    setDraft(EMPTY_DRAFT);
    setEditingId(null);
    saveAction.reset();
  };

  const save = async () => {
    const ok = await saveAction.run(async () => {
      const body = { name: draft.name.trim(), pattern: draft.pattern, action: draft.action };
      if (editingId === null) await api.adminCreateDlpRule(body);
      else await api.adminUpdateDlpRule(editingId, body);
      await load();
    });
    if (ok) resetForm();
  };

  const startEdit = (rule: DlpRule) => {
    setEditingId(rule.id);
    setDraft({ name: rule.name, pattern: rule.pattern, action: rule.action });
    setTestSource('draft');
    setTestResult(null);
    saveAction.reset();
  };

  const toggle = (rule: DlpRule) => {
    void toggleAction.run(async () => {
      await api.adminUpdateDlpRule(rule.id, { enabled: !rule.enabled });
      await load();
    });
  };

  const changeAction = (rule: DlpRule, action: Action) => {
    void toggleAction.run(async () => {
      await api.adminUpdateDlpRule(rule.id, { action });
      await load();
    });
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const target = deleting;
    const ok = await deleteAction.run(async () => {
      await api.adminDeleteDlpRule(target.id);
      if (editingId === target.id) resetForm();
      if (testSource === target.id) {
        setTestSource('draft');
        setTestResult(null);
      }
      await load();
    });
    if (ok) setDeleting(null);
  };

  const runTest = () => {
    void testAction.run(async () => {
      const result = await api.adminTestDlpRule(testSource === 'draft' ? { pattern: draft.pattern, sample } : { ruleId: testSource, sample });
      setTestResult(result.timedOut ? 'timedOut' : result.matched);
    });
  };

  const testReady = sample !== '' && (testSource !== 'draft' || draft.pattern !== '') && !testAction.busy;

  return (
    <div>
      <p className="mb-4 text-sm text-slack-secondary">{t('dlp.description')}</p>

      {/* 추가·수정 폼 */}
      <div className="mb-6 rounded-lg border border-slack-border p-4">
        <h3 className="mb-3 text-sm font-semibold text-slack-primary">
          {editingId === null ? t('dlp.form.createHeading') : t('dlp.form.editHeading')}
        </h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label htmlFor="dlp-name" className="mb-1 block text-xs text-slack-secondary">{t('dlp.form.name')}</label>
            <input
              id="dlp-name"
              type="text"
              maxLength={limits.nameMax}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className={`w-48 ${FIELD_CLASS}`}
            />
          </div>
          <div className="flex-1 min-w-[16rem]">
            <label htmlFor="dlp-pattern" className="mb-1 block text-xs text-slack-secondary">{t('dlp.form.pattern')}</label>
            <input
              id="dlp-pattern"
              type="text"
              dir="ltr"
              spellCheck={false}
              maxLength={limits.patternMax}
              value={draft.pattern}
              onChange={(e) => {
                setDraft({ ...draft, pattern: e.target.value });
                setTestResult(null);
              }}
              placeholder={t('dlp.form.patternPlaceholder')}
              className={`w-full font-mono ${FIELD_CLASS}`}
            />
          </div>
          <div>
            <label htmlFor="dlp-action" className="mb-1 block text-xs text-slack-secondary">{t('dlp.form.action')}</label>
            <select
              id="dlp-action"
              value={draft.action}
              onChange={(e) => setDraft({ ...draft, action: e.target.value as Action })}
              className={FIELD_CLASS}
            >
              <option value="BLOCK">{t('dlp.action.BLOCK')}</option>
              <option value="WARN">{t('dlp.action.WARN')}</option>
            </select>
          </div>
          <button
            onClick={() => void save()}
            disabled={!canSave}
            className="rounded-lg bg-slack-btn px-4 py-1.5 text-sm font-medium text-white hover:bg-slack-btn-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {editingId === null ? t('dlp.form.add') : t('dlp.form.save')}
          </button>
          {editingId !== null && (
            <button
              onClick={resetForm}
              className="rounded-lg border border-slack-border px-4 py-1.5 text-sm font-medium text-slack-primary hover:bg-slack-hover"
            >
              {t('dlp.form.cancel')}
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-slack-hint">{t('dlp.form.hint', { max: limits.patternMax })}</p>
        {saveAction.error && <p role="alert" className="mt-2 text-sm text-slack-error">{saveAction.error}</p>}
      </div>

      {/* 패턴 테스트 */}
      <div className="mb-6 rounded-lg border border-slack-border p-4">
        <h3 className="mb-1 text-sm font-semibold text-slack-primary">{t('dlp.test.heading')}</h3>
        <p className="mb-3 text-xs text-slack-hint">{t('dlp.test.hint')}</p>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label htmlFor="dlp-test-source" className="mb-1 block text-xs text-slack-secondary">{t('dlp.test.source')}</label>
            <select
              id="dlp-test-source"
              value={String(testSource)}
              onChange={(e) => {
                setTestSource(e.target.value === 'draft' ? 'draft' : Number(e.target.value));
                setTestResult(null);
              }}
              className={FIELD_CLASS}
            >
              <option value="draft">{t('dlp.test.sourceDraft')}</option>
              {rules.map((r) => (
                <option key={r.id} value={r.id}>{ruleName(r)}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[16rem]">
            <label htmlFor="dlp-test-sample" className="mb-1 block text-xs text-slack-secondary">{t('dlp.test.sample')}</label>
            <input
              id="dlp-test-sample"
              type="text"
              maxLength={limits.sampleMax}
              value={sample}
              onChange={(e) => {
                setSample(e.target.value);
                setTestResult(null);
              }}
              className={`w-full ${FIELD_CLASS}`}
            />
          </div>
          <button
            onClick={runTest}
            disabled={!testReady}
            className="rounded-lg border border-slack-border px-4 py-1.5 text-sm font-medium text-slack-primary hover:bg-slack-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('dlp.test.run')}
          </button>
        </div>
        {testResult !== null && (
          <p role="status" className={`mt-2 text-sm ${testResult === true || testResult === 'timedOut' ? 'text-amber-700' : 'text-green-700'}`}>
            {testResult === 'timedOut' ? t('dlp.test.timedOut') : testResult ? t('dlp.test.matched') : t('dlp.test.notMatched')}
          </p>
        )}
        {testAction.error && <p role="alert" className="mt-2 text-sm text-slack-error">{testAction.error}</p>}
      </div>

      {/* 규칙 목록 */}
      {(toggleAction.error || deleteAction.error) && (
        <p role="alert" className="mb-2 text-sm text-slack-error">{toggleAction.error || deleteAction.error}</p>
      )}
      <div className="rounded-lg border border-slack-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-slack-border">
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('dlp.columns.name')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('dlp.columns.pattern')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('dlp.columns.action')}</th>
              <th className="text-start px-4 py-2.5 font-medium text-slack-secondary">{t('dlp.columns.enabled')}</th>
              <th className="text-end px-4 py-2.5 font-medium text-slack-secondary"></th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id} className="border-b border-slack-border last:border-b-0">
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-1.5 font-medium text-slack-primary">
                    {ruleName(rule)}
                    {rule.builtin && (
                      <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-slack-secondary">
                        <Lock className="h-3 w-3" />{t('dlp.builtinBadge')}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  {rule.builtin ? (
                    <span className="text-slack-hint">{t('dlp.builtinPattern')}</span>
                  ) : (
                    <code dir="ltr" className="break-all text-xs text-slack-secondary">{rule.pattern}</code>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {rule.builtin ? (
                    t(`dlp.action.${rule.action}`)
                  ) : (
                    <select
                      aria-label={t('dlp.columns.action')}
                      value={rule.action}
                      disabled={toggleAction.busy}
                      onChange={(e) => changeAction(rule, e.target.value as Action)}
                      className="rounded border border-slack-border px-2 py-1 text-sm focus:border-slack-focus focus:outline-none"
                    >
                      <option value="BLOCK">{t('dlp.action.BLOCK')}</option>
                      <option value="WARN">{t('dlp.action.WARN')}</option>
                    </select>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={rule.enabled}
                      disabled={toggleAction.busy}
                      onChange={() => toggle(rule)}
                      aria-label={t('dlp.toggleLabel', { name: ruleName(rule) })}
                    />
                    <span className="text-slack-secondary">{rule.enabled ? t('dlp.on') : t('dlp.off')}</span>
                  </label>
                </td>
                <td className="px-4 py-2.5 text-end whitespace-nowrap">
                  {!rule.builtin && (
                    <>
                      <button
                        onClick={() => startEdit(rule)}
                        title={t('dlp.edit')}
                        aria-label={t('dlp.editLabel', { name: rule.name })}
                        className="text-slack-hint hover:text-slack-primary align-middle"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setDeleting(rule)}
                        title={t('dlp.delete')}
                        aria-label={t('dlp.deleteLabel', { name: rule.name })}
                        className="ms-3 text-slack-hint hover:text-red-600 align-middle"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleting && (
        <ConfirmDialog
          title={t('dlp.confirmDelete.title')}
          message={t('dlp.confirmDelete.message', { name: deleting.name })}
          confirmLabel={t('dlp.delete')}
          error={deleteAction.error}
          busy={deleteAction.busy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            setDeleting(null);
            deleteAction.reset();
          }}
        />
      )}
    </div>
  );
}
