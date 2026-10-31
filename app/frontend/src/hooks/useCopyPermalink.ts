import { t } from '@/lib/i18n';
import { buildPermalink, type PermalinkTarget } from '@/lib/permalink';
import { useToastStore } from '@/stores/useToastStore';

const MANUAL_COPY_TOAST_MS = 15000;

/** navigator.clipboard를 못 쓰는 환경(HTTP 로컬 등)을 위한 폴백: 화면 밖 textarea를 선택해 복사한다 */
function execCommandCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

/**
 * 메시지 퍼말링크를 클립보드에 복사하고 토스트로 알린다.
 * 1) navigator.clipboard  2) textarea+execCommand  3) 둘 다 안 되면 URL을 보여 줘 직접 복사하게 한다.
 */
export async function copyPermalink(target: PermalinkTarget): Promise<boolean> {
  const { show } = useToastStore.getState();
  const url = buildPermalink(target);
  try {
    await navigator.clipboard.writeText(url);
    show(t('messages:permalink.copied'));
    return true;
  } catch {
    // 아래 폴백으로 진행한다
  }
  if (execCommandCopy(url)) {
    show(t('messages:permalink.copied'));
    return true;
  }
  show(t('messages:permalink.copyManually', { url }), 'error', MANUAL_COPY_TOAST_MS);
  return false;
}
