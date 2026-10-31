import type { DlpAction, DlpRule } from '@prisma/client';
import prisma from '../db.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { DlpBlockedError } from './messageService.js';

// 데이터 유출 방지(E10). 메시지 쓰기 서비스(채널, DM, 그룹 DM, MCP 도구가 같은 서비스를 쓴다)가 저장 전에
// enforceDlp를 부르고, WARN으로 저장된 메시지는 저장 뒤 recordDlpWarnings로 감사 로그를 남긴다.
// 감사 로그에는 규칙 이름과 메시지 id만 남기고 메시지 내용이나 일치한 문자열은 남기지 않는다.

export const PATTERN_MAX_LENGTH = 200;
export const NAME_MAX_LENGTH = 100;
/** 한 번에 정규식에 넘기는 글자 수. 40,000자 본문도 이 조각 단위로 나눠 모두 검사한다(건너뛰면 긴 글로 우회할 수 있다). */
const SCAN_CHUNK = 4096;
/** 조각 사이 겹침. 내장 규칙의 일치 길이(개인 키 머리글 약 40자)보다 충분히 크다. */
const SCAN_OVERLAP = 256;
/** 한 번에 적용하는 규칙 수의 상한(캐시 크기와 검사 시간을 묶는다) */
const MAX_RULES = 100;
const CACHE_TTL_MS = 30_000;
/** 패턴 테스트 입력 상한 */
export const TEST_SAMPLE_MAX = 2000;

// --- 내장 규칙 ---------------------------------------------------------------------------------

/** Luhn 검사: 카드 번호의 숫자만 모아 체크섬을 확인한다 */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const CARD_PREFIX = /^(?:4|5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720)|3[0-9]|6(?:011|5|4[4-9]|2))/;

interface BuiltinDef {
  key: string;
  name: string;
  pattern: string;
  action: DlpAction;
  /** 정규식이 찾은 후보가 진짜인지 한 번 더 확인한다(오탐 줄이기) */
  validate?: (match: string) => boolean;
}

export const BUILTIN_RULES: readonly BuiltinDef[] = [
  {
    key: 'credit_card',
    name: 'Credit card number',
    // 숫자 13~19개(공백·하이픈 허용). Luhn까지 통과해야 일치로 본다
    pattern: String.raw`(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])`,
    action: 'BLOCK',
    validate: (m) => {
      const digits = m.replace(/[ -]/g, '');
      // 발급사 번호(IIN) 접두어까지 맞아야 한다. Luhn만으로는 13자리 밀리초 타임스탬프 같은 숫자가 10%쯤 통과한다.
      return digits.length >= 13 && digits.length <= 19 && CARD_PREFIX.test(digits) && luhnValid(digits);
    },
  },
  {
    key: 'kr_rrn',
    name: 'Korean resident registration number',
    pattern: String.raw`(?<!\d)\d{6}-[1-4]\d{6}(?!\d)`,
    action: 'BLOCK',
    // 생년월일 부분이 실제 달력 값일 때만
    validate: (m) => {
      const month = Number(m.slice(2, 4));
      const day = Number(m.slice(4, 6));
      return month >= 1 && month <= 12 && day >= 1 && day <= 31;
    },
  },
  {
    key: 'aws_access_key',
    name: 'AWS access key',
    pattern: String.raw`(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])`,
    action: 'BLOCK',
  },
  {
    key: 'private_key',
    name: 'Private key',
    pattern: String.raw`-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY-----`,
    action: 'BLOCK',
  },
];

const BUILTIN_BY_KEY = new Map(BUILTIN_RULES.map((b) => [b.key, b]));

// --- 사용자 정의 패턴 검증 ---------------------------------------------------------------------

export type PatternProblem = 'empty' | 'tooLong' | 'invalid' | 'backreference' | 'nestedQuantifier' | 'repeatTooLarge';

const REPEAT_MAX = 200;

/**
 * 관리자가 입력한 패턴이 안전한지 본다. 정규식 엔진은 도중에 멈출 수 없으므로(재앙적 역추적, ReDoS)
 * 저장 전에 위험한 모양을 거부한다. 거부하는 것:
 * - 너무 긴 패턴, 컴파일 실패
 * - 역참조(\1, \k<name>): 지수 시간이 될 수 있다
 * - 안쪽에 반복(*, +, {n,m})이 있는 그룹을 다시 반복하는 중첩 수량자, 대안(|)이 있는 그룹을 무한 반복하는 패턴
 * - 큰 반복 횟수({n,m}에서 m > 200)
 * 반환값이 null이면 통과다.
 */
