import test from 'node:test';
import assert from 'node:assert/strict';
import { icuArgs } from './icu-args.mjs';

test('en plural 분기가 여러 개여도 ko의 other 하나와 인자가 같다', () => {
  const en = icuArgs('{count, plural, one {# reply} other {# replies}}');
  const ko = icuArgs('{count, plural, other {답글 #개}}');
  assert.equal(en, ko);
  assert.equal(en, 'count');
});

test('분기 본문 텍스트는 인자로 잡지 않는다', () => {
  assert.equal(icuArgs('{n, plural, one {a thing} other {things}}'), 'n');
});

test('select와 중첩 인자', () => {
  assert.equal(icuArgs('{g, select, male {{name} he} other {{name} they}}'), 'g,name');
});

test('인자가 다르면 구분된다', () => {
  assert.notEqual(icuArgs('Hi {name}'), icuArgs('Hi {user}'));
});
