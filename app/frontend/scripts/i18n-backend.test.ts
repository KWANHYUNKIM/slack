import test from 'node:test';
import assert from 'node:assert/strict';
import { selectErrorKey, GENERIC_CODES } from '../src/lib/apiErrorCodes.ts';
import { diffUserPrefs, isPermanentRejection, retryDelayMs, normalizeLocale } from '../src/lib/userPrefsDiff.ts';
import { registerInputErrorKey, registerFieldErrorKey, loginFieldErrorKey } from '../src/lib/authErrors.ts';

const all = () => true;
const none = () => false;

test('generic status codes fall back to the caller key (channel create 500 shows createFailed)', () => {
  const fallback = 'channels:dialog.errors.createFailed';
  for (const code of GENERIC_CODES) assert.equal(selectErrorKey(code, fallback, all), fallback);
  assert.equal(selectErrorKey('INTERNAL_ERROR', fallback, all), fallback);
  assert.equal(selectErrorKey(undefined, fallback, all), fallback);
});

test('specific codes translate to errors:api.<CODE>; unknown or untranslated codes fall back', () => {
  const fallback = 'x:fallback';
  assert.equal(selectErrorKey('AUTH_INVALID_CREDENTIALS', fallback, all), 'errors:api.AUTH_INVALID_CREDENTIALS');
  assert.equal(selectErrorKey('PAYLOAD_TOO_LARGE', fallback, all), 'errors:api.PAYLOAD_TOO_LARGE');
  assert.equal(selectErrorKey('SOME_NEW_CODE', fallback, none), fallback);
  assert.equal(selectErrorKey('not-a-code', fallback, all), fallback);
});

test('prefs: only changed values are sent, locale is canonicalized', () => {
  assert.deepEqual(diffUserPrefs({ locale: null, timeZone: null }, { locale: 'ko', timeZone: 'Asia/Seoul' }), { locale: 'ko', timeZone: 'Asia/Seoul' });
  assert.deepEqual(diffUserPrefs({ locale: 'ko', timeZone: 'Asia/Seoul' }, { locale: 'ko', timeZone: 'Asia/Seoul' }), {});
  assert.deepEqual(diffUserPrefs({ locale: 'en-US', timeZone: 'Asia/Seoul' }, { locale: 'en-us', timeZone: 'Asia/Seoul' }), {});
  assert.deepEqual(diffUserPrefs({ locale: 'ko', timeZone: 'Asia/Seoul' }, { locale: 'en', timeZone: 'Asia/Seoul' }), { locale: 'en' });
  assert.equal(normalizeLocale('zh-hant-tw'), 'zh-Hant-TW');
  assert.equal(normalizeLocale('not a locale'), null);
});

test('prefs: an alias time zone is sent once, not on every trigger (Kolkata / Calcutta)', () => {
  // 서버가 Asia/Kolkata로 저장해 돌려줬는데 브라우저는 Asia/Calcutta를 계속 보고하는 경우
  const browser = { locale: 'ko', timeZone: 'Asia/Calcutta' };
  let saved = { locale: 'ko', timeZone: 'Asia/Kolkata' as string | null };
  assert.deepEqual(diffUserPrefs(saved, browser), { timeZone: 'Asia/Calcutta' });
  const acked = { timeZone: { browser: 'Asia/Calcutta', saved: 'Asia/Kolkata' } };
  assert.deepEqual(diffUserPrefs(saved, browser, acked), {});
  assert.deepEqual(diffUserPrefs(saved, browser, acked), {});
  // 다른 기기에서 서버 값이 바뀌었다면 다시 맞춘다
  saved = { locale: 'ko', timeZone: 'Europe/London' };
  assert.deepEqual(diffUserPrefs(saved, browser, acked), { timeZone: 'Asia/Calcutta' });
});

test('prefs: only a 400 INVALID_* rejection is permanent; transient failures retry with backoff', () => {
  assert.equal(isPermanentRejection(400, 'INVALID_LOCALE'), true);
  assert.equal(isPermanentRejection(400, 'INVALID_TIME_ZONE'), true);
  assert.equal(isPermanentRejection(400, 'VALIDATION_FAILED'), false);
  assert.equal(isPermanentRejection(429, 'RATE_LIMITED'), false);
  assert.equal(isPermanentRejection(500, 'INTERNAL_ERROR'), false);
  assert.equal(isPermanentRejection(undefined, undefined), false);
  assert.deepEqual([1, 2, 3, 4].map(retryDelayMs), [5000, 10000, 20000, 40000]);
  assert.equal(retryDelayMs(30), 300000);
});

test('register: password and name rules show field-specific keys', () => {
  assert.equal(registerInputErrorKey('Kim', 'abc'), 'auth:register.errors.passwordTooShort');
  assert.equal(registerInputErrorKey('Kim', 'x'.repeat(73)), 'auth:register.errors.passwordTooLong');
  assert.equal(registerInputErrorKey('  ', 'abcdef'), 'auth:register.errors.nameRequired');
  assert.equal(registerInputErrorKey('k'.repeat(101), 'abcdef'), 'auth:register.errors.nameTooLong');
  assert.equal(registerInputErrorKey('Kim', 'abcdef'), null);
  assert.equal(registerFieldErrorKey([{ path: 'password', reason: 'too_small' }]), 'auth:register.errors.passwordTooShort');
  assert.equal(registerFieldErrorKey([{ path: 'password', reason: 'too_big' }]), 'auth:register.errors.passwordTooLong');
  assert.equal(registerFieldErrorKey([{ path: 'name', reason: 'custom' }]), 'auth:register.errors.nameInvalid');
  assert.equal(registerFieldErrorKey(undefined), null);
});

test('login: only an email field shows the email message', () => {
  assert.equal(loginFieldErrorKey([{ path: 'email', reason: 'invalid_string' }]), 'auth:login.errors.invalidEmail');
  assert.equal(loginFieldErrorKey([{ path: 'password', reason: 'too_small' }]), 'auth:login.errors.generic');
  assert.equal(loginFieldErrorKey(undefined), 'auth:login.errors.generic');
});
