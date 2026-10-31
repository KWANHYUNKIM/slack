import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLocale } from '../src/lib/i18n/pickLocale.ts';

// 번역 파일이 있는 로캘은 en, ko 두 개인 상황을 흉내 낸다
const AVAILABLE = ['en', 'ko'];
const RTL = new Set(['ar', 'he', 'fa', 'ur']);
const baseOf = (tag: string) => tag.split('-')[0].toLowerCase();
const match = (tag: string) => (AVAILABLE.includes(baseOf(tag)) ? baseOf(tag) : null);
const resolve = (tag: string) => match(tag) ?? (RTL.has(baseOf(tag)) ? baseOf(tag) : null);
const pick = (stored: string | null, languages: string[]) =>
  pickLocale({ stored, languages, match, resolve, fallback: 'en' });

test("['ar-EG','ko-KR']이면 번역 파일이 있는 ko가 우선이다", () => {
  assert.equal(pick(null, ['ar-EG', 'ko-KR']), 'ko');
});

test("['ar-EG','en-US']이면 en이다(번역 있는 언어 우선)", () => {
  assert.equal(pick(null, ['ar-EG', 'en-US']), 'en');
});

test('번역 있는 언어가 하나도 없으면 두 번째 훑기에서 RTL 언어를 허용한다', () => {
  assert.equal(pick(null, ['ar-EG', 'xx']), 'ar');
  assert.equal(pick(null, ['he-IL']), 'he');
});

test('아무것도 맞지 않으면 en이다', () => {
  assert.equal(pick(null, ['xx', 'yy']), 'en');
  assert.equal(pick(null, []), 'en');
});

test('localStorage에 명시적으로 고른 값이 최우선이다(ar를 골랐으면 브라우저가 ko여도 ar)', () => {
  assert.equal(pick('ar', ['ko-KR']), 'ar');
  assert.equal(pick('ko', ['ar-EG']), 'ko');
});

test('localStorage 값이 알 수 없는 로캘이면 브라우저 언어로 넘어간다', () => {
  assert.equal(pick('xx', ['ko-KR']), 'ko');
});

// ar → en 전환 흐름: 선택 목록에 없는 현재 언어(ar)에서 en을 고르면 en으로 해석된다
test('ar에서 en으로 전환하면 en으로 해석된다', () => {
  assert.equal(pick('ar', []), 'ar');
  assert.equal(pick('en', ['ar-EG']), 'en');
});
