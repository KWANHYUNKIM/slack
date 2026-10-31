import { useTranslation } from 'react-i18next';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  /** 번역된 실패 문구. 있으면 대화상자 안에 보여 준다. */
  error?: string;
  /** 확인 처리 중이면 버튼을 막아 중복 제출을 막는다. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, error, busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        className="w-[400px] rounded-xl bg-white shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[17px] font-bold text-slack-primary mb-2">{title}</h3>
        <p className="text-[14px] text-slack-secondary mb-4">{message}</p>
        {error && (
          <p data-testid="confirm-dialog-error" role="alert" className="text-[13px] text-slack-error mb-4">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-[14px] font-medium text-slack-primary rounded-md border border-slack-border hover:bg-slack-hover disabled:opacity-50"
          >
            {t('actions.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 text-[14px] font-medium text-white rounded-md bg-red-600 hover:bg-red-700 disabled:opacity-50"
          >
            {confirmLabel ?? t('actions.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
