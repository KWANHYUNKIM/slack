import { Worker } from 'node:worker_threads';
import type { DlpAction } from '@prisma/client';
import prisma from '../db.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { logError } from '../utils/logger.js';
import { DlpBlockedError } from './messageService.js';

// 데이터 유출 방지(E10). 메시지 쓰기 서비스(채널, DM, 그룹 DM, MCP 도구가 같은 서비스를 쓴다)가 저장 전에
// enforceDlp를 부르고, WARN으로 저장된 메시지는 저장 뒤 recordDlpWarnings로 감사 로그를 남긴다.
// 감사 로그에는 규칙 이름과 메시지 id만 남기고 메시지 내용이나 일치한 문자열은 남기지 않는다.
//
// 내장 규칙은 코드가 소유한 탐지기라 메인 스레드에서 본문 전체를 한 번에 검사한다(^, $ 의미가 원문 기준).
// 관리자가 정의한 패턴은 정규식 엔진이 도중에 멈출 수 없으므로 워커 스레드에서 시간 상한을 두고 실행한다.

export const PATTERN_MAX_LENGTH = 200;
export const NAME_MAX_LENGTH = 100;
/** 한 번에 적용하는 규칙 수의 상한(캐시 크기와 검사 시간을 묶는다) */
const MAX_RULES = 100;
const CACHE_TTL_MS = 30_000;
/** 패턴 테스트 입력 상한 */
export const TEST_SAMPLE_MAX = 2000;
/** 메시지 하나를 사용자 정의 규칙들로 검사하는 데 쓰는 시간의 총상한 */
export const MESSAGE_BUDGET_MS = 50;
/** 같은 규칙이 이만큼 연속으로 시간 초과하면 자동으로 끈다 */
export const AUTO_DISABLE_AFTER = 3;

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
const CARD_MIN = 13;
const CARD_MAX = 19;

/**
 * 숫자열(공백·하이픈 허용) 안의 13~19자리 모든 연속 부분열을 본다. 카드 번호 앞뒤에 숫자를 붙여
 * 숫자열 전체의 Luhn을 깨뜨리는 우회를 막는다. 발급사 번호(IIN) 접두어까지 맞아야 한다
 * (Luhn만으로는 13자리 밀리초 타임스탬프가 10%쯤 통과한다).
 */
function detectCard(text: string): boolean {
  const runs = /\d(?:[ -]?\d)*/g;
  let m: RegExpExecArray | null;
  while ((m = runs.exec(text)) !== null) {
    const digits = m[0].replace(/[ -]/g, '');
    for (let start = 0; start + CARD_MIN <= digits.length; start++) {
      if (!CARD_PREFIX.test(digits.slice(start, start + 6))) continue;
      for (let len = CARD_MIN; len <= CARD_MAX && start + len <= digits.length; len++) {
        if (luhnValid(digits.slice(start, start + len))) return true;
      }
    }
  }
  return false;
}

/** 정규식이 찾은 후보를 검증 함수로 한 번 더 확인하는 탐지기 */
function regexDetector(source: string, validate?: (m: string) => boolean): (text: string) => boolean {
  const regex = new RegExp(source, 'g');
  return (text) => {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (!validate || validate(m[0])) return true;
      if (m[0].length === 0) regex.lastIndex++;
    }
    return false;
  };
}

interface BuiltinDef {
  key: string;
  name: string;
  /** 화면에 보이는 설명용 패턴(탐지는 detect가 한다) */
  pattern: string;
  action: DlpAction;
  detect: (text: string) => boolean;
}

const KR_RRN = String.raw`(?<!\d)\d{6}-[1-4]\d{6}(?!\d)`;
const AWS_KEY = String.raw`(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])`;
const PRIVATE_KEY = String.raw`-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY-----`;

