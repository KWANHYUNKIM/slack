// db.js가 DATABASE_URL을 읽기 전에 .env를 불러온다(로컬 실행용, 컨테이너는 환경 변수를 그대로 쓴다).
import 'dotenv/config';
import readline from 'readline';
import { pathToFileURL } from 'url';
import { parseArgs } from 'util';
import { z } from 'zod';
import prisma from '../db.js';
import { BootstrapRejectedError, createInitialOwner } from '../services/bootstrapService.js';
import { logError } from '../utils/logger.js';

// 빈 DB에 첫 OWNER를 만드는 운영용 CLI. 운영 이미지에는 tsx(시드)가 없으므로 dist로 컴파일된 이 파일을 쓴다.
//   node dist/scripts/create-owner.js --email <이메일> --name <이름>
// 비밀번호는 터미널이면 숨김 입력으로 받고, 파이프면 stdin 첫 줄, 둘 다 아니면 BOOTSTRAP_OWNER_PASSWORD에서 읽는다.
// 사용자가 한 명이라도 있으면 거부한다. 비밀번호와 이메일은 출력하지 않는다.

const MAX_STDIN_BYTES = 1024;

export const EXIT_OK = 0;
export const EXIT_REJECTED = 1;
export const EXIT_INVALID = 2;
export const EXIT_ERROR = 3;

interface CliIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const USAGE = 'Usage: node dist/scripts/create-owner.js --email <email> --name <name>\n'
  + '  Password: hidden prompt on a terminal, first line of stdin when piped, or BOOTSTRAP_OWNER_PASSWORD.\n';

async function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  let data = '';
  for await (const chunk of stream) {
    data += chunk.toString();
    if (data.length > MAX_STDIN_BYTES || data.includes('\n')) break;
  }
  return data.split(/\r?\n/, 1)[0];
}

// 입력한 글자를 화면에 되울리지 않는 프롬프트. readline의 출력만 막고 질문 문구는 직접 쓴다.
function promptHidden(question: string, io: CliIo): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: io.stdin, output: io.stdout, terminal: true });
    io.stdout.write(question);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      io.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function readPassword(io: CliIo): Promise<string | null> {
  if (io.stdin.isTTY) {
    const first = await promptHidden('Password: ', io);
    const second = await promptHidden('Confirm password: ', io);
    return first === second ? first : null;
  }
  if (io.env.BOOTSTRAP_OWNER_PASSWORD) {
    return io.env.BOOTSTRAP_OWNER_PASSWORD;
  }
  return readFirstLine(io.stdin);
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

  // 비밀번호를 묻기 전에 막을 수 있으면 막는다. 최종 판정은 서비스의 잠금 안에서 다시 한다.
  if (await prisma.user.count() > 0) {
    io.stderr.write('Refused: this workspace already has users. Ask an admin for an invite instead.\n');
    return EXIT_REJECTED;
  }

  const password = await readPassword(io);
  if (password === null) {
    io.stderr.write('Passwords do not match.\n');
    return EXIT_INVALID;
  }

  try {
    const owner = await createInitialOwner({ email, name, password });
    io.stdout.write(`Created OWNER account (id=${owner.id}). Sign in with the email you provided.\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof BootstrapRejectedError) {
      io.stderr.write('Refused: this workspace already has users. Ask an admin for an invite instead.\n');
      return EXIT_REJECTED;
    }
    if (error instanceof z.ZodError) {
      // 입력값 자체는 되울리지 않고 어떤 항목이 왜 틀렸는지만 보여 준다.
      for (const issue of error.issues) {
        io.stderr.write(`Invalid ${issue.path.join('.') || 'input'}: ${issue.message}\n`);
      }
      return EXIT_INVALID;
    }
    logError('Create owner error', error);
    return EXIT_ERROR;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCreateOwner({
    argv: process.argv.slice(2),
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .then(async (code) => {
      await prisma.$disconnect();
      process.exit(code);
    })
    .catch(async (error) => {
      logError('Create owner error', error);
      await prisma.$disconnect();
      process.exit(EXIT_ERROR);
    });
}
