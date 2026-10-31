import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversationPath, buildPermalink, buildPermalinkPath, isId, parsePermalink, type PermalinkTarget } from '../src/lib/permalink.ts';

const ORIGIN = 'http://localhost:5173';

const CASES: Array<[string, PermalinkTarget, string]> = [
  ['channel', { kind: 'channel', conversationId: 3, messageId: 42 }, '/c/3/m/42'],
  ['dm', { kind: 'dm', conversationId: 7, messageId: 9 }, '/d/7/m/9'],
  ['group', { kind: 'group', conversationId: 5, messageId: 11 }, '/g/5/m/11'],
  ['thread reply', { kind: 'channel', conversationId: 3, messageId: 42, replyId: 50 }, '/c/3/m/42?reply=50'],
];

for (const [name, target, path] of CASES) {
  test(`${name}: 생성과 해석이 왕복한다`, () => {
    assert.equal(buildPermalinkPath(target), path);
    assert.equal(buildPermalink(target, ORIGIN), `${ORIGIN}${path}`);
    assert.deepEqual(parsePermalink(`${ORIGIN}${path}`, ORIGIN), target);
    assert.deepEqual(parsePermalink(path, ORIGIN), target);
  });
}

test('다른 origin의 링크는 우리 퍼말링크가 아니다', () => {
  assert.equal(parsePermalink('https://evil.example/c/3/m/42', ORIGIN), null);
});

test('형식이 다르거나 id가 올바르지 않으면 null', () => {
  for (const bad of ['/c/3', '/x/3/m/4', '/c/0/m/4', '/c/3/m/0', '/c/a/m/4', '/c/3/m/4/extra', 'not a url \u0000']) {
    assert.equal(parsePermalink(bad, ORIGIN), null, bad);
  }
});

test('올바르지 않은 reply는 무시한다', () => {
  assert.deepEqual(parsePermalink('/c/3/m/42?reply=abc', ORIGIN), { kind: 'channel', conversationId: 3, messageId: 42 });
});

test('대화 주소와 id 검사', () => {
  assert.equal(buildConversationPath({ kind: 'channel', conversationId: 3 }), '/c/3');
  assert.equal(buildConversationPath({ kind: 'dm', conversationId: 7 }), '/d/7');
  assert.equal(buildConversationPath({ kind: 'group', conversationId: 5 }), '/g/5');
  assert.equal(isId(1), true);
  assert.equal(isId(0), false);
  assert.equal(isId(1.5), false);
  assert.equal(isId(Number('x')), false);
});
