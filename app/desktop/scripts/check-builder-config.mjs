// electron-builder 설정을 패키징 없이 검사한다.
// 1) electron-builder 자체 스키마 검증  2) 이 프로젝트가 지켜야 할 값(Fuses, 대상, 아이콘, 업로드 없음) 확인
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
const { DebugLogger } = require('builder-util');

const config = await getConfig(root, join(root, 'electron-builder.yml'), null);
await validateConfiguration(config, new DebugLogger(false));

const fuses = config.electronFuses;
assert.deepEqual(
  {
    runAsNode: fuses?.runAsNode,
    enableCookieEncryption: fuses?.enableCookieEncryption,
    enableNodeOptionsEnvironmentVariable: fuses?.enableNodeOptionsEnvironmentVariable,
    enableNodeCliInspectArguments: fuses?.enableNodeCliInspectArguments,
    enableEmbeddedAsarIntegrityValidation: fuses?.enableEmbeddedAsarIntegrityValidation,
    onlyLoadAppFromAsar: fuses?.onlyLoadAppFromAsar,
    grantFileProtocolExtraPrivileges: fuses?.grantFileProtocolExtraPrivileges,
  },
  {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  'Electron Fuses 값이 보안 기본값과 다르다',
);
assert.equal(config.asar, true, 'asar를 켜야 한다(onlyLoadAppFromAsar)');
const targets = (list) => list.map((t) => (typeof t === 'string' ? t : t.target));
assert.deepEqual(targets(config.mac.target), ['dmg']);
assert.deepEqual(targets(config.win.target), ['nsis', 'portable']);
assert.deepEqual(targets(config.linux.target), ['AppImage']);
assert.equal(config.publish, null, '업데이트 피드는 D2 범위라 아직 비워 둔다');
const fileFilters = config.files.flatMap((f) => (typeof f === 'string' ? [f] : f.filter ?? []));
assert.ok(fileFilters.includes('!dist/**/*.test.js'), '테스트 파일은 설치 파일에 넣지 않는다');
for (const icon of [config.mac.icon, config.win.icon, config.linux.icon]) {
  assert.ok(existsSync(join(root, icon)), `아이콘이 없다: ${icon}`);
}
console.log('OK: electron-builder 설정 검증 통과');
