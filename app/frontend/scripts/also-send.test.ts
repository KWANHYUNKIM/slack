import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldClearAlsoSend } from '../src/lib/alsoSend.ts';

test('응답 전에 사용자가 바꾸지 않았으면 체크를 푼다', () => {
  assert.equal(shouldClearAlsoSend(0, 0), true);
  assert.equal(shouldClearAlsoSend(3, 3), true);
});

test('응답을 기다리는 사이 사용자가 바꿨으면 체크를 지킨다', () => {
  assert.equal(shouldClearAlsoSend(0, 1), false);
  // 끄고 다시 켜도 횟수가 늘었으므로 지킨다
  assert.equal(shouldClearAlsoSend(2, 4), false);
});
