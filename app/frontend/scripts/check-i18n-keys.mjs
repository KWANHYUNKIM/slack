// en(원문)과 ko(1등급)의 번역 키 집합이 같은지 검사한다.
// 2등급 이하 로캘은 누락이 있어도 경고만 한다. (docs/conventions/i18n.md 6절)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const TIER1 = ['en', 'ko'];

function flatten(obj, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') Object.assign(out, flatten(value, path));
    else out[path] = value;
  }
  return out;
}

// ICU 인자 이름만 뽑아 en과 비교한다 ({name}, {count, plural, ...})
function placeholders(text) {
  const names = new Set();
  const re = /\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g;
  let m;
  while ((m = re.exec(String(text)))) names.add(m[1]);
  return [...names].sort().join(',');
}

function load(locale) {
  const dir = join(root, locale);
  const result = {};
  if (!existsSync(dir)) return result;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const ns = file.replace(/\.json$/, '');
    const flat = flatten(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    for (const [k, v] of Object.entries(flat)) result[`${ns}:${k}`] = v;
  }
  return result;
}

const base = load('en');
let errors = 0;
let warnings = 0;

for (const locale of readdirSync(root).filter((l) => l !== 'en')) {
  const strict = TIER1.includes(locale);
  const data = load(locale);
  const problems = [];
  for (const key of Object.keys(base)) {
    if (!(key in data)) problems.push(`누락: ${key}`);
    else if (String(data[key]).trim() === '') problems.push(`빈 값: ${key}`);
    else if (placeholders(base[key]) !== placeholders(data[key]))
      problems.push(`인자 불일치: ${key} (en={${placeholders(base[key])}} ${locale}={${placeholders(data[key])}})`);
  }
  for (const key of Object.keys(data)) {
    if (!(key in base)) problems.push(`en에 없는 키: ${key}`);
  }
  for (const p of problems) console[strict ? 'error' : 'warn'](`[${locale}] ${p}`);
  if (strict) errors += problems.length;
  else warnings += problems.length;
  console.log(`${locale}: 키 ${Object.keys(data).length}/${Object.keys(base).length} (${strict ? '1등급' : '경고만'})`);
}

if (errors > 0) {
  console.error(`\ni18n:check 실패: 오류 ${errors}건`);
  process.exit(1);
}
console.log(`\ni18n:check 통과 (경고 ${warnings}건)`);
