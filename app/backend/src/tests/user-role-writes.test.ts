import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 사용자 역할 쓰기는 services/workspaceService.ts의 setUserRole 하나로만 한다(E1a). 그래야 User.role, orgRole,
// 기본 워크스페이스 역할, 조직 주 소유자가 어긋나지 않는다. 코드에 User의 role을 직접 쓰는 곳이 새로 생기면 이 검사가 실패한다.
// error-code-coverage.test.ts와 같은 정적 검사라 DB 없이 돈다. 테스트 파일은 픽스처를 만들려고 직접 쓰므로 제외한다.

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = path.join(SRC, '..', 'prisma', 'seed.ts');
const ALLOWED_FILES = [path.join('services', 'workspaceService.ts')];

function listSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'tests' ? [] : listSources(path.join(dir, e.name));
    return e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [];
  });
}

// `(` 위치부터 짝이 맞는 `)`까지. 문자열 안의 괄호는 세지 않는다.
function callBody(text: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

const USER_WRITE = /\b\w+\.user\.(create|createMany|update|updateMany|upsert)\s*\(/g;
// `role: 값`(select의 `role: true`는 제외)과 축약형 `{ role }`, `, role,`
const ROLE_WRITE = /\brole\s*:(?!\s*(?:true|false)\b)|[{,]\s*role\s*[,}]/;
// raw SQL로 User.role을 쓰는 경우
const RAW_ROLE_WRITE = /(UPDATE\s+"User"\s+SET[^;`]*"role"\s*=|INSERT\s+INTO\s+"User"\s*\([^)]*"role")/i;

function findRoleWrites(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(USER_WRITE)) {
    const body = callBody(text, m.index! + m[0].length - 1);
    if (ROLE_WRITE.test(body)) found.push(body.slice(0, 120).replace(/\s+/g, ' '));
  }
  const raw = text.match(RAW_ROLE_WRITE);
  if (raw) found.push(raw[0].slice(0, 120));
  return found;
}

describe('User.role is written only through setUserRole', () => {
  it('detector catches direct writes and ignores selects', () => {
    expect(findRoleWrites(`await prisma.user.update({ where: { id }, data: { role } });`)).toHaveLength(1);
    expect(findRoleWrites(`tx.user.create({ data: { email, role: 'OWNER' } })`)).toHaveLength(1);
    expect(findRoleWrites(`db.user.updateMany({ data: { name, role: x } })`)).toHaveLength(1);
    expect(findRoleWrites('await tx.$executeRaw`UPDATE "User" SET "role" = ${r}`')).toHaveLength(1);
    expect(findRoleWrites(`tx.user.create({ data: { email }, select: { id: true, role: true } })`)).toHaveLength(0);
    expect(findRoleWrites(`prisma.channelMember.update({ data: { role } })`)).toHaveLength(0);
  });

  it('no source file outside workspaceService writes User.role directly', () => {
    const findings: string[] = [];
    for (const file of [...listSources(SRC), SEED]) {
      const rel = path.relative(SRC, file);
      if (ALLOWED_FILES.includes(rel)) continue;
      for (const hit of findRoleWrites(fs.readFileSync(file, 'utf8'))) findings.push(`${rel}: ${hit}`);
    }
    expect(findings).toEqual([]);
  });
});
