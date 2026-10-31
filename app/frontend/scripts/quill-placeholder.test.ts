import test from 'node:test';
import assert from 'node:assert/strict';
import { syncQuillPlaceholder } from '../src/lib/quillPlaceholder.ts';

// 언어를 en → ko → en으로 바꾸면 Quill root의 data-placeholder도 따라 바뀌어야 한다
test('언어를 바꾸면 placeholder 속성이 새 문구로 바뀐다', () => {
  const root = { dataset: { placeholder: 'Reply...' } as Record<string, string | undefined> };
  syncQuillPlaceholder(root, '답글 입력...');
  assert.equal(root.dataset.placeholder, '답글 입력...');
  syncQuillPlaceholder(root, 'Reply...');
  assert.equal(root.dataset.placeholder, 'Reply...');
});

test('같은 문구면 속성을 건드리지 않는다', () => {
  let writes = 0;
  const dataset: Record<string, string | undefined> = {};
  Object.defineProperty(dataset, 'placeholder', {
    get: () => 'Reply...',
    set: () => { writes += 1; },
  });
  syncQuillPlaceholder({ dataset }, 'Reply...');
  assert.equal(writes, 0);
});
