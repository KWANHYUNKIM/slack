import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSettingsStore, parseSettings } from './settings';

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-messenger-desktop-'));
  return path.join(dir, 'nested', 'settings.json');
}

test('서버 주소 CRUD: 저장 → 조회 → 변경 → 초기화를 반복한다', () => {
  const file = tempFile();
  for (let round = 0; round < 3; round += 1) {
    // Read (처음): 없음
    assert.equal(createSettingsStore(file).getServerUrl(), null);

    // Create
    const created = createSettingsStore(file).setServerUrl('chat.example.com/some/path');
    assert.deepEqual(created, { ok: true, serverUrl: 'https://chat.example.com' });
    // Read: 새 인스턴스(앱 재시작)에서도 남아 있다
    assert.equal(createSettingsStore(file).getServerUrl(), 'https://chat.example.com');

    // Update
    const store = createSettingsStore(file);
    assert.deepEqual(store.setServerUrl('http://192.168.0.5:3000'), { ok: true, serverUrl: 'http://192.168.0.5:3000' });
    assert.equal(createSettingsStore(file).getServerUrl(), 'http://192.168.0.5:3000');
    assert.equal(store.getServerUrl(), 'http://192.168.0.5:3000'); // 같은 인스턴스(메모리 캐시)도 바로 바뀐다

    // Update 실패: 기존 값은 그대로
    assert.deepEqual(store.setServerUrl('http://public.example.com'), { ok: false, error: 'insecure' });
    assert.deepEqual(store.setServerUrl('javascript:alert(1)'), { ok: false, error: 'scheme' });
    assert.deepEqual(store.setServerUrl(''), { ok: false, error: 'empty' });
    assert.equal(createSettingsStore(file).getServerUrl(), 'http://192.168.0.5:3000');

    // Delete
    store.clearServerUrl();
    assert.equal(createSettingsStore(file).getServerUrl(), null);
    assert.equal(store.getServerUrl(), null);
  }
});

test('설정 파일은 본인만 읽을 수 있게 쓴다 (0600)', { skip: process.platform === 'win32' }, () => {
  const file = tempFile();
  createSettingsStore(file).setServerUrl('chat.example.com');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']); // 임시 파일이 남지 않는다
});

test('깨진 파일이나 손으로 고친 값은 무시하고 기본값으로 읽는다', () => {
  assert.equal(parseSettings('not json').serverUrl, null);
  assert.equal(parseSettings('null').serverUrl, null);
  assert.equal(parseSettings('{"version":2,"serverUrl":"https://a.example.com"}').serverUrl, null);
  assert.equal(parseSettings('{"version":1,"serverUrl":"javascript:alert(1)"}').serverUrl, null);
  assert.equal(parseSettings('{"version":1,"serverUrl":"http://public.example.com"}').serverUrl, null);
  assert.equal(parseSettings('{"version":1,"serverUrl":"https://a.example.com/path"}').serverUrl, null);
  assert.equal(parseSettings('{"version":1,"serverUrl":123}').serverUrl, null);
  assert.equal(parseSettings('{"version":1,"serverUrl":"https://a.example.com"}').serverUrl, 'https://a.example.com');

  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ broken');
  assert.equal(createSettingsStore(file).getServerUrl(), null);
});
