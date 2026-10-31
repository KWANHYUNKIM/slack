import { useTranslation } from 'react-i18next';
import { ArrowUp } from 'lucide-react';

interface NewMessagesBarProps {
  count: number;
  /** 로드 범위 밖의 안 읽음이 있어 숫자가 "이상"이다 */
  atLeast?: boolean;
  onJump: () => void;
  onMarkRead: () => void;
}

// 구분선이 화면 위로 벗어났을 때 상단에 붙는 바. 클릭하면 구분선으로 이동하고, 오른쪽 버튼은 읽음 처리한다.
export function NewMessagesBar({ count, atLeast, onJump, onMarkRead }: NewMessagesBarProps) {
  const { t } = useTranslation('messages');
  return (
    <div
      data-testid="new-messages-bar"
      className="absolute inset-x-3 top-1 z-10 flex items-center justify-between rounded-md bg-slack-btn px-3 py-1.5 text-[13px] text-white shadow"
    >
      <button onClick={onJump} className="flex items-center gap-1 font-semibold hover:underline">
        <ArrowUp className="h-3.5 w-3.5" />
        {atLeast ? t('unread.newMessagesBarAtLeast', { count }) : t('unread.newMessagesBar', { count })}
      </button>
      <button onClick={onMarkRead} className="hover:underline">
        {t('unread.markRead')}
      </button>
    </div>
  );
}
