import readline from 'readline';
import { parseArgs } from 'util';
import { z } from 'zod';
import prisma from '../db.js';
import {
  BootstrapRejectedError, bootstrapIdentitySchema, createInitialOwner,
} from '../services/bootstrapService.js';
import { logError } from '../utils/logger.js';

// 빈 DB에 첫 OWNER를 만드는 운영용 CLI의 본체. 진입 파일은 scripts/create-owner.ts이고 실행만 맡는다.
//   node dist/scripts/create-owner.js --email <이메일> --name <이름>
// 비밀번호 입력 우선순위: TTY 숨김 프롬프트 → stdin 파이프 첫 줄 → BOOTSTRAP_OWNER_PASSWORD.
// stdin과 env가 둘 다 있으면 stdin을 쓰고 env를 무시했다고 경고한다. 비밀번호와 이메일은 출력하지 않는다.
// 사용자가 한 명이라도 있으면 거부한다.

const MAX_STDIN_BYTES = 1024;
export const STDIN_TIMEOUT_MS = 30_000;

export const EXIT_OK = 0;
export const EXIT_REJECTED = 1;
export const EXIT_INVALID = 2;
export const EXIT_ERROR = 3;
export const EXIT_INTERRUPTED = 130; // 128 + SIGINT, 셸 관례

export interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdinTimeoutMs?: number;
}

const USAGE = 'Usage: node dist/scripts/create-owner.js --email <email> --name <name>\n'
  + '  Password source, in order: hidden prompt on a terminal, first line of piped stdin, BOOTSTRAP_OWNER_PASSWORD.\n'
  + '  --email/--name may also come from BOOTSTRAP_OWNER_EMAIL/BOOTSTRAP_OWNER_NAME.\n';

const REFUSED = 'Refused: this workspace already has users. Ask an admin for an invite instead.\n';

class PromptAbortedError extends Error {}
class StdinTimeoutError extends Error {}

// 파이프 stdin의 첫 줄. 줄바꿈 없이 끝나면 남은 내용 전체, 아무것도 없이 끝나면 null이다.
// 열려만 있고 입력이 없으면 timeoutMs 뒤 StdinTimeoutError로 끝낸다(운영자가 멈춘 줄 모르고 기다리지 않게).
function readFirstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let data = '';
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.pause();
      fn();
    };
    const onData = (chunk: Buffer | string) => {
      data += chunk.toString();
      if (data.includes('\n') || data.length > MAX_STDIN_BYTES) {
        finish(() => resolve(data.split(/\r?\n/, 1)[0]));
      }
    };
    const onEnd = () => finish(() => resolve(data.length > 0 ? data.split(/\r?\n/, 1)[0] : null));
    const onError = (error: Error) => finish(() => reject(error));
    const timer = setTimeout(() => finish(() => reject(new StdinTimeoutError())), timeoutMs);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

// 입력한 글자를 화면에 되울리지 않는 프롬프트. readline의 출력만 막고 질문 문구는 직접 쓴다.
// Ctrl+C(SIGINT)나 입력 종료(Ctrl+D)면 PromptAbortedError로 끝낸다.
function promptHidden(question: string, io: CliIo): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: io.stdin, output: io.stdout, terminal: true });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      rl.close();
      io.stdout.write('\n');
      fn();
    };
    io.stdout.write(question);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.on('SIGINT', () => settle(() => reject(new PromptAbortedError())));
    rl.on('close', () => settle(() => reject(new PromptAbortedError())));
    rl.question('', (answer) => settle(() => resolve(answer)));
  });
}

type PasswordResult = { ok: true; password: string } | { ok: false; code: number; message: string };

