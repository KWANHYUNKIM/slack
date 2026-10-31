// 언어·시간대 동기화의 순수 로직(node --test로 검사한다). 네트워크와 i18n에 의존하지 않는다.

export interface Prefs { locale: string | null; timeZone: string | null }

/**
 * 마지막으로 서버가 받아 준 요청. browser는 우리가 보낸 값, saved는 서버가 돌려준 정규 값이다.
 * 서버 정규 값이 브라우저 값과 달라도(Asia/Calcutta와 Asia/Kolkata) 같은 브라우저 값을 다시 보내지 않기 위해 기억한다.
 */
export interface Acked { browser: string; saved: string | null }
export interface AckedPrefs { locale?: Acked; timeZone?: Acked }

/** BCP-47 태그를 정규형으로 바꾼다(서버와 같은 Intl 규칙). 올바르지 않으면 null. */
export function normalizeLocale(tag: string | null | undefined): string | null {
  if (!tag) return null;
  try {
    const [canon] = Intl.getCanonicalLocales(tag);
    return canon && canon !== 'und' ? canon : null;
  } catch {
    return null;
  }
}

function needsSend(current: string | null, saved: string | null | undefined, acked: Acked | undefined): boolean {
  if (!current || current === saved) return false;
  // 같은 값을 이미 보냈고 서버 값도 그때 돌려받은 그대로면 다시 보내지 않는다
  if (acked && acked.browser === current && acked.saved === (saved ?? null)) return false;
  return true;
}

/** 서버에 보낼 변경분. 비어 있으면 보낼 것이 없다. */
export function diffUserPrefs(
  saved: { locale?: string | null; timeZone?: string | null },
  current: Prefs,
  acked: AckedPrefs = {},
): { locale?: string; timeZone?: string } {
  const patch: { locale?: string; timeZone?: string } = {};
  const locale = normalizeLocale(current.locale);
  if (needsSend(locale, saved.locale, acked.locale)) patch.locale = locale as string;
  if (needsSend(current.timeZone, saved.timeZone, acked.timeZone)) patch.timeZone = current.timeZone as string;
  return patch;
}

/** 서버가 값 자체를 거부한 응답(400 INVALID_LOCALE, INVALID_TIME_ZONE)인가. 이때만 같은 요청을 다시 보내지 않는다. */
export function isPermanentRejection(status: number | undefined, code: string | undefined): boolean {
  return status === 400 && (code === 'INVALID_LOCALE' || code === 'INVALID_TIME_ZONE');
}

/** 일시 실패 뒤 재시도까지 기다릴 시간(ms): 5초에서 시작해 두 배씩 늘리고 5분에서 멈춘다. */
export function retryDelayMs(failures: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, failures - 1), 5 * 60_000);
}
