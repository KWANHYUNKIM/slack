import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionEndingError } from '../src/lib/authErrors.ts';

test('token problems on 401 end the session', () => {
  assert.equal(isSessionEndingError(401, 'AUTH_NO_TOKEN'), true);
  assert.equal(isSessionEndingError(401, 'AUTH_INVALID_TOKEN'), true);
});

test('401 without a specific code keeps the old behavior (end session)', () => {
  assert.equal(isSessionEndingError(401), true);
  assert.equal(isSessionEndingError(401, null), true);
  assert.equal(isSessionEndingError(401, 'UNAUTHORIZED'), true);
});

test('wrong credentials and wrong 2FA codes do not end the session', () => {
  for (const code of ['AUTH_INVALID_CREDENTIALS', 'MFA_INVALID_CODE', 'MFA_TOKEN_INVALID', 'MFA_UNAVAILABLE', 'FILE_TOKEN_INVALID']) {
    assert.equal(isSessionEndingError(401, code), false, code);
  }
});

test('non-401 statuses never end the session', () => {
  for (const status of [400, 403, 404, 429, 500]) {
    assert.equal(isSessionEndingError(status, 'AUTH_INVALID_TOKEN'), false);
    assert.equal(isSessionEndingError(status), false);
  }
});
