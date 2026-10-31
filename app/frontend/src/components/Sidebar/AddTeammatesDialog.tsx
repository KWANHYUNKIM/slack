import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { useChannelActions } from '@/hooks/useChannelActions';
import { useAuthStore } from '@/stores/useAuthStore';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import type { AuthUser } from '@/lib/api';
import { MAX_GROUP_OTHERS } from '@/lib/groupDM';

interface AddTeammatesDialogProps {
  open: boolean;
  onClose: () => void;
  /** 아무도 체크하지 않은 상태에서 이름을 누르면 바로 1:1 DM을 연다(pick 모드에서는 쓰지 않는다) */
  onSelectUser?: (user: AuthUser) => void;
  /** 체크한 사람들로 대화를 시작하거나 멤버로 추가한다 */
  onConfirm?: (users: AuthUser[]) => void | Promise<void>;
  /** 'pick': 이름을 눌러도 체크만 한다(그룹 멤버 추가) */
  mode?: 'start' | 'pick';
  /** 목록에서 뺄 사용자(이미 멤버인 사람) */
  excludeIds?: number[];
  maxSelected?: number;
  title?: string;
  confirmLabel?: string;
  error?: string | null;
}

export function AddTeammatesDialog({
  open,
  onClose,
  onSelectUser,
  onConfirm,
  mode = 'start',
  excludeIds,
  maxSelected = MAX_GROUP_OTHERS,
  title,
  confirmLabel,
  error,
}: AddTeammatesDialogProps) {
  const { t } = useTranslation('sidebar');
  const [teammateSearch, setTeammateSearch] = useState('');
  const [selected, setSelected] = useState<AuthUser[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { teammates, searchTeammates } = useChannelActions();
  const currentUser = useAuthStore((s) => s.user);

  // Clear the search box and selection when dialog opens
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setTeammateSearch('');
      setSelected([]);
    }
  }

  // Load all teammates when dialog opens
  useEffect(() => {
    if (open) searchTeammates('');
  }, [open, searchTeammates]);

  if (!open) return null;

  const visible = excludeIds ? teammates.filter((u) => !excludeIds.includes(u.id)) : teammates;
  const isSelected = (u: AuthUser) => selected.some((s) => s.id === u.id);
  const toggle = (u: AuthUser) => {
    setSelected((prev) => {
      if (prev.some((s) => s.id === u.id)) return prev.filter((s) => s.id !== u.id);
      if (prev.length >= maxSelected) return prev;
      return [...prev, u];
    });
  };
  // 본인은 그룹에 넣을 수 없다(1:1 셀프 DM은 이름 클릭으로 연다)
  const canCheck = (u: AuthUser) => !!onConfirm && u.id !== currentUser?.id;

  const handleRowClick = (u: AuthUser) => {
    if (mode === 'pick' || selected.length > 0) {
      if (canCheck(u)) toggle(u);
      return;
    }
    onSelectUser?.(u);
  };

  const handleConfirm = async () => {
    if (!onConfirm || selected.length === 0) return;
    setIsSubmitting(true);
    try {
      await onConfirm(selected);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[480px] rounded-lg bg-white p-6 shadow-xl">
        <h2 className="text-[22px] font-bold text-slack-primary mb-2">{title ?? t('teammates.title')}</h2>
        <p className="text-[14px] text-slack-hint mb-4">
          {mode === 'pick' ? t('teammates.pickSubtitle', { max: maxSelected }) : t('teammates.subtitle')}
        </p>
        <input
          data-testid="teammate-search"
          type="text"
          value={teammateSearch}
          onChange={(e) => {
            setTeammateSearch(e.target.value);
            searchTeammates(e.target.value);
          }}
          placeholder={t('teammates.searchPlaceholder')}
          autoFocus
          className="w-full rounded border border-slack-input-border px-3 py-2 text-[15px] text-slack-primary outline-none focus:border-slack-link focus:ring-1 focus:ring-slack-link mb-3"
        />
        {visible.length === 0 ? (
          <p className="text-center text-slack-hint py-4">{t('teammates.noUsers')}</p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto space-y-1">
            {visible.map((u) => (
              <div key={u.id} className="flex items-center gap-1">
                {canCheck(u) && (
                  <button
                    type="button"
                    data-testid={`teammate-check-${u.id}`}
                    role="checkbox"
                    aria-checked={isSelected(u)}
                    aria-label={t('teammates.select', { name: u.name })}
                    onClick={() => toggle(u)}
                    className={cn(
                      'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border',
                      isSelected(u) ? 'border-slack-link bg-slack-link text-white' : 'border-slack-input-border bg-white',
                    )}
                  >
                    {isSelected(u) && <Check className="h-3.5 w-3.5" />}
                  </button>
                )}
                <button
                  data-testid={`teammate-row-${u.id}`}
                  onClick={() => handleRowClick(u)}
                  className="flex w-full items-center gap-3 rounded px-3 py-2 hover:bg-slack-hover text-start"
                >
                  <Avatar
                    src={u.avatar ?? undefined}
                    alt={u.name}
                    fallback={u.name}
                    size="md"
                  />
                  <div>
                    <p className="text-[14px] font-medium text-slack-primary">
                      {u.name}{u.id === currentUser?.id && <span className="text-slack-hint font-normal"> {t('you')}</span>}
                    </p>
                  </div>
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="mt-3 text-[13px] text-slack-error">{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          {onConfirm && selected.length > 0 && (
            <span className="me-auto text-[13px] text-slack-hint">
              {t('teammates.selectedCount', { count: selected.length, max: maxSelected })}
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('teammates.close')}
          </Button>
          {onConfirm && (
            <Button
              data-testid="teammate-confirm"
              onClick={handleConfirm}
              disabled={selected.length === 0 || isSubmitting}
            >
              {confirmLabel ?? (selected.length > 1 ? t('teammates.startGroup') : t('teammates.start'))}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
