import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 4xx/5xx 응답에는 항상 code가 있어야 한다(i18n-3). middleware/errorCode.ts 안전망은 `res.json({ error, ... })` 형태에만 code를 붙인다.
// 그래서 안전망을 지나지 않는 응답 모양(res.send, res.end, sendStatus, error 키 없는 json, 배열 본문)이 코드에 새로 생기면 이 검사가 실패한다.
// 정적 검사라 DB 없이 빠르게 돈다. 의도한 예외는 ALLOWED에 `파일:사유 조각`으로 적는다.

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

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of listSources(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (ALLOWED.some((a) => rel.startsWith(a))) continue;
    const text = fs.readFileSync(file, 'utf8');
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
        findings.push({ where, why: 'res.status(4xx/5xx).json({ ... }) 형태가 아니라 안전망을 지나지 않는다', snippet: stmt.slice(0, 120) });
      } else if (!/\berror\b\s*[:,}]/.test(stmt)) {
        findings.push({ where, why: '본문에 error 키가 없어 안전망이 code를 붙이지 않는다', snippet: stmt.slice(0, 120) });
      }
    }
    for (const sm of text.matchAll(/\bsendStatus\(/g)) {
      findings.push({ where: `${rel}:${text.slice(0, sm.index).split('\n').length}`, why: 'sendStatus는 본문에 code가 없다', snippet: 'sendStatus(' });
    }
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
  });
});