export function validatePattern(pattern: string): PatternProblem | null {
  if (pattern.length === 0) return 'empty';
  if (pattern.length > PATTERN_MAX_LENGTH) return 'tooLong';
  try {
    new RegExp(pattern);
  } catch {
    return 'invalid';
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'backreference';

  // 간단한 토큰 훑기: 문자 클래스와 이스케이프는 건너뛰고, 그룹마다 "안에 반복이 있는지 / 대안이 있는지"를 쌓는다
  type Frame = { repeats: boolean; alternation: boolean };
  const stack: Frame[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push({ repeats: false, alternation: false });
      continue;
    }
    if (ch === '|' && stack.length > 0) {
      stack[stack.length - 1].alternation = true;
      continue;
    }
    // 이 위치의 반복 연산자를 읽는다
    const quant = readQuantifier(pattern, i);
    if (quant) {
      if (quant.max > REPEAT_MAX && quant.max !== Infinity) return 'repeatTooLarge';
      if (quant.max > 1 && stack.length > 0) stack[stack.length - 1].repeats = true;
      i = quant.end - 1;
      continue;
    }
    if (ch === ')') {
      const frame = stack.pop();
      if (!frame) continue;
      const after = readQuantifier(pattern, i + 1);
      if (after && after.max > 1) {
        // 안쪽이 이미 반복이거나, 대안이 있고 바깥이 무한 반복이면 위험하다
        if (frame.repeats) return 'nestedQuantifier';
        if (frame.alternation && after.max === Infinity) return 'nestedQuantifier';
      }
      // 바깥 그룹도 "안에 반복이 있다"고 알린다(바깥에서 다시 반복하면 중첩)
      if (stack.length > 0 && (frame.repeats || (after && after.max > 1))) stack[stack.length - 1].repeats = true;
    }
  }
  return null;
}

/** pattern[i]에서 시작하는 반복 연산자(*, +, ?, {n}, {n,}, {n,m})를 읽는다. 뒤의 ?(게으른)·+(소유)는 함께 소비한다. */
function readQuantifier(pattern: string, i: number): { min: number; max: number; end: number } | null {
  const ch = pattern[i];
  let min: number;
  let max: number;
  let end: number;
  if (ch === '*') {
    min = 0;
    max = Infinity;
    end = i + 1;
  } else if (ch === '+') {
    min = 1;
    max = Infinity;
    end = i + 1;
  } else if (ch === '?') {
    min = 0;
    max = 1;
    end = i + 1;
  } else if (ch === '{') {
    const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i, i + 24));
    if (!m) return null;
    min = Number(m[1]);
    max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
    end = i + m[0].length;
  } else {
    return null;
  }
  if (pattern[end] === '?') end++;
  return { min, max, end };
}

// --- 규칙 캐시 ---------------------------------------------------------------------------------

interface CompiledRule {
  id: number;
  name: string;
  action: DlpAction;
  regex: RegExp;
  validate?: (match: string) => boolean;
}

let cache: { rules: CompiledRule[]; loadedAt: number } | null = null;
let generation = 0; // 읽는 도중 규칙이 바뀌면 그 결과를 캐시하지 않기 위한 세대 번호
let loading: Promise<CompiledRule[]> | null = null;
let builtinsEnsured = false;

/** 규칙을 바꾼 뒤 부른다. 다음 검사가 DB에서 다시 읽는다. */
export function invalidateDlpCache(): void {
  generation++;
  cache = null;
  loading = null;
}

/** 내장 규칙 행이 없으면 만든다(켜짐, 고정 action). 이미 있으면 패턴만 코드 기준으로 맞춘다. */
export async function ensureBuiltinRules(): Promise<void> {
  for (const b of BUILTIN_RULES) {
    await prisma.dlpRule.upsert({
      where: { key: b.key },
      update: { pattern: b.pattern, builtin: true },
      create: { key: b.key, name: b.name, pattern: b.pattern, action: b.action, builtin: true, enabled: true },
    });
  }
  builtinsEnsured = true;
}