export const BUILTIN_RULES: readonly BuiltinDef[] = [
  {
    key: 'credit_card',
    name: 'Credit card number',
    pattern: String.raw`\d(?:[ -]?\d){12,18}`,
    action: 'BLOCK',
    detect: detectCard,
  },
  {
    key: 'kr_rrn',
    name: 'Korean resident registration number',
    pattern: KR_RRN,
    action: 'BLOCK',
    // 생년월일 부분이 실제 달력 값일 때만
    detect: regexDetector(KR_RRN, (m) => {
      const month = Number(m.slice(2, 4));
      const day = Number(m.slice(4, 6));
      return month >= 1 && month <= 12 && day >= 1 && day <= 31;
    }),
  },
  { key: 'aws_access_key', name: 'AWS access key', pattern: AWS_KEY, action: 'BLOCK', detect: regexDetector(AWS_KEY) },
  { key: 'private_key', name: 'Private key', pattern: PRIVATE_KEY, action: 'BLOCK', detect: regexDetector(PRIVATE_KEY) },
];

const BUILTIN_BY_KEY = new Map(BUILTIN_RULES.map((b) => [b.key, b]));
const BUILTIN_NAMES = new Set(BUILTIN_RULES.map((b) => b.name.toLowerCase()));

/** 사용자 정의 규칙이 내장 규칙 이름을 가로채지 못하게(대소문자 무시) */
export function isBuiltinName(name: string): boolean {
  return BUILTIN_NAMES.has(name.trim().toLowerCase());
}

// --- 사용자 정의 패턴 검증 ---------------------------------------------------------------------

export type PatternProblem = 'empty' | 'tooLong' | 'invalid' | 'backreference' | 'nestedQuantifier' | 'repeatTooLarge';

const REPEAT_MAX = 200;
/** 인접한 무한 반복이 이만큼 이어지면 다항식 시간(n^k)이 되므로 거부한다 */
const ADJACENT_UNBOUNDED_MAX = 2;

interface Frame {
  /** 안에 최대 2회 이상 반복되는 원자가 있다 */
  repeats: boolean;
  /** 안에 선택(|)이 있다 */
  alternation: boolean;
  /** 안에 없어도 되는(최소 0회) 원자가 있다 */
  optional: boolean;
  /** 같은 단계에서 연달아 나온 무한 반복 원자의 수 */
  run: number;
}

const newFrame = (): Frame => ({ repeats: false, alternation: false, optional: false, run: 0 });

/**
 * 관리자가 입력한 패턴의 모양을 본다. 정규식 엔진은 도중에 멈출 수 없으므로(재앙적 역추적, ReDoS) 저장 전에
 * 위험한 모양을 거부한다. 이 검사는 1차 방어이고, 실행은 항상 워커 스레드의 시간 상한 안에서 한다.
 * 거부하는 것:
 * - 너무 긴 패턴, 컴파일 실패, 역참조(\1, \k<name>)
 * - 반복(2회 이상)되는 그룹 안에 반복·선택·옵션 원자가 있는 것: (a+)+, (a?){30}, (a|aa){1,200}
 * - 인접한 무한 반복이 3개 이상 이어지는 것: \w*\w*\w*!
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

  const stack: Frame[] = [newFrame()];
  const top = () => stack[stack.length - 1];
  let problem: PatternProblem | null = null;

  /** 원자 하나(그룹이면 inner)가 끝난 뒤 그 뒤의 수량자 q로 부모 프레임 상태를 갱신한다 */
  const atomDone = (q: Quantifier | null, inner: Frame | null): void => {
    const parent = top();
    if (q && q.max !== Infinity && q.max > REPEAT_MAX) problem ??= 'repeatTooLarge';
    if (inner) {
      if (q && q.max > 1 && (inner.repeats || inner.alternation || inner.optional)) problem ??= 'nestedQuantifier';
      parent.repeats ||= inner.repeats;
      parent.optional ||= inner.optional;
    }
    if (q && q.max > 1) parent.repeats = true;
    if (q && q.min === 0) parent.optional = true;
    if (q && q.max === Infinity) {
      parent.run++;
      if (parent.run > ADJACENT_UNBOUNDED_MAX) problem ??= 'nestedQuantifier';
    } else {
      parent.run = 0;
    }
  };

  let i = 0;
  while (i < pattern.length && !problem) {
    const ch = pattern[i];
    if (ch === '|') {
      top().alternation = true;
      top().run = 0;
      i++;
    } else if (ch === '(') {
      i++;
      // (?: (?= (?! (?<= (?<! (?<name> 머리를 건너뛴다
      if (pattern[i] === '?') {
        if (pattern[i + 1] === '<' && pattern[i + 2] !== '=' && pattern[i + 2] !== '!') i = pattern.indexOf('>', i) + 1;
        else i += pattern[i + 1] === '<' ? 3 : 2;
      }
      stack.push(newFrame());
    } else if (ch === ')') {
      if (stack.length === 1) break; // 컴파일을 통과했으니 일어나지 않는다
      const inner = stack.pop()!;
      const q = readQuantifier(pattern, i + 1);
      atomDone(q, inner);
      i = q ? q.end : i + 1;
    } else {
      // 원자 하나: 이스케이프, 문자 클래스, 그 밖의 한 글자
      let end = i + 1;
      if (ch === '\\') end = i + 2;
      else if (ch === '[') {
        end = i + 1;
        while (end < pattern.length && pattern[end] !== ']') end += pattern[end] === '\\' ? 2 : 1;
        end++;
      }
      const q = readQuantifier(pattern, end);
      atomDone(q, null);
      i = q ? q.end : end;
    }
  }
  return problem;
}

interface Quantifier {
  min: number;
  max: number;
  end: number;
}

/** pattern[i]에서 시작하는 반복 연산자(*, +, ?, {n}, {n,}, {n,m})를 읽는다. 뒤의 ?(게으른)는 함께 소비한다. */
function readQuantifier(pattern: string, i: number): Quantifier | null {
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

// --- 워커: 사용자 정의 패턴을 시간 상한 안에서 실행 -------------------------------------------

// 워커 코드는 문자열로 둔다(ts-jest, tsx, 빌드 결과 어디서든 같은 방식으로 뜬다).
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, pattern, text }) => {
  let matched = false;
  try { matched = new RegExp(pattern).test(text); } catch { matched = false; }
  parentPort.postMessage({ id, matched });
});
parentPort.postMessage({ ready: true });
`;

type WorkerResult = { matched: boolean } | { timedOut: true };

let worker: Worker | null = null;
let workerReady: Promise<Worker> | null = null;
let workerSeq = 0;
// 요청은 한 번에 하나씩 워커에 보낸다(시간 측정이 앞선 요청의 대기 시간을 섞지 않게)
let workerChain: Promise<unknown> = Promise.resolve();

function acquireWorker(): Promise<Worker> {
  if (worker && workerReady) return workerReady;
  const w = new Worker(WORKER_SOURCE, { eval: true });
  w.unref();
  worker = w;
  const drop = () => {
    if (worker === w) {
      worker = null;
      workerReady = null;
    }
  };
  w.once('exit', drop);
  w.on('error', (err) => {
    logError('DLP worker error', err);
    drop();
  });
  const ready = new Promise<Worker>((resolve, reject) => {
    const onMsg = (m: { ready?: boolean }) => {
      if (!m.ready) return;
      w.off('message', onMsg);
      resolve(w);
    };
    w.on('message', onMsg);
    w.once('exit', () => reject(new Error('DLP worker exited before it was ready')));
  });
  workerReady = ready;
  return ready;
}

async function execInWorker(pattern: string, text: string, limitMs: number): Promise<WorkerResult> {
  if (limitMs <= 0) return { timedOut: true };
  let w: Worker;
  try {
    w = await acquireWorker(); // 시작 시간은 상한에 넣지 않는다
  } catch (err) {
    logError('DLP worker start failed', err);
    return { timedOut: true };
  }
  return new Promise<WorkerResult>((resolve) => {
    const id = ++workerSeq;
    const finish = (result: WorkerResult) => {
      clearTimeout(timer);
      w.off('message', onMsg);
      w.off('exit', onExit);
      resolve(result);
    };
    const onMsg = (m: { id?: number; matched?: boolean }) => {
      if (m.id === id) finish({ matched: m.matched === true });
    };
    const onExit = () => finish({ timedOut: true });
    // 시간 초과: 멈춘 워커는 죽이고 다음 요청이 새로 만든다
    const timer = setTimeout(() => {
      if (worker === w) {
        worker = null;
        workerReady = null;
      }
      void w.terminate();
      finish({ timedOut: true });
    }, limitMs);
    w.on('message', onMsg);
    w.once('exit', onExit);
    w.postMessage({ id, pattern, text });
  });
}

/** 패턴을 워커에서 실행한다. 요청은 직렬화되고, limitMs를 넘으면 { timedOut: true }. */
export function runPattern(pattern: string, text: string, limitMs: number = MESSAGE_BUDGET_MS): Promise<WorkerResult> {
  const task = workerChain.then(() => execInWorker(pattern, text, limitMs));
  workerChain = task.catch(() => undefined);
  return task;
}

/** 테스트용: 워커를 정리한다 */
export async function shutdownDlpWorker(): Promise<void> {
  const w = worker;
  worker = null;
  workerReady = null;
  if (w) await w.terminate();
}

// --- 규칙 캐시 ---------------------------------------------------------------------------------

interface BuiltinRule {
  id: number | null;
  name: string;
  action: DlpAction;
  detect: (text: string) => boolean;
}

interface CustomRule {
  id: number;
  name: string;
  action: DlpAction;
  pattern: string;
}

interface RuleSet {
  builtin: BuiltinRule[];
  custom: CustomRule[];
}

let cache: { rules: RuleSet; loadedAt: number } | null = null;
let loading: Promise<RuleSet> | null = null;
let generation = 0; // 규칙이 바뀌면 읽던 결과를 버리기 위한 세대 번호
let builtinsEnsured = false;

/** 규칙을 바꾼 뒤 부른다. 다음 검사가 DB에서 다시 읽는다. */
export function invalidateDlpCache(): void {
  generation++;
  cache = null;
  loading = null;
}

/**
 * 내장 규칙 행이 없으면 만든다(켜짐, 고정 action). 이미 있으면 패턴만 코드 기준으로 맞춘다.
 * 이름이 다른 규칙과 겹쳐 실패해도 메시지 전송을 막지 않는다(탐지는 행이 없어도 켜진 상태로 동작한다).
 */
export async function ensureBuiltinRules(): Promise<void> {
  for (const b of BUILTIN_RULES) {
    try {
      await prisma.dlpRule.upsert({
        where: { key: b.key },
        update: { pattern: b.pattern, builtin: true },
        create: { key: b.key, name: b.name, pattern: b.pattern, action: b.action, builtin: true, enabled: true },
      });
    } catch (error) {
      logError(`DLP built-in rule ${b.key} could not be saved`, error);
    }
  }
  builtinsEnsured = true;
}

/** 한 번만 보장한다(관리자 목록 조회가 매번 upsert하지 않게) */
export async function ensureBuiltinRulesOnce(): Promise<void> {
  if (!builtinsEnsured) await ensureBuiltinRules();
}

async function loadRules(): Promise<RuleSet> {
  await ensureBuiltinRulesOnce();
  const rows = await prisma.dlpRule.findMany({ orderBy: { id: 'asc' }, take: MAX_RULES + BUILTIN_RULES.length });
  const builtin: BuiltinRule[] = [];
  for (const def of BUILTIN_RULES) {
    // 행이 없으면(보장 실패) 기본값인 켜짐으로 동작한다
    const row = rows.find((r) => r.key === def.key);
    if (row && !row.enabled) continue;
    builtin.push({ id: row?.id ?? null, name: row?.name ?? def.name, action: def.action, detect: def.detect });
  }
  const custom: CustomRule[] = [];
  for (const row of rows) {
    if (row.builtin || row.key || !row.enabled) continue;
    // 저장된 뒤에 검증 규칙이 강화됐을 수 있으니 불러올 때도 다시 본다
    if (validatePattern(row.pattern) !== null) continue;
    custom.push({ id: row.id, name: row.name, action: row.action, pattern: row.pattern });
  }
  return { builtin, custom };
}

async function getRules(): Promise<RuleSet> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.rules;
  const gen = generation;
  // 동시에 여러 요청이 와도 읽기는 한 번
  if (!loading) {
    const p: Promise<RuleSet> = loadRules()
      .then((rules) => {
        if (gen === generation) cache = { rules, loadedAt: Date.now() };
        return rules;
      })
      .finally(() => {
        // 오래된 읽기가 늦게 끝나도 그 사이 새로 시작한 읽기(loading)를 지우지 않는다
        if (loading === p) loading = null;
      });
    loading = p;
  }
  return loading;
}

// --- 검사 --------------------------------------------------------------------------------------

export interface DlpHit {
  name: string;
  action: DlpAction;
}

// 규칙별 연속 시간 초과 횟수(프로세스 안)
const timeoutStreak = new Map<number, number>();

async function onRuleTimeout(rule: CustomRule, actorId: number | null): Promise<void> {
  const streak = (timeoutStreak.get(rule.id) ?? 0) + 1;
  timeoutStreak.set(rule.id, streak);
  await writeAuditLog({ action: 'dlp.rule_timeout', actorId, targetType: 'dlp_rule', targetId: rule.id, targetName: rule.name });
  if (streak >= AUTO_DISABLE_AFTER) {
    timeoutStreak.delete(rule.id);
    try {
      await prisma.dlpRule.updateMany({ where: { id: rule.id, enabled: true }, data: { enabled: false } });
    } catch (error) {
      logError('DLP rule auto-disable failed', error);
      return;
    }
    invalidateDlpCache();
    await writeAuditLog({ action: 'dlp.rule_auto_disabled', actorId, targetType: 'dlp_rule', targetId: rule.id, targetName: rule.name });
  }
}

/**
 * 켜진 규칙 중 content와 일치하는 것(이름과 action만). 사용자 정의 규칙은 메시지당 MESSAGE_BUDGET_MS 안에서만
 * 돌리고, 시간 초과한 규칙은 이번 메시지에서 건너뛴다(통과).
 */
export async function scanContent(content: string, actorId: number | null = null): Promise<DlpHit[]> {
  if (!content) return [];
  const rules = await getRules();
  const hits: DlpHit[] = [];
  for (const rule of rules.builtin) {
    if (rule.detect(content)) hits.push({ name: rule.name, action: rule.action });
  }
  const deadline = Date.now() + MESSAGE_BUDGET_MS;
  for (const rule of rules.custom) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break; // 예산을 다 썼다. 남은 규칙은 이번 메시지에서 건너뛴다
    const result = await runPattern(rule.pattern, content, remaining);
    if ('timedOut' in result) {
      await onRuleTimeout(rule, actorId);
      continue;
    }
    timeoutStreak.delete(rule.id);
    if (result.matched) hits.push({ name: rule.name, action: rule.action });
  }
  return hits;
}

export type DlpTarget = 'message' | 'direct_message';

/**
 * 저장 전 검사. BLOCK 규칙이 일치하면 감사 로그(dlp.blocked, 규칙 이름만)를 남기고 DlpBlockedError를 던진다.
 * 통과하면 WARN으로 일치한 규칙 이름을 돌려준다. 호출한 쪽은 저장 뒤 recordDlpWarnings에 넘긴다.
 */
export async function enforceDlp(userId: number, content: string, target: DlpTarget): Promise<string[]> {
  const hits = await scanContent(content, userId);
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

/**
 * 관리자 화면의 "패턴 테스트". 저장하지 않은 패턴(이미 검증을 통과한 것)은 워커에서, 내장 규칙은 탐지기로 돌린다.
 * timedOut이면 시간 상한을 넘었다는 뜻이다.
 */
export async function testPattern(pattern: string, sample: string): Promise<{ matched: boolean; timedOut?: true }> {
  const result = await runPattern(pattern, sample.slice(0, TEST_SAMPLE_MAX));
  return 'timedOut' in result ? { matched: false, timedOut: true } : result;
}

export function testBuiltin(key: string, sample: string): boolean | null {
  const def = BUILTIN_BY_KEY.get(key);
  return def ? def.detect(sample.slice(0, TEST_SAMPLE_MAX)) : null;
}

/** 테스트용 */
export function resetDlpStateForTests(): void {
  cache = null;
  loading = null;
  builtinsEnsured = false;
  timeoutStreak.clear();
}
