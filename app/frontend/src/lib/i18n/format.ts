import i18n from 'i18next';

/** 현재 로캘 (초기화 전에는 브라우저 기본값) */
function currentLocale(): string {
  return i18n.language || navigator.language || 'en';
}

function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/** 날짜: 기본은 "2026년 10월 31일" / "October 31, 2026" 형태 */
export function formatDate(
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' },
): string {
  return new Intl.DateTimeFormat(currentLocale(), options).format(toDate(value));
}

/** 시간: 로캘의 12/24시간 규칙을 따른다 ("오후 3:05" / "3:05 PM") */
export function formatTime(
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' },
): string {
  return new Intl.DateTimeFormat(currentLocale(), options).format(toDate(value));
}

/** 짧은 시간("3:05"): 오전/오후 표시 없이 시:분만. 연속 메시지 거터(36px)용 */
export function formatTimeShort(value: Date | string | number): string {
  const parts = new Intl.DateTimeFormat(currentLocale(), {
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(toDate(value));
  return parts
    .filter((p) => p.type !== 'dayPeriod')
    .map((p) => p.value)
    .join('')
    .trim();
}

/** 날짜와 시간을 함께 */
export function formatDateTime(
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  },
): string {
  return new Intl.DateTimeFormat(currentLocale(), options).format(toDate(value));
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/** 상대 시간: "3분 전", "내일" */
export function formatRelative(value: Date | string | number, now: Date = new Date()): string {
  const diffSeconds = Math.round((toDate(value).getTime() - now.getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(diffSeconds) >= seconds || unit === 'second') {
      // 0 방향으로 버린다: 90초 전은 "1분 전" (기존 date-fns식 경과 시간 동작)
      return formatter.format(Math.trunc(diffSeconds / seconds), unit);
    }
  }
  return formatter.format(0, 'second');
}

/** 숫자: 로캘의 자릿수 구분 규칙을 따른다 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLocale(), options).format(value);
}

/** 목록: "A, B 및 C" / "A, B, and C" */
export function formatList(
  items: string[],
  options: Intl.ListFormatOptions = { style: 'long', type: 'conjunction' },
): string {
  return new Intl.ListFormat(currentLocale(), options).format(items);
}

const collators = new Map<string, Intl.Collator>();

/** 언어별로 캐시한 Collator (정렬할 때마다 새로 만들지 않는다) */
export function getCollator(locale: string = currentLocale()): Intl.Collator {
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale);
    collators.set(locale, collator);
  }
  return collator;
}

/** 같은 날인지 (로컬 시간대 기준) */
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 파일 크기: "1.5 KB" / "1.5KB" (로캘 단위 표기) */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return formatNumber(bytes, { style: 'unit', unit: 'byte', unitDisplay: 'narrow' });
  }
  const useMegabyte = bytes >= 1024 * 1024;
  return formatNumber(useMegabyte ? bytes / (1024 * 1024) : bytes / 1024, {
    style: 'unit',
    unit: useMegabyte ? 'megabyte' : 'kilobyte',
    unitDisplay: 'narrow',
    maximumFractionDigits: 1,
  });
}

/** 자주 쓰는 Intl 옵션 (JSX 안에 리터럴을 쓰지 않도록 상수로 둔다) */
export const DATE_MEDIUM: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };
export const DATE_TIME_MEDIUM: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
export const DATE_TIME_FULL: Intl.DateTimeFormatOptions = { dateStyle: 'full', timeStyle: 'medium' };
export const DATE_WEEKDAY: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };
