// 상태 기간 선택지를 만료 시각(ISO)으로 바꾼다. 서버는 현재 +1분 ~ +7일만 받는다.
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export type Duration = 'never' | 'm30' | 'h1' | 'h4' | 'today' | 'week';

/** 선택한 기간의 끝 시각(ISO). 서버는 현재 +1분 ~ +7일만 받는다. */
export function expiryFor(duration: Duration, now = new Date()): string | null {
  if (duration === 'never') return null;
  let end: number;
  if (duration === 'm30') end = now.getTime() + 30 * MINUTE;
  else if (duration === 'h1') end = now.getTime() + 60 * MINUTE;
  else if (duration === 'h4') end = now.getTime() + 4 * 60 * MINUTE;
  else if (duration === 'today') {
    const eod = new Date(now);
    eod.setHours(23, 59, 0, 0);
    end = eod.getTime();
  } else {
    // 이번 주: 이번 주 일요일 끝(로컬 시간대 기준)
    const eow = new Date(now);
    eow.setDate(eow.getDate() + ((7 - eow.getDay()) % 7));
    eow.setHours(23, 59, 0, 0);
    end = eow.getTime();
  }
  end = Math.max(end, now.getTime() + 2 * MINUTE);
  end = Math.min(end, now.getTime() + 7 * DAY - 5 * MINUTE);
  return new Date(end).toISOString();
}
