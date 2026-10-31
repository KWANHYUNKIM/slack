// 채널 이름 규칙 (백엔드 backend/src/utils/channelName.ts와 같은 규칙을 유지한다)
// docs/architecture/i18n.md 4절

export const CHANNEL_NAME_MAX = 25;

const CHANNEL_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*$/u;
const UPPERCASE_PATTERN = /[\p{Lu}\p{Lt}]/u;

// toLocaleLowerCase는 실행 로캘에 따라 결과가 달라지므로(터키어 I -> ı) 로캘 독립 toLowerCase를 쓴다.
export function normalizeChannelName(input: string): string {
  return input.trim().normalize('NFC').toLowerCase().normalize('NFC');
}

export type ChannelNameError = 'tooLong' | 'invalidChars';

/** 정규화된 이름이 규칙에 맞는지 검사한다. 맞으면 null, 아니면 오류 종류. 빈 이름은 호출부가 따로 처리한다. */
export function checkChannelName(name: string, maxLength: number = CHANNEL_NAME_MAX): ChannelNameError | null {
  if ([...name].length > maxLength) return 'tooLong';
  if (!CHANNEL_NAME_PATTERN.test(name) || UPPERCASE_PATTERN.test(name)) return 'invalidChars';
  return null;
}
