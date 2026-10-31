import { forwardRef } from 'react';
import { useTranslation } from 'react-i18next';

// 첫 안 읽음 메시지 바로 앞에 그리는 가로선과 라벨
export const UnreadDivider = forwardRef<HTMLDivElement>(function UnreadDivider(_props, ref) {
  const { t } = useTranslation('messages');
  return (
    <div ref={ref} role="separator" data-testid="unread-divider" className="relative my-[10px] flex items-center scroll-mt-2">
      <div className="flex-1 border-t border-red-500" />
      <span className="flex-shrink-0 rounded-full bg-red-500 px-3 py-[1px] text-[12px] font-semibold text-white">
        {t('unread.divider')}
      </span>
    </div>
  );
});
