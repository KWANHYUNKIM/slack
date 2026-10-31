import test from 'node:test';
import assert from 'node:assert/strict';
import { changePasswordInputErrorKey, changePasswordFieldErrorKey, registerInputErrorKey, reauthFieldErrorKey } from '../src/lib/authErrors.ts';

test('change password: current password is required', () => {
  assert.equal(changePasswordInputErrorKey('', 'newpass1', 'newpass1'), 'settings:changePassword.errors.currentRequired');
});

test('change password: new password follows the register rules (6 to 72)', () => {
  assert.equal(changePasswordInputErrorKey('old', '12345', '12345'), 'auth:register.errors.passwordTooShort');
  assert.equal(changePasswordInputErrorKey('old', 'x'.repeat(73), 'x'.repeat(73)), 'auth:register.errors.passwordTooLong');
  assert.equal(changePasswordInputErrorKey('old', '123456', '123456'), null);
  assert.equal(changePasswordInputErrorKey('old', 'x'.repeat(72), 'x'.repeat(72)), null);
  // 가입과 같은 규칙인지 교차 확인
  for (const pw of ['12345', '123456', 'x'.repeat(72), 'x'.repeat(73)]) {
    assert.equal(changePasswordInputErrorKey('old', pw, pw), registerInputErrorKey('name', pw));
  }
});

test('change password: confirmation must match', () => {
  assert.equal(changePasswordInputErrorKey('old', 'newpass1', 'newpass2'), 'auth:register.errors.passwordMismatch');
});

test('server field errors map to translation keys', () => {
  assert.equal(changePasswordFieldErrorKey([{ path: 'newPassword', reason: 'too_small' }]), 'auth:register.errors.passwordTooShort');
  assert.equal(changePasswordFieldErrorKey([{ path: 'newPassword', reason: 'too_big' }]), 'auth:register.errors.passwordTooLong');
  assert.equal(changePasswordFieldErrorKey([{ path: 'currentPassword', reason: 'too_small' }]), 'settings:changePassword.errors.currentRequired');
  assert.equal(changePasswordFieldErrorKey([{ path: 'other', reason: 'x' }]), null);
  assert.equal(changePasswordFieldErrorKey(undefined), null);
});

test("reauth form: server field errors map to specific keys", () => {
  assert.equal(reauthFieldErrorKey([{ path: "password", reason: "too_big" }]), "settings:twoFactor.reauth.passwordInvalid");
  assert.equal(reauthFieldErrorKey([{ path: "code", reason: "too_small" }]), "settings:twoFactor.reauth.codeInvalid");
  assert.equal(reauthFieldErrorKey([{ path: "x", reason: "y" }]), null);
  assert.equal(reauthFieldErrorKey(undefined), null);
});
