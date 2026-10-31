// tsc가 옮기지 않는 정적 파일(서버 주소 입력 화면의 html, css)을 dist로 복사한다.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['setup/index.html', 'setup/setup.css'];

for (const file of files) {
  const to = join(root, 'dist', file);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, 'src', file), to);
}
console.log(`copied ${files.length} static files`);
