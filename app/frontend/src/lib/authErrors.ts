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
