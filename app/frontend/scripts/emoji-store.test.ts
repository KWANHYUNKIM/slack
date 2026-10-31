import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmojiDataStore } from '../src/lib/emoji/emojiStore.ts';
import { replaceShortcodes, type EmojiMartData } from '../src/lib/emoji/emojiLookup.ts';

const DATA: EmojiMartData = {
  emojis: { smile: { name: 'Smiling Face', skins: [{ native: '😄' }] } },
  aliases: { grin: 'smile' },
};

test('로드가 실패하면 다음 호출에서 다시 시도해 성공한다', async () => {
  let calls = 0;
  const store = createEmojiDataStore(async () => {
    calls += 1;
    if (calls === 1) throw new Error('network');
    return DATA;
  });
  await assert.rejects(store.load(), /network/);
  assert.equal(store.getSnapshot(), null);
  assert.equal(await store.load(), DATA);
  assert.equal(calls, 2);
});

test('동시에 여러 번 load해도 loader는 한 번만 호출된다', async () => {
  let calls = 0;
  const store = createEmojiDataStore(async () => ((calls += 1), DATA));
  await Promise.all([store.load(), store.load(), store.load()]);
  assert.equal(calls, 1);
});

test('데이터가 먼저 로드된 뒤 마운트해도 스냅샷으로 바로 읽는다', async () => {
  const store = createEmojiDataStore(async () => DATA);
  await store.load();
  assert.equal(store.getSnapshot(), DATA);
  let notified = 0;
  store.subscribe(() => (notified += 1));
  await store.load(); // 이미 로드됨: 알림이 다시 오지 않는다
  assert.equal(notified, 0);
});

test('로드가 끝나면 구독자에게 알리고, 해제하면 알리지 않는다', async () => {
  const store = createEmojiDataStore(async () => DATA);
  let a = 0;
  let b = 0;
  store.subscribe(() => (a += 1));
  store.subscribe(() => (b += 1))();
  await store.load();
  assert.equal(a, 1);
  assert.equal(b, 0);
});

test('전송 직전: 데이터가 없으면 로드를 기다린 뒤 :단축코드:를 바꾼다', async () => {
  const store = createEmojiDataStore(() => new Promise((r) => setTimeout(() => r(DATA), 20)));
  assert.equal(await store.convertForSend('hi :smile: and :grin:'), 'hi 😄 and 😄');
});

test('전송 직전: 시간 안에 못 받으면 원문 그대로 보낸다', async () => {
  const store = createEmojiDataStore(() => new Promise((r) => setTimeout(() => r(DATA), 200)));
  assert.equal(await store.convertForSend('hi :smile:', 10), 'hi :smile:');
});

test('전송 직전: 로드가 실패해도 원문 그대로 보낸다', async () => {
  const store = createEmojiDataStore(async () => {
    throw new Error('x');
  });
  assert.equal(await store.convertForSend('hi :smile:'), 'hi :smile:');
});

test('전송 변환은 코드 스팬, 알 수 없는 코드, 단어 중간 콜론을 건드리지 않는다', () => {
  assert.equal(replaceShortcodes('`:smile:` :smile:', DATA), '`:smile:` 😄');
  assert.equal(replaceShortcodes('```\n:smile:\n```', DATA), '```\n:smile:\n```');
  assert.equal(replaceShortcodes(':nope: a:smile:', DATA), ':nope: a:smile:');
  assert.equal(replaceShortcodes('12:30:45', DATA), '12:30:45');
});
