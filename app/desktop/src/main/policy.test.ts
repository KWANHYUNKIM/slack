import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideNavigation,
  decideWindowOpen,
  isAllowedNavigation,
  isPermissionAllowed,
  isPrivateHost,
  isSafeExternalUrl,
  isSetupPageUrl,
  normalizeServerUrl,
  resolveSetupAsset,
  SETUP_URL,
} from './policy';

const SERVER = 'https://chat.example.com';

test('서버 주소: 스킴이 없으면 https를 붙이고 origin만 남긴다', () => {
  assert.deepEqual(normalizeServerUrl('chat.example.com'), { ok: true, origin: SERVER });
  assert.deepEqual(normalizeServerUrl('  https://chat.example.com/c/1?x=1#y  '), { ok: true, origin: SERVER });
  assert.deepEqual(normalizeServerUrl('HTTPS://Chat.Example.com:443/'), { ok: true, origin: SERVER });
  assert.deepEqual(normalizeServerUrl('https://chat.example.com:8443'), { ok: true, origin: 'https://chat.example.com:8443' });
});

test('서버 주소 단축 입력: 스킴이 없으면 내부망은 http, 공용 주소는 https', () => {
  // 호스트:포트를 스킴으로 오인하지 않는다
  assert.deepEqual(normalizeServerUrl('localhost:3000'), { ok: true, origin: 'http://localhost:3000' });
  assert.deepEqual(normalizeServerUrl('localhost'), { ok: true, origin: 'http://localhost' });
  assert.deepEqual(normalizeServerUrl('127.0.0.1:3100/c/1'), { ok: true, origin: 'http://127.0.0.1:3100' });
  assert.deepEqual(normalizeServerUrl('192.168.0.5:3000'), { ok: true, origin: 'http://192.168.0.5:3000' });
  assert.deepEqual(normalizeServerUrl('10.0.0.7'), { ok: true, origin: 'http://10.0.0.7' });
  assert.deepEqual(normalizeServerUrl('nas.local:8080'), { ok: true, origin: 'http://nas.local:8080' });
  assert.deepEqual(normalizeServerUrl('[::1]:3000'), { ok: true, origin: 'http://[::1]:3000' });
  assert.deepEqual(normalizeServerUrl('chat.example.com:8443'), { ok: true, origin: 'https://chat.example.com:8443' });
  assert.deepEqual(normalizeServerUrl('8.8.8.8:443'), { ok: true, origin: 'https://8.8.8.8' });
  assert.deepEqual(normalizeServerUrl('172.32.0.1:3000'), { ok: true, origin: 'https://172.32.0.1:3000' });
  // 스킴을 직접 적으면 그대로 따른다
  assert.deepEqual(normalizeServerUrl('https://localhost:3000'), { ok: true, origin: 'https://localhost:3000' });
  assert.deepEqual(normalizeServerUrl('http://localhost:3000'), { ok: true, origin: 'http://localhost:3000' });
});

test('서버 주소: http는 내부망에서만 허용한다', () => {
  assert.deepEqual(normalizeServerUrl('http://192.168.0.10:3000'), { ok: true, origin: 'http://192.168.0.10:3000' });
  assert.deepEqual(normalizeServerUrl('http://10.1.2.3'), { ok: true, origin: 'http://10.1.2.3' });
  assert.deepEqual(normalizeServerUrl('http://chat.local'), { ok: true, origin: 'http://chat.local' });
  assert.deepEqual(normalizeServerUrl('http://[::1]:3000'), { ok: true, origin: 'http://[::1]:3000' });
  assert.deepEqual(normalizeServerUrl('http://chat.example.com'), { ok: false, error: 'insecure' });
  assert.deepEqual(normalizeServerUrl('http://172.32.0.1'), { ok: false, error: 'insecure' });
  assert.deepEqual(normalizeServerUrl('http://8.8.8.8'), { ok: false, error: 'insecure' });
});

test('서버 주소: 잘못된 입력을 거부한다', () => {
  assert.deepEqual(normalizeServerUrl(''), { ok: false, error: 'empty' });
  assert.deepEqual(normalizeServerUrl('   '), { ok: false, error: 'empty' });
  assert.deepEqual(normalizeServerUrl(null), { ok: false, error: 'invalid' });
  assert.deepEqual(normalizeServerUrl(42), { ok: false, error: 'invalid' });
  assert.deepEqual(normalizeServerUrl('chat example.com'), { ok: false, error: 'invalid' });
  assert.deepEqual(normalizeServerUrl('x'.repeat(3000)), { ok: false, error: 'invalid' });
  assert.deepEqual(normalizeServerUrl('javascript:alert(1)'), { ok: false, error: 'scheme' });
  assert.deepEqual(normalizeServerUrl('file:///etc/passwd'), { ok: false, error: 'scheme' });
  assert.deepEqual(normalizeServerUrl('ftp://chat.example.com'), { ok: false, error: 'scheme' });
  assert.deepEqual(normalizeServerUrl('https://user:pw@chat.example.com'), { ok: false, error: 'credentials' });
});