function compile(row: DlpRule): CompiledRule | null {
  const builtin = row.key ? BUILTIN_BY_KEY.get(row.key) : undefined;
  // 내장 규칙은 DB 값이 아니라 코드의 패턴을 쓴다(DB를 고쳐 탐지를 바꿀 수 없게)
  const source = builtin ? builtin.pattern : row.pattern;
  // 저장된 뒤에 검증 규칙이 강화됐을 수 있으니 불러올 때도 다시 본다
  if (!builtin && validatePattern(source) !== null) return null;
  try {
    return { id: row.id, name: row.name, action: row.action, regex: new RegExp(source, 'g'), validate: builtin?.validate };
  } catch {
    return null;
  }
}

async function loadRules(): Promise<CompiledRule[]> {
  if (!builtinsEnsured) await ensureBuiltinRules();
  const rows = await prisma.dlpRule.findMany({ where: { enabled: true }, orderBy: { id: 'asc' }, take: MAX_RULES });
  const compiled: CompiledRule[] = [];
  for (const row of rows) {
    const c = compile(row);
    if (c) compiled.push(c);
  }
  return compiled;
}

async function getRules(): Promise<CompiledRule[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.rules;
  // 동시에 여러 요청이 와도 읽기는 한 번
  const gen = generation;
  loading ??= loadRules()
    .then((rules) => {
      if (gen === generation) cache = { rules, loadedAt: Date.now() };
      return rules;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

// --- 검사 --------------------------------------------------------------------------------------

/** content 전체를 조각으로 나눠 규칙 하나가 일치하는지 본다 */
function ruleMatches(rule: Pick<CompiledRule, 'regex' | 'validate'>, content: string): boolean {
  for (let start = 0; start < content.length; start += SCAN_CHUNK - SCAN_OVERLAP) {
    const chunk = content.slice(start, start + SCAN_CHUNK);
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.regex.exec(chunk)) !== null) {
      if (!rule.validate || rule.validate(m[0])) return true;
      if (m[0].length === 0) rule.regex.lastIndex++; // 빈 일치로 무한 반복하지 않게
    }
    if (start + SCAN_CHUNK >= content.length) break;
  }
  return false;
}

export interface DlpHit {
  name: string;
  action: DlpAction;
}

/** 켜진 규칙 중 content와 일치하는 것(이름과 action만). 감사 로그는 쓰지 않는다. */
export async function scanContent(content: string): Promise<DlpHit[]> {
  if (!content) return [];
  const rules = await getRules();
  const hits: DlpHit[] = [];
  for (const rule of rules) {
    if (ruleMatches(rule, content)) hits.push({ name: rule.name, action: rule.action });
  }
  return hits;
}

export type DlpTarget = 'message' | 'direct_message';

/**
 * 저장 전 검사. BLOCK 규칙이 일치하면 감사 로그(dlp.blocked, 규칙 이름만)를 남기고 DlpBlockedError를 던진다.
 * 통과하면 WARN으로 일치한 규칙 이름을 돌려준다. 호출한 쪽은 저장 뒤 recordDlpWarnings에 넘긴다.
 */
export async function enforceDlp(userId: number, content: string, target: DlpTarget): Promise<string[]> {
  const hits = await scanContent(content);
  const blocked = hits.find((h) => h.action === 'BLOCK');
  if (blocked) {
    await writeAuditLog({ action: 'dlp.blocked', actorId: userId, targetType: target, targetName: blocked.name });
    throw new DlpBlockedError(blocked.name);
  }
  return hits.map((h) => h.name);
}

/** WARN으로 저장된 메시지의 감사 로그(dlp.warned). 규칙 이름과 메시지 id만 남기고 응답을 늦추지 않는다. */
export function recordDlpWarnings(userId: number, target: DlpTarget, targetId: number, ruleNames: string[]): void {
  for (const name of ruleNames) {
    void writeAuditLog({ action: 'dlp.warned', actorId: userId, targetType: target, targetId, targetName: name });
  }
}

/** 관리자 화면의 "패턴 테스트": 저장하지 않은 패턴이나 저장된 규칙이 샘플과 일치하는지 */
export function testPattern(pattern: string, sample: string, validate?: (m: string) => boolean): { matched: boolean } {
  const regex = new RegExp(pattern, 'g');
  return { matched: ruleMatches({ regex, validate }, sample.slice(0, TEST_SAMPLE_MAX)) };
}

export function builtinValidator(key: string | null): ((m: string) => boolean) | undefined {
  return key ? BUILTIN_BY_KEY.get(key)?.validate : undefined;
}

/** 테스트용 */
export function resetDlpStateForTests(): void {
  cache = null;
  loading = null;
  builtinsEnsured = false;
}
