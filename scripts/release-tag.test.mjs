// node --test scripts/release-tag.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTag, checkTag } from './release-tag.mjs';

test('정식 태그', () => {
  assert.deepEqual(parseTag('v1.2.3'), { tag: 'v1.2.3', version: '1.2.3', prerelease: false });
  assert.equal(parseTag('v0.10.0').version, '0.10.0');
});

test('프리릴리스 태그', () => {
  assert.deepEqual(parseTag('v1.2.3-rc.1'), { tag: 'v1.2.3-rc.1', version: '1.2.3-rc.1', prerelease: true });
  assert.equal(parseTag('v2.0.0-beta').prerelease, true);
});

test('형식이 틀린 태그는 거부한다', () => {
  const bad = ['vfoo', 'v1', 'v1.2', '1.2.3', 'v01.2.3', 'v1.2.3.4', 'v1.2.3-', 'v1.2.3-rc..1', 'v1.2.3 ', 'v1.2.3\nx', '', undefined, null, 'refs/tags/v1.2.3'];
  for (const t of bad) assert.throws(() => parseTag(t), /형식이 아니다/, String(t));
});

test('태그와 package.json 버전 비교', () => {
  assert.equal(checkTag('v0.2.0', '0.2.0').version, '0.2.0');
  assert.equal(checkTag('v0.2.0-rc.1', '0.2.0-rc.1').prerelease, true);
  assert.throws(() => checkTag('v0.2.0', '0.1.0'), /다르다/);
  assert.throws(() => checkTag('v0.2.0', '0.2.0-rc.1'), /다르다/);
});
