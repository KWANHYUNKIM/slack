// 서버 오류 code를 번역 키로 고르는 순수 로직(i18n 라이브러리에 의존하지 않아 node --test로 검사한다).

/**
 * 서버가 구체 code를 정하지 못했을 때 상태 코드별로 붙이는 기본 code.
 * "구체 code 없음"과 같게 취급한다. 이런 code가 오면 호출한 쪽이 준 문구(fallbackKey)를 우선한다.
 * (예: 채널 만들기가 500으로 실패하면 "서버 오류"보다 "채널을 만들지 못했습니다"가 낫다)
 */
export const GENERIC_CODES: ReadonlySet<string> = new Set([
  'BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INTERNAL_ERROR',
]);

/**
 * code에 해당하는 번역 키(`errors:api.<CODE>`)를 돌려준다. 기본 code이거나 번역이 없으면 fallbackKey다.
 * exists는 번역 키가 있는지 확인하는 함수(i18n.exists)다.
 */
export function selectErrorKey(code: string | undefined, fallbackKey: string, exists: (key: string) => boolean): string {
  if (!code || GENERIC_CODES.has(code) || !/^[A-Z][A-Z0-9_]*$/.test(code)) return fallbackKey;
  const key = `errors:api.${code}`;
  return exists(key) ? key : fallbackKey;
}
