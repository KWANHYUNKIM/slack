// en(원문)과 각 로캘 번역 파일을 비교한다. 규칙은 scripts/i18n-check-lib.mjs에 있다.
// 1등급(ko): 누락 키가 있으면 실패. 2등급(기계 번역 초안): 누락은 경고만, 나머지 오류는 실패.
// (docs/architecture/i18n.md 3절, docs/conventions/i18n.md)
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLocale, flattenNamespaces } from './i18n-check-lib.mjs';
import { isTier1Locale } from '../src/lib/i18n/tiers.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');

function load(locale) {
  const dir = join(root, locale);
  if (!existsSync(dir)) return {};
  const namespaces = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    namespaces[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  }
  return flattenNamespaces(namespaces);
}

const base = load('en');
let errors = 0;
let warnings = 0;

// .DS_Store 같은 파일은 무시하고 디렉터리만 로캘로 본다
const localeDirs = readdirSync(root).filter((l) => statSync(join(root, l)).isDirectory());

for (const locale of localeDirs.filter((l) => l !== 'en')) {
  const tier = isTier1Locale(locale) ? 1 : 2;
  const data = load(locale);
  const result = checkLocale(base, data, { tier });
  for (const p of result.errors) console.error(`[${locale}] ${p}`);
  for (const p of result.warnings) console.warn(`[${locale}] ${p}`);
  errors += result.errors.length;
  warnings += result.warnings.length;
  console.log(
    `${locale}: 키 ${Object.keys(data).length}/${Object.keys(base).length} (${tier === 1 ? '1등급' : '2등급, 누락은 경고만'})`,
  );
}

if (errors > 0) {
  console.error(`\ni18n:check 실패: 오류 ${errors}건, 경고 ${warnings}건`);
  process.exit(1);
}
console.log(`\ni18n:check 통과 (경고 ${warnings}건)`);
