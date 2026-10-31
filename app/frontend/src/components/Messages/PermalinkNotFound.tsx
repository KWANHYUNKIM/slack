import { Link } from 'react-router-dom';
import { Link2Off } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** 없는 메시지, 삭제된 메시지, 볼 권한이 없는 메시지의 링크를 열었을 때 같은 화면을 보여 준다 */
export function PermalinkNotFound() {
  const { t } = useTranslation('messages');
  return (
    <div data-testid="permalink-not-found" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Link2Off className="h-10 w-10 text-slack-hint" aria-hidden="true" />
      <p className="max-w-sm text-[15px] text-slack-secondary">{t('permalink.notFound')}</p>
      <Link to="/" className="text-[14px] font-medium text-slack-link hover:underline">
        {t('permalink.goHome')}
      </Link>
    </div>
  );
}
