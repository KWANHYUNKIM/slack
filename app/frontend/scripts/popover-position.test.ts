import test from 'node:test';
import assert from 'node:assert/strict';
import { alignInline } from '../src/lib/popoverPosition.ts';

const VIEW = 1000;

test('LTR: 앵커 오른쪽 끝에 팝오버 오른쪽 끝을 맞춘다', () => {
  assert.equal(alignInline({ left: 600, right: 700 }, 300, VIEW, false), 400);
});

test('LTR: 왼쪽으로 넘치면 앵커 왼쪽 끝에 맞춘다', () => {
  assert.equal(alignInline({ left: 20, right: 120 }, 300, VIEW, false), 20);
});

test('RTL: 앵커 왼쪽 끝에 팝오버 왼쪽 끝을 맞춘다(글줄 끝 방향으로 펼쳐진다)', () => {
  assert.equal(alignInline({ left: 100, right: 200 }, 300, VIEW, true), 100);
});

test('RTL: 오른쪽으로 넘치면 앵커 오른쪽 끝에 맞춘다', () => {
  assert.equal(alignInline({ left: 800, right: 900 }, 300, VIEW, true), 600);
});

test('어느 쪽도 안 맞으면 화면 안으로 끌어오고 음수가 되지 않는다', () => {
  assert.equal(alignInline({ left: 100, right: 200 }, 1200, VIEW, false), 0);
  assert.equal(alignInline({ left: 450, right: 550 }, 600, VIEW, true), 400);
});
