import i18n, { t } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { CHANNEL_NAME_MAX } from '@/lib/channelName';

const NAME_REASONS = new Set(['required', 'tooLong', 'invalidChars', 'mixedScripts']);

/**
 * API 오류를 번역된 문구로 바꾼다. 서버의 원문 메시지는 보여 주지 않고 code·reason만 본다.
 * 매핑이 없으면 호출한 쪽이 준 일반 오류 키(`ns:key`)를 쓴다.
 */
export function apiErrorMessage(err: unknown, fallbackKey: string, nameMax: number = CHANNEL_NAME_MAX): string {
  if (err instanceof ApiError) {
    if (err.code === 'CHANNEL_NAME_TAKEN') return t('channels:nameRules.taken');
    if (err.code === 'CHANNEL_NAME_INVALID') {
      const reason = err.reason && NAME_REASONS.has(err.reason) ? err.reason : 'invalidChars';
      return t(`channels:nameRules.${reason}`, { max: nameMax });
    }
    // 서버 code가 곧 번역 키(errors:api.<CODE>)다. 번역이 없는 code는 일반 오류 문구로 대체한다.
    if (err.code && /^[A-Z][A-Z0-9_]*$/.test(err.code)) {
      const key = `errors:api.${err.code}`;
      if (i18n.exists(key)) return t(key);
    }
  }
  return t(fallbackKey);
}
