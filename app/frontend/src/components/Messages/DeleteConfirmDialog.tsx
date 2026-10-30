interface DeleteConfirmDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmDialog({ onCancel, onConfirm }: DeleteConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onCancel}>
      <div
        data-testid="delete-confirm-dialog"
        className="w-[400px] rounded-xl bg-white shadow-xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[17px] font-bold text-slack-primary mb-2">Delete message</h3>
        <p className="text-[14px] text-slack-secondary mb-4">
          Are you sure you want to delete this message? This can&apos;t be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            data-testid="delete-cancel-btn"
            onClick={onCancel}
            className="px-4 py-2 text-[14px] font-medium text-slack-primary rounded-md border border-slack-border hover:bg-slack-hover"
          >
            Cancel
          </button>
          <button
            data-testid="delete-confirm-btn"
            onClick={onConfirm}
            className="px-4 py-2 text-[14px] font-medium text-white rounded-md bg-red-600 hover:bg-red-700"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
