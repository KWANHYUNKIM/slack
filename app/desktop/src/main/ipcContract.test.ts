import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_CHANNELS, MAX_BADGE_COUNT, MAX_BODY_LENGTH, isSafeInAppPath, parseBadgeCount, parseNotifyPayload } from './ipcContract';
import { MESSAGES, format, pickLocale } from './messages';

test('preload의 채널 목록이 main 화이트리스트와 같다', () => {
  // dist/main/ipcContract.test.js 기준으로 src/preload/preload.ts를 읽는다
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload', 'preload.ts'), 'utf8');
  const block = /const CHANNELS = \{([\s\S]*?)\} as const;/.exec(source);
  assert.ok(block, 'preload에 CHANNELS 블록이 있어야 한다');
  const preloadChannels = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(preloadChannels, [...ALL_CHANNELS].sort());
  // preload가 ipcRenderer 자체를 노출하지 않는다
  assert.doesNotMatch(source, /exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/);
});

test('알림 인자 검증', () => {
  assert.deepEqual(parseNotifyPayload({ title: '#general', body: 'hi', path: '/c/1' }), { title: '#general', body: 'hi', path: '/c/1' });
  assert.deepEqual(parseNotifyPayload({ title: 'A' }), { title: 'A', body: '', path: null });
  assert.equal(parseNotifyPayload(null), null);
  assert.equal(parseNotifyPayload('title'), null);
  assert.equal(parseNotifyPayload([]), null);
  assert.equal(parseNotifyPayload({ title: '' }), null);
  assert.equal(parseNotifyPayload({ title: 1 }), null);
  assert.equal(parseNotifyPayload({ title: 'A', body: {} }), null);
  assert.equal(parseNotifyPayload({ title: 'A', path: 'https://evil.example.com' }), null);
  assert.equal(parseNotifyPayload({ title: 'A', path: '//evil.example.com' }), null);
  const long = parseNotifyPayload({ title: 'A', body: 'x'.repeat(5000) });
  assert.equal(long?.body.length, MAX_BODY_LENGTH);
});

test('앱 안 경로 검증', () => {
  for (const ok of ['/', '/c/1', '/d/2?m=3', '/g/4#x']) assert.equal(isSafeInAppPath(ok), true, ok);
  for (const bad of ['', 'c/1', '//evil.com', '/\\evil.com', 'javascript:alert(1)', '/c/1\n', '/a\\b', 1, null, '/'.padEnd(600, 'a')]) {
    assert.equal(isSafeInAppPath(bad), false, String(bad));
  }
});

test('배지 숫자 검증', () => {
  assert.equal(parseBadgeCount(0), 0);
  assert.equal(parseBadgeCount(7), 7);
  assert.equal(parseBadgeCount(1e9), MAX_BADGE_COUNT);
  for (const bad of [-1, 1.5, NaN, Infinity, '3', null, undefined, {}]) assert.equal(parseBadgeCount(bad), null, String(bad));
});

test('데스크톱 문구: en과 ko의 키가 같고 비어 있지 않다', () => {
  const enKeys = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES.ko).sort(), enKeys);
  for (const locale of ['en', 'ko'] as const) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) assert.ok(value.trim(), `${locale}:${key}`);
  }
  // 자리 표시자 이름도 같아야 한다
  for (const key of enKeys as (keyof typeof MESSAGES.en)[]) {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(MESSAGES.ko[key]), names(MESSAGES.en[key]), key);
  }
});

test('로캘 선택과 자리 표시자 채우기', () => {
  assert.equal(pickLocale(['ko-KR', 'en-US']), 'ko');
  assert.equal(pickLocale(['en-GB']), 'en');
  assert.equal(pickLocale(['fr-FR', 'ko']), 'ko');
  assert.equal(pickLocale(['fr-FR']), 'en');
  assert.equal(pickLocale([]), 'en');
  assert.equal(format('Could not reach {server}.', { server: 'https://a.example.com' }), 'Could not reach https://a.example.com.');
  assert.equal(format('{missing}', {}), '{missing}');
});
