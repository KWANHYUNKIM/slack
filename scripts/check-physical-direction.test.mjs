import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/check-physical-direction.sh');

/** 임시 파일 하나를 만들어 검사 스크립트를 돌린다. */
function run(name, body) {
  const dir = mkdtempSync(join(tmpdir(), 'phys-dir-'));
  try {
    const p = join(dir, name);
    writeFileSync(p, body);
    return spawnSync('bash', [script, p], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const BAD_CLASSES = [
  'ml-2', 'mr-4', 'pl-3', 'pr-6', 'left-0', 'right-5', '-left-1', 'md:right-0', 'hover:ml-auto',
  'text-left', 'text-right', 'border-l', 'border-r-4', 'rounded-l-md', 'rounded-tr', 'float-right', 'scroll-ml-2',
];

for (const cls of BAD_CLASSES) {
  test(`물리 방향 클래스 ${cls}를 잡는다`, () => {
    const r = run('a.tsx', `export const A = () => <div className="flex ${cls} gap-2" />;\n`);
    assert.equal(r.status, 1, `${cls} 통과함: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

test('cn() 문자열과 템플릿 리터럴 안의 클래스도 잡는다', () => {
  assert.equal(run('a.tsx', "const c = cn('absolute bottom-0 right-0 block');\n").status, 1);
  assert.equal(run('a.tsx', 'const c = `px-2 ${on ? "pl-6" : ""}`;\n').status, 1);
});

test('논리 속성과 space-x, inset-x는 통과한다', () => {
  const good = [
    'ms-2 me-4 ps-3 pe-6 start-0 end-5 text-start text-end border-s border-e-4 rounded-s-md rounded-ee',
    'flex -space-x-1.5 inset-x-0 rtl:-scale-x-100 rtl:translate-x-full -translate-x-1/2 mx-auto px-2',
  ];
  for (const g of good) {
    const r = run('a.tsx', `export const A = () => <div className="${g}" />;\n`);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('주석, JS 좌표(left: number), 일반 영어 단어는 오탐하지 않는다', () => {
  const body = [
    '// ml-2 같은 클래스를 쓰지 않는다',
    '/* pl-3 */',
    'const [pos, setPos] = useState<{ top: number; left: number } | null>(null);',
    "setPos({ top: rect.top, left: rect.left + 4 });",
    "const right = anchorRect.right - width; // right boundary",
    'const msg = "turn right at the corner, left over";',
  ].join('\n');
  const r = run('a.tsx', body + '\n');
  assert.equal(r.status, 0, r.stderr);
});

test('physical-ok 주석이 있는 줄은 허용한다', () => {
  const r = run('a.tsx', 'const c = "left-0"; // physical-ok: 고정 좌표\n');
  assert.equal(r.status, 0, r.stderr);
});

test('CSS 물리 속성을 잡고 논리 속성은 통과한다', () => {
  assert.equal(run('a.css', '.a { border-left: 4px solid red; }\n').status, 1);
  assert.equal(run('a.css', '.a { padding-right: 8px; }\n').status, 1);
  assert.equal(run('a.css', '.a { text-align: left; }\n').status, 1);
  assert.equal(run('a.css', '.a {\n  left: 12px;\n}\n').status, 1);
  assert.equal(run('a.css', '.a { border-inline-start: 4px solid red; padding-inline: 8px; inset-inline: 12px; }\n').status, 0);
});

test('실제 소스 전체가 검사를 통과한다', () => {
  const r = spawnSync('bash', [script], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
