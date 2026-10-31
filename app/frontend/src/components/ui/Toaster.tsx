import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/useToastStore';

/** 화면 아래 가운데에 잠깐 뜨는 알림. AppLayout에 한 번만 둔다. */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[10000] flex flex-col items-center gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid="toast"
          className={cn(
            'rounded-lg px-4 py-2 text-[13px] text-white shadow-lg',
            toast.kind === 'error' ? 'bg-slack-error' : 'bg-gray-900',
          )}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
