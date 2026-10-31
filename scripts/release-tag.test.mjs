// node --test scripts/release-tag.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTag, checkTag } from './release-tag.mjs';
import { detectSigning } from './release-sign.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('정식 태그', () => {
  assert.deepEqual(parseTag('v1.2.3'), { tag: 'v1.2.3', version: '1.2.3', prerelease: false });
  assert.equal(parseTag('v0.10.0').version, '0.10.0');
});

test('프리릴리스 태그 (SemVer 2.0)', () => {
  assert.deepEqual(parseTag('v1.2.3-rc.1'), { tag: 'v1.2.3-rc.1', version: '1.2.3-rc.1', prerelease: true });
  for (const ok of ['v2.0.0-beta', 'v1.0.0-0', 'v1.0.0-0.3.7', 'v1.0.0-x.7.z.92', 'v1.0.0-x-y-z', 'v1.0.0-alpha.0', 'v1.0.0-0a', 'v1.0.0-01a', 'v1.0.0-1-1']) {
    assert.equal(parseTag(ok).prerelease, true, ok);
  }
});

test('형식이 틀린 태그는 거부한다', () => {
  const bad = [
    'vfoo', 'v1', 'v1.2', '1.2.3', 'v01.2.3', 'v1.2.3.4', 'v1.2.3-', 'v1.2.3-rc..1', 'v1.2.3 ', 'v1.2.3\nx', '', undefined, null, 'refs/tags/v1.2.3',
    'v1.0.0-01', 'v1.0.0-rc.01', 'v1.0.0-00', 'v1.0.0-1.02', // 숫자 식별자 앞자리 0
    'v1.0.0+build', 'v1.0.0-rc.1+build.5', 'v1.0.0-rc.1.', 'v1.0.0-.rc', 'v1.0.0-rc_1', // build metadata와 잘못된 문자
  ];
  for (const t of bad) assert.throws(() => parseTag(t), /형식이 아니다/, String(t));
});

test('태그와 package.json 버전 비교', () => {
  assert.equal(checkTag('v0.2.0', '0.2.0').version, '0.2.0');
  assert.equal(checkTag('v0.2.0-rc.1', '0.2.0-rc.1').prerelease, true);
  assert.throws(() => checkTag('v0.2.0', '0.1.0'), /다르다/);
  assert.throws(() => checkTag('v0.2.0', '0.2.0-rc.1'), /다르다/);
});

test('OS별 서명 판정', () => {
  const win = { WIN_CSC_LINK: 'x', WIN_CSC_KEY_PASSWORD: 'y' };
  const mac = { CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y' };
  const apple = { APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' };
  const none = { sign: false, notarize: false };
  assert.deepEqual(detectSigning('windows', {}), none);
  assert.deepEqual(detectSigning('windows', win), { sign: true, notarize: false });
  assert.deepEqual(detectSigning('windows', { WIN_CSC_LINK: 'x' }), none); // 비밀번호 없음
  assert.deepEqual(detectSigning('windows', { ...mac, ...apple }), none); // mac 키는 Windows에 쓰지 않는다
  assert.deepEqual(detectSigning('macos', mac), { sign: true, notarize: false });
  assert.deepEqual(detectSigning('macos', { ...mac, ...apple }), { sign: true, notarize: true });
  assert.deepEqual(detectSigning('macos', apple), none); // 인증서 없이 Apple 키만 있으면 서명 안 함
  assert.deepEqual(detectSigning('macos', { ...win, CSC_LINK: '' }), none); // Windows 키는 mac에 쓰지 않는다
  assert.deepEqual(detectSigning('linux', { ...win, ...mac, ...apple }), none);
  assert.throws(() => detectSigning('plan9', {}), /알 수 없는/);
});

// gh를 흉내 내는 스크립트를 PATH 앞에 둬서 release-publish.sh의 호출 순서를 확인한다
function runPublish({ releaseExists, failUpload = false, prerelease = 'false' }) {
  const dir = mkdtempSync(join(tmpdir(), 'rel-'));
  const log = join(dir, 'calls.log');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env bash
echo "$*" >> "${log}"
if [ "$1 $2" = "release view" ]; then exit ${releaseExists ? 0 : 1}; fi
if [ "$1 $2" = "release upload" ] && [ "${failUpload}" = true ]; then exit 1; fi
exit 0
`);
  chmodSync(gh, 0o755);
  writeFileSync(log, '');
  const r = spawnSync('bash', [join(here, 'release-publish.sh'), 'a.exe', 'b.dmg'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RELEASE_TAG: 'v1.2.3', PRERELEASE: prerelease, GITHUB_REPOSITORY: 'o/r' },
    encoding: 'utf8',
  });
  return { status: r.status, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

test('게시 흐름: 릴리스가 없으면 draft로 만들고 올린 뒤 공개한다', () => {
  const { status, calls } = runPublish({ releaseExists: false });
  assert.equal(status, 0);
  assert.match(calls[0], /^release view v1\.2\.3/);
  assert.match(calls[1], /^release create v1\.2\.3 .*--draft/);
  assert.doesNotMatch(calls[1], /--prerelease/);
  assert.match(calls[2], /^release upload v1\.2\.3 a\.exe b\.dmg .*--clobber/);
  assert.match(calls[3], /^release edit v1\.2\.3 .*--draft=false/);
  assert.equal(calls.length, 4);
});

test('게시 흐름: release-please가 만든 draft가 있으면 새로 만들지 않는다', () => {
  const { status, calls } = runPublish({ releaseExists: true });
  assert.equal(status, 0);
  assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['release view', 'release upload', 'release edit']);
});

test('게시 흐름: 프리릴리스 태그는 --prerelease로 만든다', () => {
  const { calls } = runPublish({ releaseExists: false, prerelease: 'true' });
  assert.match(calls[1], /--prerelease/);
});

test('게시 흐름: 업로드가 실패하면 공개하지 않는다', () => {
  const { status, calls } = runPublish({ releaseExists: true, failUpload: true });
  assert.notEqual(status, 0);
  assert.ok(!calls.some((c) => c.startsWith('release edit')));
});
