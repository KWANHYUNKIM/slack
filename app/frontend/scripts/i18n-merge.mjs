// 번역 키를 en/ko 파일에 깊은 병합으로 추가한다 (여러 개발자가 같은 네임스페이스를 동시에 만져도 안전하게).
// 사용: node scripts/i18n-merge.mjs <ns> <en키.json> <ko키.json>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const [ns, enPath, koPath] = process.argv.slice(2);
if (!ns || !enPath || !koPath) {
  console.error('사용법: node scripts/i18n-merge.mjs <ns> <en.json> <ko.json>');
  process.exit(1);
}

function merge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object') {
      target[k] = merge(target[k] && typeof target[k] === 'object' ? target[k] : {}, v);
    } else target[k] = v;
  }
  return target;
}

for (const [locale, src] of [['en', enPath], ['ko', koPath]]) {
  const file = join(root, locale, `${ns}.json`);
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const merged = merge(current, JSON.parse(readFileSync(src, 'utf8')));
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
}
console.log(`${ns}: 병합 완료`);
