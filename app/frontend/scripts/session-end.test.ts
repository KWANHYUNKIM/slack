import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionEndAction } from '../src/lib/sessionEnd.ts';

test('clears only when the failed token is the one stored now', () => {
  assert.equal(sessionEndAction('old', 'old'), 'clear');
});

test('another tab already stored a new token: keep it and retry', () => {
  // 탭 A가 2FA를 켜서 새 토큰을 저장한 뒤, 탭 B가 이전 토큰으로 실패한 경우
  assert.equal(sessionEndAction('old', 'new'), 'retry');
});

test('nothing stored: already signed out', () => {
  assert.equal(sessionEndAction('old', null), 'ignore');
  assert.equal(sessionEndAction(null, null), 'ignore');
});

test('unknown failed token falls back to clearing (previous behavior)', () => {
  assert.equal(sessionEndAction(undefined, 'stored'), 'clear');
  assert.equal(sessionEndAction(null, 'stored'), 'clear');
});
