// 로그인·가입 화면의 입력 검증 문구 선택(순수 로직, 번역은 호출한 쪽이 t()로 한다).
// 서버(utils/authSchemas.ts)와 같은 규칙: 비밀번호 6~72자, 이름 1~100자.

export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 72;
export const NAME_MAX = 100;

export interface FieldError { path: string; reason: string }

/** 가입 입력을 보내기 전에 검사한다. 어긋나면 번역 키를, 괜찮으면 null을 돌려준다. */
export function registerInputErrorKey(name: string, password: string): string | null {
  if (!name.trim()) return 'auth:register.errors.nameRequired';
  if (name.length > NAME_MAX) return 'auth:register.errors.nameTooLong';
  if (password.length < PASSWORD_MIN) return 'auth:register.errors.passwordTooShort';
  if (password.length > PASSWORD_MAX) return 'auth:register.errors.passwordTooLong';
  return null;
}

/** 서버가 VALIDATION_FAILED와 함께 준 fields에서 가입 화면 문구 키를 고른다. 알 수 없으면 null. */
export function registerFieldErrorKey(fields: FieldError[] | undefined): string | null {
  for (const f of fields ?? []) {
    if (f.path === 'password') return f.reason === 'too_big' ? 'auth:register.errors.passwordTooLong' : 'auth:register.errors.passwordTooShort';
    if (f.path === 'name') {
      if (f.reason === 'too_small') return 'auth:register.errors.nameRequired';
      if (f.reason === 'too_big') return 'auth:register.errors.nameTooLong';
      return 'auth:register.errors.nameInvalid';
    }
    if (f.path === 'email') return 'auth:login.errors.invalidEmail';
  }
  return null;
}

/** 로그인 검증 실패: 이메일 필드일 때만 이메일 안내를 보이고, 그 밖에는 일반 문구다. */
export function loginFieldErrorKey(fields: FieldError[] | undefined): string {
  return (fields ?? []).some((f) => f.path === 'email') ? 'auth:login.errors.invalidEmail' : 'auth:login.errors.generic';
}

// ---- 세션 종료 판정 ----
// 서버는 토큰이 없거나(AUTH_NO_TOKEN) 무효·만료·폐기·비활성화된 경우(AUTH_INVALID_TOKEN)에만 이 code로 401을 낸다.
// 로그인 화면의 잘못된 자격(AUTH_INVALID_CREDENTIALS), 2차 인증 실패(MFA_INVALID_CODE, MFA_TOKEN_INVALID, MFA_UNAVAILABLE),
// 다운로드 링크 만료(FILE_TOKEN_INVALID)도 401이지만 저장된 세션은 멀쩡하므로 로그아웃하면 안 된다.

/** 세션 종료를 뜻하는 401 code */
export const SESSION_ENDING_CODES: ReadonlySet<string> = new Set(['AUTH_NO_TOKEN', 'AUTH_INVALID_TOKEN']);

/**
 * 이 응답이 세션 종료 신호인가. 401이 아니면 아니다.
 * code가 없거나 상태별 기본값(UNAUTHORIZED)이면 구체 사유를 모르는 것이므로 예전처럼 세션 종료로 본다(안전한 쪽).
 */
export function isSessionEndingError(status: number, code?: string | null): boolean {
  if (status !== 401) return false;
  if (!code || code === 'UNAUTHORIZED') return true;
  return SESSION_ENDING_CODES.has(code);
}

/** 비밀번호 변경 입력을 보내기 전에 검사한다. 새 비밀번호 규칙은 가입과 같다. 어긋나면 번역 키를, 괜찮으면 null을 돌려준다. */
export function changePasswordInputErrorKey(current: string, next: string, confirm: string): string | null {
  if (!current) return 'settings:changePassword.errors.currentRequired';
  if (next.length < PASSWORD_MIN) return 'auth:register.errors.passwordTooShort';
  if (next.length > PASSWORD_MAX) return 'auth:register.errors.passwordTooLong';
  if (next !== confirm) return 'auth:register.errors.passwordMismatch';
  return null;
}

/** 서버가 VALIDATION_FAILED와 함께 준 fields에서 비밀번호 변경 화면 문구 키를 고른다. 알 수 없으면 null. */
export function changePasswordFieldErrorKey(fields: FieldError[] | undefined): string | null {
  for (const f of fields ?? []) {
    if (f.path === 'newPassword') return f.reason === 'too_big' ? 'auth:register.errors.passwordTooLong' : 'auth:register.errors.passwordTooShort';
    if (f.path === 'currentPassword') return 'settings:changePassword.errors.currentRequired';
  }
  return null;
}

/** 비밀번호 + 2단계 코드 재확인(2FA 끄기, 복구 코드 다시 만들기)에서 VALIDATION_FAILED fields로 구체 문구 키를 고른다. 알 수 없으면 null. */
export function reauthFieldErrorKey(fields: FieldError[] | undefined): string | null {
  for (const f of fields ?? []) {
    if (f.path === 'password') return 'settings:twoFactor.reauth.passwordInvalid';
    if (f.path === 'code') return 'settings:twoFactor.reauth.codeInvalid';
  }
  return null;
}
