// 법적 보존(E6) 화면에서 쓰는 상수와 순수 함수. 상한은 서버(legalHoldService, ediscoveryService)와 같게 둔다.
export const HOLD_NAME_MAX = 100;
export const HOLD_DESCRIPTION_MAX = 1000;
export const DISCOVERY_QUERY_MAX = 200;

/** date 입력값(YYYY-MM-DD, 브라우저 로컬 날짜)을 그 날의 시작 또는 끝 시각의 UTC ISO 문자열로 바꾼다. 비어 있으면 undefined. */
export function localDayBoundary(day: string, edge: 'start' | 'end'): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
