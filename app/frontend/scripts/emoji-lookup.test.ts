import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEmojiIndex, buildEmojiMap, shortcodeToNative, type EmojiMartData } from '../src/lib/emoji/emojiLookup.ts';

const DATA: EmojiMartData = {
  emojis: {
    smile: { name: 'Smiling Face', skins: [{ native: '😄' }] },
    exploding_head: { name: 'Exploding Head', skins: [{ native: '🤯' }] },
    nothing: { name: 'No Skin' },
  },
  aliases: { grin: 'smile', ghost_alias: 'missing' },
};

test('단축코드는 네이티브 이모지로 바뀐다', () => {
  assert.equal(shortcodeToNative(DATA, 'smile'), '😄');
});

test('mind_blown 별칭은 exploding_head로 풀린다', () => {
  assert.equal(shortcodeToNative(DATA, 'mind_blown'), '🤯');
});

test('모르는 코드와 데이터 로드 전(null)에는 입력을 그대로 돌려준다', () => {
  assert.equal(shortcodeToNative(DATA, 'unknown_code'), 'unknown_code');
  assert.equal(shortcodeToNative(null, 'smile'), 'smile');
});

test('색인은 skin이 없는 항목과 대상이 없는 별칭을 건너뛴다', () => {
  const ids = buildEmojiIndex(DATA).map((e) => e.id);
  assert.deepEqual(ids, ['smile', 'exploding_head', 'grin']);
});

test(':grin: 같은 별칭도 맵에서 찾아 같은 이모지로 바뀐다', () => {
  const map = buildEmojiMap(buildEmojiIndex(DATA));
  assert.equal(map.get('grin')?.native, '😄');
  assert.equal(map.get('nothing'), undefined);
});
