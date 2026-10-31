// 채널 이름 규칙 (백엔드 backend/src/utils/channelName.ts와 같은 규칙을 유지한다)
// docs/architecture/i18n.md 4절. 백엔드 tests/channel-name-unicode.test.ts가 같은 테스트 벡터로
// 이 파일과 백엔드 구현의 결과가 같은지 검사하므로, 규칙을 바꾸면 양쪽을 함께 바꾼다.

import type { TFunction } from 'i18next';

export const CHANNEL_NAME_MAX = 25;
// 관리자 이름 변경의 상한(기존 관리자 상한, DB 컬럼 크기)
export const CHANNEL_NAME_ADMIN_MAX = 80;

// 첫 글자는 글자·숫자, 결합 문자는 글자·숫자 뒤에만, `-`·`_`는 어디든(첫 글자 제외).
// 글자/숫자와 결합 문자 집합이 겹치지 않아 백트래킹이 폭발하지 않는다. 제어/서식 문자(\p{C}), 공백, 기호, 이모지는 걸러진다.
const CHANNEL_NAME_PATTERN = /^[\p{L}\p{N}]\p{M}*(?:[\p{L}\p{N}]\p{M}*|[_-])*$/u;
// 소문자 변환 뒤에도 남는 대문자/제목 문자(대소문자 짝이 없는 문자는 \p{Lo}라 해당 없음)
const UPPERCASE_PATTERN = /[\p{Lu}\p{Lt}]/u;
// 보이지 않는 문자: 변형 선택자(FE00-FE0F, E0100-E01EF), CGJ(034F), 한글 채움 문자(3164, 115F, 1160, FFA0),
// 몽골 FVS(180B-180F) 등. 대부분 \p{M}이나 \p{Lo}라 위 패턴만으로는 통과한다. 'dev'와 'dev+FE0F'가 다른 채널이 되면 사칭이 된다.
const INVISIBLE_PATTERN = /\p{Default_Ignorable_Code_Point}/u;
// 문자 체계가 Common인 글자(ʹ ʻ ˈ ː 등 수식 문자)는 문장 부호처럼 보여 이름 구분자로 오인된다.
const COMMON_LETTER_PATTERN = /(?=\p{L})\p{scx=Common}/u;
// 서로 생김새가 같은 글자가 많은 문자 체계. 한 이름 안에서 둘 이상 섞이면 'gеneral'(키릴 е)처럼 사칭에 쓰인다.
// 한 체계만 쓰는 이름(순수 러시아어 등)과, 이들과 한글·한자·가나 등의 혼합은 허용한다.
const CONFUSABLE_SCRIPTS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
  /\p{Script=Armenian}/u,
  /\p{Script=Cherokee}/u,
];
const DIGIT_PATTERN = /\p{Nd}/u;
const NON_ASCII_DIGIT_PATTERN = /(?![0-9])\p{Nd}/u;
// 숫자로 ASCII 0-9를 쓰는 문자 체계. 이 글자와 다른 숫자 체계(벵골 ৪는 8과 닮음)가 섞이면 'room৪'가 'room8'을 사칭한다.
const ASCII_DIGIT_SCRIPTS = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
// 한글 호환 자모(ㄱ-ㆎ)는 NFKC가 첫소리 자모(U+1100대)로 바꿔 'ㅋㅋ'가 겹자음 한 글자처럼 보이게 된다. 이 구간만 NFKC에서 뺀다.
const NON_COMPAT_JAMO_RUN = /[^ㄱ-ㆎ]+/gu;

// NFKC로 전각(ｇｅｎｅｒａｌ), 합자(ﬁ), 수학 문자(𝐠) 같은 호환 문자를 기본 글자로 접어 같은 이름으로 취급한다.
// 로캘 독립 toLowerCase를 쓴다. toLocaleLowerCase는 실행 환경 로캘에 따라 결과가 달라져
// (터키어 I -> ı) 서버와 클라이언트가 다른 이름을 만들 수 있다. 같은 입력은 항상 같은 이름이어야 한다.
// 소문자 변환 뒤에 한 번 더 정규화하는 이유: İ 같은 글자는 소문자가 되며 결합 문자열로 풀린다.
export function normalizeChannelName(input: string): string {
  const nfkc = (s: string) => s.replace(NON_COMPAT_JAMO_RUN, (run) => run.normalize('NFKC'));
  return nfkc(nfkc(input).trim().toLowerCase());
}

// 십진 숫자의 0 코드 포인트. 숫자 집합은 0-9가 연속된 10개 묶음이라 앞쪽으로 이어진 숫자 수로 구한다.
function digitZero(cp: number): number {
  let start = cp;
  while (start > 0 && DIGIT_PATTERN.test(String.fromCodePoint(start - 1))) start--;
  return cp - ((cp - start) % 10);
}

// 생김새가 비슷한 문자 체계 섞기(라틴+키릴 등)와 숫자 체계 섞기(8과 벵골 숫자 ৪ 등)를 찾는다.
function hasMixedScripts(name: string): boolean {
  let scripts = 0;
  for (const re of CONFUSABLE_SCRIPTS) if (re.test(name)) scripts++;
  if (scripts > 1) return true;
  if (NON_ASCII_DIGIT_PATTERN.test(name) && ASCII_DIGIT_SCRIPTS.test(name)) return true;
  let zero: number | null = null;
  for (const ch of name) {
    if (!DIGIT_PATTERN.test(ch)) continue;
    const z = digitZero(ch.codePointAt(0)!);
    if (zero !== null && zero !== z) return true;
    zero = z;
  }
  return false;
}

export type ChannelNameReason = 'required' | 'tooLong' | 'invalidChars' | 'mixedScripts';

/** 정규화된 이름이 규칙에 맞는지 검사한다. 맞으면 null, 아니면 이유. */
export function checkChannelName(name: string, maxLength: number = CHANNEL_NAME_MAX): ChannelNameReason | null {
  if (name.length === 0) return 'required';
  // 길이는 코드 포인트 기준(한자·이모지 등 서로게이트 쌍을 2로 세지 않는다). 정규식보다 먼저 검사해 입력 크기를 묶는다.
  if ([...name].length > maxLength) return 'tooLong';
  if (
    !CHANNEL_NAME_PATTERN.test(name) ||
    UPPERCASE_PATTERN.test(name) ||
    INVISIBLE_PATTERN.test(name) ||
    COMMON_LETTER_PATTERN.test(name)
  ) {
    return 'invalidChars';
  }
  if (hasMixedScripts(name)) return 'mixedScripts';
  return null;
}

// ---- 프런트 전용 ----

/** 검사 결과를 화면에 보여 줄 번역 문구로 바꾼다(채널 만들기, 관리자 이름 변경 공용). */
export function channelNameErrorMessage(
  t: TFunction,
  reason: ChannelNameReason,
  maxLength: number = CHANNEL_NAME_MAX,
): string {
  return t(`channels:nameRules.${reason}`, { max: maxLength });
}
