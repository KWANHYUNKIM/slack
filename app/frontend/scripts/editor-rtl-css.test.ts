import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Quill 에디터의 RTL 정렬을 CSS 텍스트 기준으로 확인한다(브라우저 없이).
const css = readFileSync(fileURLToPath(new URL('../src/index.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 선택자 문자열이 들어 있는 규칙 블록 본문을 모두 모은다 */
function blocks(selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    if (m[1].split(',').some((s) => s.trim() === selector)) out.push(m[2]);
  }
  return out;
}

test('에디터 본문은 text-align: start라 RTL에서 오른쪽에 붙는다', () => {
  const body = blocks('.slawk-editor .ql-editor').join('\n');
  assert.match(body, /text-align:\s*start/);
});

test('blockquote는 Quill보다 높은 선택자로 물리 속성을 지운 뒤 논리 속성을 쓴다', () => {
  const body = blocks('.slawk-editor .ql-snow .ql-editor blockquote').join('\n');
  assert.match(body, /border-left:\s*none/);
  assert.match(body, /border-right:\s*none/);
  assert.match(body, /padding-left:\s*0/);
  assert.match(body, /padding-right:\s*0/);
  // 물리 초기화가 논리 속성보다 앞에 와야 논리 속성이 이긴다
  assert.ok(body.indexOf('border-left') < body.indexOf('border-inline-start'));
  assert.ok(body.indexOf('padding-left') < body.indexOf('padding-inline-start'));
});

test('목록 ol/li와 마커는 논리 속성으로 덮어쓴다', () => {
  const ol = blocks('.slawk-editor .ql-snow .ql-editor ol').join('\n');
  assert.match(ol, /padding-inline-start:\s*1\.5em/);
  const li = blocks('.slawk-editor .ql-snow .ql-editor li').join('\n');
  assert.match(li, /padding-inline-start:\s*1\.5em/);
  const marker = blocks('.slawk-editor .ql-snow .ql-editor li > .ql-ui:before').join('\n');
  assert.match(marker, /margin-inline-start:\s*-1\.5em/);
  assert.match(marker, /margin-inline-end:\s*0\.3em/);
  assert.match(marker, /text-align:\s*end/);
});

test('들여쓰기 1~9단계가 모두 논리 속성으로 덮여 있다', () => {
  for (let n = 1; n <= 9; n++) {
    const sel = `.slawk-editor .ql-snow .ql-editor li.ql-indent-${n}:not(.ql-direction-rtl)`;
    assert.match(blocks(sel).join('\n'), /padding-inline-start:/, sel);
  }
});

test('placeholder는 inset-inline으로 양쪽 대칭이다', () => {
  assert.match(blocks('.slawk-editor .ql-editor.ql-blank::before').join('\n'), /inset-inline:\s*12px/);
});