async function readPassword(io: CliIo): Promise<PasswordResult> {
  const envPassword = io.env.BOOTSTRAP_OWNER_PASSWORD;
  const ignoreEnvWarning = 'Warning: BOOTSTRAP_OWNER_PASSWORD is set but ignored; using the password from %s.\n';

  if (io.stdin.isTTY) {
    if (envPassword) io.stderr.write(ignoreEnvWarning.replace('%s', 'the prompt'));
    const first = await promptHidden('Password: ', io);
    const second = await promptHidden('Confirm password: ', io);
    if (first !== second) return { ok: false, code: EXIT_INVALID, message: 'Passwords do not match.\n' };
    return { ok: true, password: first };
  }

  const piped = await readFirstLine(io.stdin, io.stdinTimeoutMs ?? STDIN_TIMEOUT_MS);
  if (piped !== null) {
    if (envPassword) io.stderr.write(ignoreEnvWarning.replace('%s', 'stdin'));
    return { ok: true, password: piped };
  }
  if (envPassword) return { ok: true, password: envPassword };
  return {
    ok: false,
    code: EXIT_INVALID,
    message: 'No password given. Run on a terminal, pipe it on stdin, or set BOOTSTRAP_OWNER_PASSWORD.\n',
  };
}

function writeIssues(io: CliIo, error: z.ZodError) {
  // 입력값 자체는 되울리지 않고 어떤 항목이 왜 틀렸는지만 보여 준다.
  for (const issue of error.issues) {
    io.stderr.write(`Invalid ${issue.path.join('.') || 'input'}: ${issue.message}\n`);
  }
}

export async function runCreateOwner(io: CliIo): Promise<number> {
  let values: { email?: string; name?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: io.argv,
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch {
    io.stderr.write(USAGE);
    return EXIT_INVALID;
  }
  if (values.help) {
    io.stdout.write(USAGE);
    return EXIT_OK;
  }

  const email = values.email ?? io.env.BOOTSTRAP_OWNER_EMAIL;
  const name = values.name ?? io.env.BOOTSTRAP_OWNER_NAME;
  if (!email || !name) {
    io.stderr.write(USAGE);
    return EXIT_INVALID;
  }

  // 비밀번호를 묻기 전에 이메일·이름과 사용자 수를 먼저 확인한다. 최종 판정은 서비스의 잠금 안에서 다시 한다.
  const identity = bootstrapIdentitySchema.safeParse({ email, name });
  if (!identity.success) {
    writeIssues(io, identity.error);
    return EXIT_INVALID;
  }
  if (await prisma.user.count() > 0) {
    io.stderr.write(REFUSED);
    return EXIT_REJECTED;
  }

  let result: PasswordResult;
  try {
    result = await readPassword(io);
  } catch (error) {
    if (error instanceof PromptAbortedError) {
      io.stderr.write('Aborted.\n');
      return EXIT_INTERRUPTED;
    }
    if (error instanceof StdinTimeoutError) {
      io.stderr.write('Timed out waiting for the password on stdin. Pipe it in, or close stdin (< /dev/null) to use BOOTSTRAP_OWNER_PASSWORD.\n');
      return EXIT_INVALID;
    }
    throw error;
  }
  if (!result.ok) {
    io.stderr.write(result.message);
    return result.code;
  }

  try {
    const owner = await createInitialOwner({ email, name, password: result.password });
    io.stdout.write(`Created OWNER account (id=${owner.id}). Sign in with the email you provided.\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof BootstrapRejectedError) {
      io.stderr.write(REFUSED);
      return EXIT_REJECTED;
    }
    if (error instanceof z.ZodError) {
      writeIssues(io, error);
      return EXIT_INVALID;
    }
    logError('Create owner error', error);
    return EXIT_ERROR;
  }
}

// 진입 파일이 부른다. 어떤 경로로 끝나든 DB 연결을 닫고 종료 코드를 돌려준다.
export async function main(): Promise<number> {
  let code = EXIT_ERROR;
  try {
    code = await runCreateOwner({
      argv: process.argv.slice(2),
      env: process.env,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    });
  } catch (error) {
    logError('Create owner error', error);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  return code;
}
