// 채널 이름 정규화·검증 (생성, 관리자 수정 등 이름을 받는 모든 경로가 공유한다)
// docs/architecture/i18n.md 4절

export const CHANNEL_NAME_INVALID = 'CHANNEL_NAME_INVALID';
export const CHANNEL_NAME_MAX = 25;

// 첫 글자는 글자·숫자, 이후는 글자·결합 문자·숫자·`-`·`_`. 제어/서식 문자(\p{C})와 이모지는 여기서 걸러진다.
const CHANNEL_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*$/u;
// 소문자 변환 뒤에도 남는 대문자/제목 문자(대소문자 짝이 없는 문자는 \p{Lo}라 해당 없음)
const UPPERCASE_PATTERN = /[\p{Lu}\p{Lt}]/u;

// 로캘 독립 toLowerCase를 쓴다. toLocaleLowerCase는 실행 환경 로캘에 따라 결과가 달라져
// (터키어 I -> ı) 서버와 클라이언트가 다른 이름을 만들 수 있다. 같은 입력은 항상 같은 이름이어야 한다.
// NFC를 소문자 변환 뒤에 한 번 더 하는 이유: İ 같은 글자는 소문자가 되며 결합 문자열로 풀린다.
export function normalizeChannelName(input: string): string {
  return input.trim().normalize('NFC').toLowerCase().normalize('NFC');
}

export type ChannelNameResult =
  | { ok: true; name: string }
  | { ok: false; error: string; code: typeof CHANNEL_NAME_INVALID };

export function validateChannelName(input: unknown, maxLength: number = CHANNEL_NAME_MAX): ChannelNameResult {
  const fail = (error: string): ChannelNameResult => ({ ok: false, error, code: CHANNEL_NAME_INVALID });
  if (typeof input !== 'string') return fail('Channel name is required');
  const name = normalizeChannelName(input);
  if (name.length === 0) return fail('Channel name is required');
  // 길이는 코드 포인트 기준(한자·이모지 등 서로게이트 쌍을 2로 세지 않는다)
  if ([...name].length > maxLength) {
    return fail(`Channel name must be ${maxLength} characters or fewer`);
  }
  if (!CHANNEL_NAME_PATTERN.test(name) || UPPERCASE_PATTERN.test(name)) {
    return fail('Channel names can only contain letters, numbers, hyphens, and underscores, and must start with a letter or number');
  }
  return { ok: true, name };
}
