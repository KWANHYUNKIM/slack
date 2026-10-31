import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/check-dist-cdn.sh');

/** 임시 dist를 만들고 파일 내용으로 스크립트를 돌린다. */
function run(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dist-cdn-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const p = join(dir, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    return spawnSync('bash', [script, dir], { cwd: root, encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CDN 도메인이 없으면 통과한다', () => {
  const r = run({ 'assets/index.js': 'console.log("hello", "/api/messages")' });
  assert.equal(r.status, 0, r.stderr);
});

test('jsdelivr 요청 문자열이 있으면 실패한다', () => {
  const r = run({ 'assets/index.js': 'fetch("https://cdn.jsdelivr.net/npm/foo@1/x.json")' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cdn\.jsdelivr\.net/);
});

test('웹폰트와 unpkg는 css, html에서도 잡는다', () => {
  const r = run({
    'index.html': '<link href="https://fonts.googleapis.com/css2?family=Lato">',
    'assets/app.css': '@import url(https://unpkg.com/x/y.css);',
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fonts\.googleapis\.com/);
  assert.match(r.stderr, /unpkg\.com/);
});

test('emoji-mart 폴백 문자열만 있으면 허용 목록으로 통과한다', () => {
  const body =
    'a=await e(`https://cdn.jsdelivr.net/npm/@emoji-mart/data@latest/sets/${v}/${s}.json`);' +
    'b=`https://cdn.jsdelivr.net/npm/@emoji-mart/data@latest/i18n/${l}.json`;' +
    'c=`https://cdn.jsdelivr.net/npm/emoji-datasource-${p.set}@15.0.1/img/${p.set}/64/${u}.png`;';
  const r = run({ 'assets/vendor.js': body });
  assert.equal(r.status, 0, r.stderr);
});

test('허용된 emoji-mart 문자열 옆에 다른 jsdelivr 요청이 있으면 실패한다', () => {
  const body =
    '`https://cdn.jsdelivr.net/npm/@emoji-mart/data@latest/sets/${v}/${s}.json`;' +
    'fetch("https://cdn.jsdelivr.net/npm/other-lib@1/data.json")';
  const r = run({ 'assets/vendor.js': body });
  assert.equal(r.status, 1);
});

test('허용 경로 밖의 파일에서는 emoji-mart 문자열도 실패한다', () => {
  const r = run({ 'src/main.js': '`https://cdn.jsdelivr.net/npm/@emoji-mart/data@latest/sets/${v}/${s}.json`' });
  assert.equal(r.status, 1);
});

test('검사 대상이 없으면 실패한다', () => {
  const r = spawnSync('bash', [script, join(tmpdir(), 'no-such-dist-dir-xyz')], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 1);
});
