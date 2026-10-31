import { buildPermalinkPath } from './permalink.ts';

// 리마인더 순수 로직: `/remind` 구문 파싱과 시간 프리셋. UI와 분리해 Node에서 단위 테스트한다(npm run remind:test).

export type RemindError = 'syntax' | 'tooShort' | 'tooLong';
export type RemindParse = { ok: true; text: string; minutes: number } | { ok: false; error: RemindError };

export const MAX_REMIND_MINUTES = 365 * 24 * 60;
export const MAX_REMIND_TEXT = 500;

const UNIT_MINUTES: Record<string, number> = {
  m: 1, min: 1, mins: 1, minute: 1, minutes: 1, 분: 1,
  h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, 시간: 60,
  d: 1440, day: 1440, days: 1440, 일: 1440,
};

const UNIT_PATTERN = '[a-zA-Z]+|분|시간|일';

// `/remind me <내용> in <숫자> <단위>` 또는 `/remind me <내용> <숫자> <단위> 후`(한국어)
const ENGLISH_FORM = new RegExp(`^/remind\\s+me\\s+(.+?)\\s+in\\s+(\\d{1,7})\\s*(${UNIT_PATTERN})$`, 'u');
const KOREAN_FORM = new RegExp(`^/remind\\s+me\\s+(.+?)\\s+(\\d{1,7})\\s*(분|시간|일)\\s*후$`, 'u');

/** 입력이 `/remind` 명령으로 시작하는지(구문 오류여도 true) */
export function isRemindCommand(input: string): boolean {
  return /^\/remind(\s|$)/u.test(input.trim());
}

/** 자연어 날짜("내일 오후 3시")는 범위 밖이다. 숫자 + 분/시간/일만 받는다. */
export function parseRemind(input: string): RemindParse {
  const trimmed = input.trim();
  const m = ENGLISH_FORM.exec(trimmed) ?? KOREAN_FORM.exec(trimmed);
  if (!m) return { ok: false, error: 'syntax' };
  const text = m[1].trim();
  const factor = UNIT_MINUTES[m[3].toLowerCase()];
  if (!text || text.length > MAX_REMIND_TEXT || !factor) return { ok: false, error: 'syntax' };
  const minutes = Number(m[2]) * factor;
  if (minutes < 1) return { ok: false, error: 'tooShort' };
  if (minutes > MAX_REMIND_MINUTES) return { ok: false, error: 'tooLong' };
  return { ok: true, text, minutes };
}

export type ReminderPresetKey = 'in20' | 'in1h' | 'in3h' | 'tomorrow' | 'nextWeek';

/** 메시지 리마인더 프리셋. 내일은 다음 날 오전 9시, 다음 주는 다음 월요일 오전 9시. */
export function reminderPresets(now = new Date()): { key: ReminderPresetKey; date: Date }[] {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  const nextWeek = new Date(now);
  const daysUntilMonday = ((8 - nextWeek.getDay()) % 7) || 7;
  nextWeek.setDate(nextWeek.getDate() + daysUntilMonday);
  nextWeek.setHours(9, 0, 0, 0);

  return [
    { key: 'in20', date: new Date(now.getTime() + 20 * 60_000) },
    { key: 'in1h', date: new Date(now.getTime() + 60 * 60_000) },
    { key: 'in3h', date: new Date(now.getTime() + 3 * 60 * 60_000) },
    { key: 'tomorrow', date: tomorrow },
    { key: 'nextWeek', date: nextWeek },
  ];
}

/** 스누즈 프리셋(완료된 알림을 다시 울리게) */
export function snoozeDate(kind: 'm10' | 'h1' | 'tomorrow', now = new Date()): Date {
  if (kind === 'm10') return new Date(now.getTime() + 10 * 60_000);
  if (kind === 'h1') return new Date(now.getTime() + 60 * 60_000);
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** `<input type="datetime-local">` 값("2026-10-31T15:30", 로컬 시각)을 Date로. 잘못된 값이면 null. */
export function parseLocalDateTime(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const REMINDERS_LIST_PATH = '/later?tab=reminders';

export interface ReminderOpenInput {
  channelId: number | null;
  dmGroupId?: number | null;
  /** 1:1 DM의 상대 userId */
  dmUserId?: number | null;
  /** 대상 메시지(채널 메시지 id 또는 DM id). 없거나 지워졌으면 null */
  target: { id: number; threadId: number | null } | null;
}

/**
 * 리마인더(또는 REMINDER 활동)를 눌렀을 때 갈 경로. 대상이 있으면 07 퍼말링크로 메시지까지 가고,
 * 대상이 없거나 어느 대화인지 알 수 없으면 리마인더 목록으로 보낸다. 스레드 답글은 부모 + ?reply=.
 */
export function reminderOpenPath(i: ReminderOpenInput): string {
  if (!i.target) return REMINDERS_LIST_PATH;
  const messageId = i.target.threadId ?? i.target.id;
  const replyId = i.target.threadId ? i.target.id : undefined;
  if (i.dmGroupId) return buildPermalinkPath({ kind: 'group', conversationId: i.dmGroupId, messageId, replyId });
  if (i.dmUserId) return buildPermalinkPath({ kind: 'dm', conversationId: i.dmUserId, messageId, replyId });
  if (i.channelId) return buildPermalinkPath({ kind: 'channel', conversationId: i.channelId, messageId, replyId });
  return REMINDERS_LIST_PATH;
}
