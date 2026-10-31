import i18n, { t } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { CHANNEL_NAME_MAX } from '@/lib/channelName';
import { selectErrorKey } from '@/lib/apiErrorCodes';

const BUILTIN_DLP_KEYS: Record<string, string> = {
  'Credit card number': 'credit_card',
  'Korean resident registration number': 'kr_rrn',
  'AWS access key': 'aws_access_key',
  'Private key': 'private_key',
};

/** 규칙 이름을 화면용으로. 내장 규칙은 번역된 이름, 사용자 정의 규칙은 관리자가 적은 이름 그대로. */
export function dlpRuleLabel(name: string): string {
  const key = BUILTIN_DLP_KEYS[name];
  return key ? t(`admin:dlp.builtin.${key}`) : name;
}

/** 데이터 유출 방지 규칙이 막았을 때 입력창 아래에 보일 문구 */
export function dlpBlockedMessage(rule: string | undefined): string {
  return t('errors:api.DLP_BLOCKED', { rule: dlpRuleLabel(rule ?? '') });
}

const NAME_REASONS = new Set(['required', 'tooLong', 'invalidChars', 'tooManyMarks', 'mixedScripts']);

/**
 * API 오류를 번역된 문구로 바꾼다. 서버의 원문 메시지는 보여 주지 않고 code·reason만 본다.
 * 매핑이 없으면 호출한 쪽이 준 일반 오류 키(`ns:key`)를 쓴다.
 */
export function apiErrorMessage(err: unknown, fallbackKey: string, nameMax: number = CHANNEL_NAME_MAX): string {
  if (err instanceof ApiError) {
    if (err.code === 'DLP_BLOCKED') return dlpBlockedMessage(err.rule);
    if (err.code === 'DLP_PATTERN_INVALID') return t(`admin:dlp.patternProblem.${err.reason ?? 'invalid'}`, { defaultValue: t('admin:dlp.patternProblem.invalid') });
    if (err.code === 'CHANNEL_NAME_TAKEN') return t('channels:nameRules.taken');
    if (err.code === 'CHANNEL_NAME_INVALID') {
      const reason = err.reason && NAME_REASONS.has(err.reason) ? err.reason : 'invalidChars';
      return t(`channels:nameRules.${reason}`, { max: nameMax });
    }
    // 구체 code만 errors:api.<CODE>로 번역한다. 상태별 기본 code(500 등)와 번역이 없는 code는 호출한 쪽의 문구를 쓴다.
    return t(selectErrorKey(err.code, fallbackKey, (key) => i18n.exists(key)));
  }
  return t(fallbackKey);
}
