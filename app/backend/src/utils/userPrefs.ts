import { z } from 'zod';
import { ERR } from './errorCodes.js';

// User.locale(BCP-47)과 User.timeZone(IANA) 검증. 프런트가 보낸 값을 Intl로 확인한 정규형만 저장한다.

export const LOCALE_MAX = 35;
export const TIME_ZONE_MAX = 64;

/** BCP-47 태그를 정규형으로 돌려준다(ko-kr -> ko-KR). 올바르지 않으면 null. */
export function canonicalLocale(input: string): string | null {
  if (input.length === 0 || input.length > LOCALE_MAX || !/^[A-Za-z0-9-]+$/.test(input)) return null;
  try {
    const [canon] = Intl.getCanonicalLocales(input);
    return canon && canon !== 'und' ? canon : null;
  } catch {
    return null;
  }
}

/** IANA 시간대 이름을 정규형으로 돌려준다(asia/seoul -> Asia/Seoul). UTC 오프셋 표기(+09:00)와 알 수 없는 이름은 null. */
export function canonicalTimeZone(input: string): string | null {
  if (input.length === 0 || input.length > TIME_ZONE_MAX || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(input)) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: input }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// null은 설정 해제(다시 브라우저/서버 기본값을 쓴다)
export const localeSchema = z.string().refine((v) => canonicalLocale(v) !== null, { message: ERR.INVALID_LOCALE })
  .transform((v) => canonicalLocale(v) as string);

export const timeZoneSchema = z.string().refine((v) => canonicalTimeZone(v) !== null, { message: ERR.INVALID_TIME_ZONE })
  .transform((v) => canonicalTimeZone(v) as string);
