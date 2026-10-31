import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 4xx/5xx 응답에는 항상 code가 있어야 한다(i18n-3). middleware/errorCode.ts 안전망은 `res.json({ error, ... })` 형태에만 code를 붙인다.
// 그래서 안전망을 지나지 않는 응답 모양(res.send, res.end, sendStatus, error 키 없는 json, 배열 본문)이 코드에 새로 생기면 이 검사가 실패한다.
// 정적 검사라 DB 없이 빠르게 돈다. 의도한 예외는 ALLOWED에 `파일:사유 조각`으로 적는다.
// 같은 파일의 `const NAME = { error, code }`(as const 가능)를 `.json(NAME)`으로 넘기는 것은 허용한다. 상수가 code를 이미 담고 있기 때문이다.

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'tests' ? [] : listSources(path.join(dir, e.name));
    return e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [];
  });
}

// 알려진 예외: 본문 없는 응답이거나 JSON-RPC처럼 형식이 정해진 응답
const ALLOWED: string[] = [
  'mcp/', // JSON-RPC 응답은 형식이 정해져 있어 안전망도 건드리지 않는다
];

interface Finding {
  where: string;
  why: string;
  snippet: string;
}

// `{` 위치부터 짝이 맞는 `}` 앞까지의 본문. 문자열 안의 괄호는 세지 않는다.
function objectBody(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

// 본문 최상위의 키 이름만 모은다. `error: '...'`, `'code': X`처럼 따옴표 키도 같게 본다. 중첩된 `{ error }`는 최상위가 아니다.
function topLevelKeys(body: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  let quote: string | null = null;
  let seg = '';
  const flush = () => {
    const key = seg.split(':')[0].trim().replace(/^['"`]|['"`]$/g, '');
    if (key) keys.add(key);
    seg = '';
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    seg += c;
    if (quote) {
      if (c === '\\') seg += body[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      seg = seg.slice(0, -1);
      flush();
    }
  }
  flush();
  return keys;
}

// 같은 파일에 `const NAME = { ... }`가 있고 최상위에 error와 code 키가 모두 있을 때만 참이다.
function isErrorCodeConst(text: string, name: string): boolean {
  const decl = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\{`).exec(text);
  if (!decl) return false;
  const body = objectBody(text, decl.index + decl[0].length - 1);
  if (body === null) return false;
  const keys = topLevelKeys(body);
  return keys.has('error') && keys.has('code');
}

// 한 파일의 소스 텍스트를 검사한다. rel은 SRC 기준 경로(보고 위치에 쓴다).
function scanSource(rel: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const re = /\.status\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const arg = m[1].trim();
    const line = text.slice(0, m.index).split('\n').length;
    const where = `${rel}:${line}`;
    const end = text.indexOf(';', m.index);
    const stmt = text.slice(m.index, end === -1 ? undefined : end + 1).replace(/\s+/g, ' ');
    if (!/^\d{3}$/.test(arg)) {
      // 서비스 결과의 상태(result.status, error.status)나 2xx 삼항은 값을 알 수 없다. 최소한 .json(...)으로 나가야 안전망이 본문을 볼 수 있다.
      if (!/^\.status\([^)]*\)\.json\(/.test(stmt)) {
        findings.push({ where, why: '상태 코드가 리터럴이 아니고 .json(...)으로 나가지도 않는다', snippet: stmt.slice(0, 120) });
      }
      continue;
    }
    if (!/^[45]/.test(arg)) continue;
    if (!/^\.status\(\d{3}\)\.json\(\{/.test(stmt)) {
      // 같은 파일의 error+code 상수는 이미 code를 담고 있으므로 허용한다. 그 밖의 식별자와 호출 결과는 위반이다.
      const konst = /^\.status\(\d{3}\)\.json\((\w+)\)/.exec(stmt);
      if (konst && isErrorCodeConst(text, konst[1])) continue;
      findings.push({ where, why: 'res.status(4xx/5xx).json({ ... }) 형태가 아니라 안전망을 지나지 않는다', snippet: stmt.slice(0, 120) });
    } else if (!/\berror\b\s*[:,}]/.test(stmt)) {
      findings.push({ where, why: '본문에 error 키가 없어 안전망이 code를 붙이지 않는다', snippet: stmt.slice(0, 120) });
    }
  }
  for (const sm of text.matchAll(/\bsendStatus\(/g)) {
    findings.push({ where: `${rel}:${text.slice(0, sm.index).split('\n').length}`, why: 'sendStatus는 본문에 code가 없다', snippet: 'sendStatus(' });
  }
  return findings;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of listSources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (ALLOWED.some((a) => rel.startsWith(a))) continue;
    findings.push(...scanSource(rel, fs.readFileSync(file, 'utf8')));
  }
  return findings;
}

describe('error responses carry a code (static check)', () => {
  it('every res.status(4xx/5xx) goes through res.json({ error, ... }) so errorCodeDefaults can add the code', () => {
    const findings = scan();
    expect(findings.map((f) => `${f.where}  ${f.why}  ${f.snippet}`)).toEqual([]);
  });

  it('the scanner flags the shapes that bypass the safety net', () => {
    // 검사기가 아무것도 못 잡는 채로 통과하지 않는지 확인한다(스캔 대상 소스가 실제로 있고 정규식이 동작해야 한다).
    expect(listSources(SRC).length).toBeGreaterThan(20);
    const sample = "res.status(400).send('bad');";
    expect(/^\.status\(\d{3}\)\.json\(\{/.test(sample.slice(sample.indexOf('.status')))).toBe(false);
    expect(scanSource('routes/sample.ts', sample)).toHaveLength(1);
  });
});

describe('scanner: 같은 파일의 error+code 상수 허용 규칙 (단위 테스트)', () => {
  const ALLOWED_CASES: Array<[string, string]> = [
    ['const 객체(error, code 모두 있음)를 .json(NAME)으로 넘김', "const MFA = { error: 'Login expired', code: ERR.MFA_TOKEN_INVALID };\nres.status(401).json(MFA);"],
    ['as const 선언, 들여쓴 함수 안, 따옴표 키와 쉼표가 든 값', "  const UNAVAILABLE = { 'error': 'Off, for now', 'code': ERR.MFA_UNAVAILABLE } as const;\n  res.status(503).json(UNAVAILABLE);"],
    ['여러 줄 선언(중첩 객체의 error·code는 무시하고 최상위 키만 본다)', 'const LIMIT = {\n  error: "Too many",\n  code: ERR.TOKEN_LIMIT_REACHED,\n  meta: { x: 1 },\n};\nres.status(409).json(LIMIT);'],
  ];
  it.each(ALLOWED_CASES)('허용: %s', (_label, text) => {
    expect(scanSource('routes/sample.ts', text)).toEqual([]);
  });

  const VIOLATION_CASES: Array<[string, string]> = [
    ['error만 있고 code가 없는 상수', "const X = { error: 'x' };\nres.status(400).json(X);"],
    ['code만 있고 error가 없는 상수', 'const X = { code: ERR.A };\nres.status(400).json(X);'],
    ['선언이 없는 식별자(다른 파일에서 가져온 값으로 볼 수 있다)', "import { body } from './x.js';\nres.status(400).json(body);"],
    ['let으로 선언한 변수(const가 아님)', "let X = { error: 'x', code: ERR.A };\nres.status(400).json(X);"],
    ['함수 호출 결과', 'res.status(400).json(makeError());'],
    ['error와 code가 중첩 객체 안에만 있는 상수', "const X = { meta: { error: 'x', code: ERR.A } };\nres.status(400).json(X);"],
  ];
  it.each(VIOLATION_CASES)('위반: %s', (_label, text) => {
    const findings = scanSource('routes/sample.ts', text);
    expect(findings).toHaveLength(1);
    expect(findings[0].why).toContain('안전망을 지나지 않는다');
  });
});
