import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Trash2, Undo2, AlarmClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/i18n/format';
import { snoozeDate } from '@/lib/remind';
import { renderMessageContent } from '@/lib/renderMessageContent';
import { useReminderStore } from '@/stores/useReminderStore';
import type { ApiReminder } from '@/lib/api';
import { cn } from '@/lib/utils';

const SNOOZES = [
  { kind: 'm10', labelKey: 'reminder.snooze.m10' },
  { kind: 'h1', labelKey: 'reminder.snooze.h1' },
  { kind: 'tomorrow', labelKey: 'reminder.snooze.tomorrow' },
] as const;

const STATUSES = ['pending', 'done'] as const;

/** 나중에 > 리마인더 탭. 예정 순 목록, 완료·삭제·스누즈. */
export function RemindersTab() {
  const { t } = useTranslation('messages');
  const navigate = useNavigate();
  const tab = useReminderStore((s) => s.tab);
  const items = useReminderStore((s) => s.items);
  const isLoading = useReminderStore((s) => s.isLoading);
  const loadError = useReminderStore((s) => s.loadError);

  useEffect(() => {
    void useReminderStore.getState().setTab('pending');
  }, []);

  const open = (r: ApiReminder) => {
    if (!r.message) return;
    const state = { scrollToMessageId: r.message.threadId ?? r.message.id };
    if (r.dmGroupId) navigate(`/g/${r.dmGroupId}`, { state });
    else if (r.dmUserId) navigate(`/d/${r.dmUserId}`, { state });
    else if (r.channelId) navigate(`/c/${r.channelId}`, { state });
  };

  return (
    <div data-testid="reminders-tab">
      <div role="tablist" className="mb-3 flex gap-1">
        {STATUSES.map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            data-testid={`reminders-status-${value}`}
            onClick={() => void useReminderStore.getState().setTab(value)}
            className={cn(
              'rounded-md px-3 py-1 text-[13px]',
              tab === value ? 'bg-slack-active-tab font-medium text-slack-primary' : 'text-slack-secondary hover:bg-slack-hover',
            )}
          >
            {t(`reminder.status.${value}`)}
          </button>
        ))}
      </div>

      {isLoading && items.length === 0 ? (
        <div className="text-center text-sm text-slack-hint">{t('common:status.loading')}</div>
      ) : loadError ? (
        <div className="text-center text-sm text-slack-error">{t('reminder.loadFailed')}</div>
      ) : items.length === 0 ? (
        <div data-testid="reminders-empty" className="py-8 text-center text-sm text-slack-hint">
          {t(tab === 'pending' ? 'reminder.empty' : 'reminder.emptyDone')}
        </div>
      ) : (
        <ul className="space-y-1">
          {items.map((r) => {
            const overdue = r.completedAt === null && r.firedAt !== null;
            return (
              <li
                key={r.id}
                data-testid="reminder-item"
                className="group flex items-start gap-3 rounded-lg p-3 hover:bg-slack-hover"
              >
                <AlarmClock className={cn('mt-1 h-4 w-4 flex-shrink-0', overdue ? 'text-slack-error' : 'text-slack-secondary')} />
                <button
                  onClick={() => open(r)}
                  disabled={!r.message}
                  className="min-w-0 flex-1 text-start disabled:cursor-default"
                >
                  <div className="text-[13px] font-medium text-slack-primary">
                    {r.completedAt
                      ? t('reminder.completedAt', { time: formatDateTime(r.completedAt) })
                      : t(overdue ? 'reminder.firedAt' : 'reminder.dueAt', { time: formatDateTime(r.remindAt) })}
                  </div>
                  {r.text && <div className="break-words text-[14px] text-slack-primary">{r.text}</div>}
                  {r.message ? (
                    <div className="line-clamp-2 break-words text-[13px] text-slack-secondary">
                      <span className="font-medium">{r.message.user.name}: </span>
                      {renderMessageContent(r.message.excerpt)}
                    </div>
                  ) : (
                    r.messageDeleted && <div className="text-[13px] italic text-slack-hint">{t('reminder.messageDeleted')}</div>
                  )}
                  {r.channel && <div className="text-[12px] text-slack-hint">#{r.channel.name}</div>}
                </button>
                <div className="flex flex-shrink-0 items-center gap-1">
                  {r.completedAt === null ? (
                    <>
                      {SNOOZES.map((s) => (
                        <button
                          key={s.kind}
                          data-testid={`reminder-snooze-${s.kind}`}
                          onClick={() => void useReminderStore.getState().snooze(r.id, snoozeDate(s.kind))}
                          className="hidden rounded px-1.5 py-0.5 text-[11px] text-slack-secondary hover:bg-slack-border-light group-hover:block"
                        >
                          {t(s.labelKey)}
                        </button>
                      ))}
                      <button
                        data-testid="reminder-complete"
                        aria-label={t('reminder.complete')}
                        title={t('reminder.complete')}
                        onClick={() => void useReminderStore.getState().complete(r.id)}
                        className="flex h-8 w-8 items-center justify-center rounded hover:bg-slack-border-light"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </>
                  ) : (
                    <button
                      data-testid="reminder-reopen"
                      aria-label={t('reminder.reopen')}
                      title={t('reminder.reopen')}
                      onClick={() => void useReminderStore.getState().complete(r.id, false)}
                      className="flex h-8 w-8 items-center justify-center rounded hover:bg-slack-border-light"
                    >
                      <Undo2 className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    data-testid="reminder-delete"
                    aria-label={t('reminder.delete')}
                    title={t('reminder.delete')}
                    onClick={() => void useReminderStore.getState().remove(r.id)}
                    className="flex h-8 w-8 items-center justify-center rounded hover:bg-slack-border-light"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
