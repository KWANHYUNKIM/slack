import { t } from '@/lib/i18n';
import { buildPermalink, type PermalinkTarget } from '@/lib/permalink';
import { useToastStore } from '@/stores/useToastStore';

/**
 * 메시지 퍼말링크를 클립보드에 복사하고 토스트로 알린다.
 * navigator.clipboard가 없거나(HTTP 로컬 등) 거부되면 폴백 없이 오류 토스트를 띄운다.
 */
export async function copyPermalink(target: PermalinkTarget): Promise<boolean> {
  const { show } = useToastStore.getState();
  try {
    await navigator.clipboard.writeText(buildPermalink(target));
    show(t('messages:permalink.copied'));
    return true;
  } catch {
    show(t('messages:permalink.copyFailed'), 'error');
    return false;
  }
}