test('내부망 판정', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', 'nas.local', '[::1]']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['example.com', '172.15.0.1', '192.169.0.1', '11.0.0.1', 'localhost.example.com']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('앱 안 이동: 저장한 origin과 정확히 같을 때만 허용한다', () => {
  assert.equal(isAllowedNavigation(`${SERVER}/c/1`, SERVER), true);
  assert.equal(isAllowedNavigation(SERVER, SERVER), true);
  assert.equal(isAllowedNavigation('https://evil.example.com/', SERVER), false);
  assert.equal(isAllowedNavigation('https://chat.example.com.evil.com/', SERVER), false);
  assert.equal(isAllowedNavigation('http://chat.example.com/', SERVER), false); // 스킴이 다르다
  assert.equal(isAllowedNavigation('https://chat.example.com:8443/', SERVER), false); // 포트가 다르다
  assert.equal(isAllowedNavigation('https://sub.chat.example.com/', SERVER), false);
  assert.equal(isAllowedNavigation('file:///etc/passwd', SERVER), false);
  assert.equal(isAllowedNavigation('javascript:alert(1)', SERVER), false);
  assert.equal(isAllowedNavigation('not a url', SERVER), false);
  assert.equal(isAllowedNavigation(`${SERVER}/c/1`, null), false); // 서버 미설정이면 모두 차단
  assert.equal(isAllowedNavigation(SETUP_URL, SERVER), false);
});

test('will-navigate 판정: 허용 / 브라우저로 / 버림', () => {
  assert.equal(decideNavigation(`${SERVER}/d/2`, SERVER), 'allow');
  assert.equal(decideNavigation('https://docs.example.org/page', SERVER), 'open-external');
  assert.equal(decideNavigation('http://other.example.org/', SERVER), 'open-external');
  assert.equal(decideNavigation('file:///Users/me/secret', SERVER), 'deny');
  assert.equal(decideNavigation('teammessenger://channel/1', SERVER), 'deny');
  assert.equal(decideNavigation('data:text/html,<script>alert(1)</script>', SERVER), 'deny');
  assert.equal(decideNavigation(`${SERVER}/`, null), 'open-external');
});

test('새 창은 만들지 않는다: http(s)만 브라우저로, 나머지는 버린다', () => {
  assert.equal(decideWindowOpen('https://example.org/'), 'open-external');
  assert.equal(decideWindowOpen(`${SERVER}/files/1`), 'open-external');
  assert.equal(decideWindowOpen('javascript:alert(1)'), 'deny');
  assert.equal(decideWindowOpen('file:///etc/hosts'), 'deny');
  assert.equal(decideWindowOpen('smb://server/share'), 'deny');
  assert.equal(decideWindowOpen('about:blank'), 'deny');
  assert.equal(decideWindowOpen(''), 'deny');
});

test('외부 열기는 http(s)만, 아이디·비밀번호가 든 주소는 거부', () => {
  assert.equal(isSafeExternalUrl('https://example.org'), true);
  assert.equal(isSafeExternalUrl('mailto:a@example.org'), false);
  assert.equal(isSafeExternalUrl('https://user:pw@example.org'), false);
  assert.equal(isSafeExternalUrl('vbscript:msgbox(1)'), false);
});

test('권한: 서버 origin의 알림·마이크·카메라만 허용한다', () => {
  assert.equal(isPermissionAllowed('notifications', `${SERVER}/c/1`, SERVER), true);
  assert.equal(isPermissionAllowed('media', `${SERVER}/`, SERVER, ['audio']), true);
  assert.equal(isPermissionAllowed('media', `${SERVER}/`, SERVER, ['audio', 'video']), true);
  assert.equal(isPermissionAllowed('media', `${SERVER}/`, SERVER, ['audio', 'screen']), false);
  assert.equal(isPermissionAllowed('notifications', 'https://evil.example.com/', SERVER), false);
  assert.equal(isPermissionAllowed('notifications', `${SERVER}/`, null), false);
  for (const p of ['geolocation', 'midi', 'midiSysex', 'openExternal', 'pointerLock', 'hid', 'serial', 'usb', 'display-capture', 'clipboard-read']) {
    assert.equal(isPermissionAllowed(p, `${SERVER}/`, SERVER), false, p);
  }
});

test('서버 주소 입력 화면 URL과 정적 파일 화이트리스트', () => {
  assert.equal(isSetupPageUrl(SETUP_URL), true);
  assert.equal(isSetupPageUrl('app://other/index.html'), false);
  assert.equal(isSetupPageUrl(`${SERVER}/index.html`), false);
  assert.equal(resolveSetupAsset(SETUP_URL), 'index.html');
  assert.equal(resolveSetupAsset('app://setup/setup.js'), 'setup.js');
  assert.equal(resolveSetupAsset('app://setup/setup.css?v=1'), 'setup.css');
  assert.equal(resolveSetupAsset('app://setup/../main/main.js'), null);
  assert.equal(resolveSetupAsset('app://setup/%2e%2e/main/main.js'), null);
  assert.equal(resolveSetupAsset('app://setup/preload.js'), null);
  assert.equal(resolveSetupAsset('app://setup/constructor'), null);
  assert.equal(resolveSetupAsset('app://other/index.html'), null);
});
