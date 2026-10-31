// 리마인더(09) 순수 로직 단위 테스트. 실행: npm run remind:test (Node 24의 타입 제거로 .ts를 바로 읽는다)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRemindCommand,
  parseLocalDateTime,
  parseRemind,
  reminderPresets,
  snoozeDate,
} from '../src/lib/remind.ts';

test('parses English units', () => {
  assert.deepEqual(parseRemind('/remind me 물 마시기 in 2 minutes'), { ok: true, text: '물 마시기', minutes: 2 });
  assert.deepEqual(parseRemind('/remind me call mom in 3 hours'), { ok: true, text: 'call mom', minutes: 180 });
  assert.deepEqual(parseRemind('/remind me standup in 1 day'), { ok: true, text: 'standup', minutes: 1440 });
  assert.deepEqual(parseRemind('/remind me x in 5m'), { ok: true, text: 'x', minutes: 5 });
});

test('parses Korean units in both forms', () => {
  assert.deepEqual(parseRemind('/remind me 물 마시기 in 2 분'), { ok: true, text: '물 마시기', minutes: 2 });
  assert.deepEqual(parseRemind('/remind me 회의 준비 in 1 시간'), { ok: true, text: '회의 준비', minutes: 60 });
  assert.deepEqual(parseRemind('/remind me 보고서 3 일 후'), { ok: true, text: '보고서', minutes: 4320 });
  assert.deepEqual(parseRemind('/remind me 약 먹기 30분 후'), { ok: true, text: '약 먹기', minutes: 30 });
});

test('keeps "in" inside the text when the unit clause is last', () => {
  assert.deepEqual(parseRemind('/remind me check in with team in 10 min'), { ok: true, text: 'check in with team', minutes: 10 });
});

test('rejects bad input', () => {
  assert.deepEqual(parseRemind('/remind'), { ok: false, error: 'syntax' });
  assert.deepEqual(parseRemind('/remind me'), { ok: false, error: 'syntax' });
  assert.deepEqual(parseRemind('/remind me in 5 minutes'), { ok: false, error: 'syntax' });
  assert.deepEqual(parseRemind('/remind me x in five minutes'), { ok: false, error: 'syntax' });
  assert.deepEqual(parseRemind('/remind me x in 5 fortnights'), { ok: false, error: 'syntax' });
  assert.deepEqual(parseRemind('/remind me x tomorrow'), { ok: false, error: 'syntax' });
  assert.deepEqual(parseRemind('/remind me x in 0 minutes'), { ok: false, error: 'tooShort' });
  assert.deepEqual(parseRemind('/remind me x in 400 days'), { ok: false, error: 'tooLong' });
  assert.deepEqual(parseRemind(`/remind me ${'a'.repeat(501)} in 5 minutes`), { ok: false, error: 'syntax' });
});

test('detects the command prefix', () => {
  assert.equal(isRemindCommand('/remind me x in 5 minutes'), true);
  assert.equal(isRemindCommand('  /remind'), true);
  assert.equal(isRemindCommand('/reminder'), false);
  assert.equal(isRemindCommand('hello /remind'), false);
});

test('presets are ordered, in the future, and tomorrow/next week are 9:00', () => {
  const now = new Date(2026, 9, 31, 14, 7); // 토요일
  const presets = reminderPresets(now);
  assert.deepEqual(presets.map((p) => p.key), ['in20', 'in1h', 'in3h', 'tomorrow', 'nextWeek']);
  assert.equal(presets[0].date.getTime() - now.getTime(), 20 * 60_000);
  assert.equal(presets[3].date.getDate(), 1);
  assert.equal(presets[3].date.getHours(), 9);
  assert.equal(presets[4].date.getDay(), 1); // 월요일
  assert.equal(presets[4].date.getDate(), 2);
  for (const p of presets) assert.ok(p.date > now);
  // 월요일에 부르면 다음 주 월요일(7일 뒤)
  const monday = reminderPresets(new Date(2026, 10, 2, 10, 0));
  assert.equal(monday[4].date.getDate(), 9);
});

test('snooze dates', () => {
  const now = new Date(2026, 9, 31, 14, 7);
  assert.equal(snoozeDate('m10', now).getTime() - now.getTime(), 10 * 60_000);
  assert.equal(snoozeDate('h1', now).getTime() - now.getTime(), 60 * 60_000);
  assert.equal(snoozeDate('tomorrow', now).getHours(), 9);
});

test('parses datetime-local values', () => {
  const d = parseLocalDateTime('2026-11-02T15:30');
  assert.ok(d);
  assert.equal(d.getHours(), 15);
  assert.equal(parseLocalDateTime(''), null);
  assert.equal(parseLocalDateTime('2026-13-45T99:99'), null);
});
