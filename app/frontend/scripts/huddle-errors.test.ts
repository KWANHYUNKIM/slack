import test from 'node:test';
import assert from 'node:assert/strict';
import { huddleErrorKey, HUDDLE_GENERIC_ERROR_KEY } from '../src/lib/huddleErrors.ts';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 서버(app/backend/src/websocket/huddles.ts)가 보내는 영어 원문은 모두 번역 키로 바뀌어야 한다
const SERVER_MESSAGES = [
  'Rate limit exceeded',
  'Invalid invite payload',
  'Cannot invite yourself',
  'Leave your current huddle first',
  'User not found',
  'Invalid accept payload',
  'Invite not found or expired',
  'They are already in another huddle',
  'They went offline',
];

test('서버 원문은 원문이 아닌 huddle 번역 키가 된다', () => {
  for (const message of SERVER_MESSAGES) {
    const key = huddleErrorKey(message);
    assert.match(key, /^huddle:errors\./, message);
  }
});

test('이미 번역 키인 값은 그대로 둔다', () => {
  assert.equal(huddleErrorKey('huddle:errors.micDenied'), 'huddle:errors.micDenied');
  assert.equal(huddleErrorKey('huddle:errors.busy'), 'huddle:errors.busy');
});

test('모르는 원문은 일반 오류 키로 바꾼다(영어 원문을 화면에 내보내지 않는다)', () => {
  assert.equal(huddleErrorKey('some unexpected server text'), HUDDLE_GENERIC_ERROR_KEY);
});

test('같은 의미의 서버 문구는 같은 키로 모인다', () => {
  assert.equal(huddleErrorKey('Leave your current huddle first'), 'huddle:errors.leaveFirst');
  assert.equal(huddleErrorKey('They are already in another huddle'), 'huddle:errors.busy');
});

test('서버 원문마다 en·ko 번역 값이 있다(ko 누락 0)', () => {
  const en = JSON.parse(readFileSync(join(here, '../src/locales/en/huddle.json'), 'utf8')).errors;
  const ko = JSON.parse(readFileSync(join(here, '../src/locales/ko/huddle.json'), 'utf8')).errors;
  for (const message of [...SERVER_MESSAGES, 'unknown']) {
    const name = huddleErrorKey(message).replace('huddle:errors.', '');
    assert.ok(en[name], `en 누락: ${name}`);
    assert.ok(ko[name], `ko 누락: ${name}`);
  }
});
