import test from 'node:test';
import assert from 'node:assert/strict';
import { getDirection, RTL_LANGUAGES } from '../src/lib/i18n/direction.ts';

// 번역 파일이 있는 RTL 2등급(ar, he, fa)과 파일이 없는 RTL(ur)은 모두 dir=rtl이다.
test('RTL 언어(ar, he, fa, ur)는 rtl이고 나머지는 ltr이다', () => {
  for (const lng of ['ar', 'he', 'fa', 'ur']) {
    assert.equal(getDirection(lng), 'rtl', lng);
  }
  for (const lng of ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'pt-BR', 'hi', 'th', 'fil']) {
    assert.equal(getDirection(lng), 'ltr', lng);
  }
  assert.deepEqual([...RTL_LANGUAGES].sort(), ['ar', 'fa', 'he', 'ur']);
});

test('지역 태그(ar-EG, he-IL, fa-IR, ur-PK)도 기본 언어 코드로 방향을 정한다', () => {
  assert.equal(getDirection('ar-EG'), 'rtl');
  assert.equal(getDirection('he-IL'), 'rtl');
  assert.equal(getDirection('fa-IR'), 'rtl');
  assert.equal(getDirection('ur-PK'), 'rtl');
  assert.equal(getDirection('AR'), 'rtl');
});

// 언어를 바꿔가며 방향을 반복해서 확인한다(ar → en → he → ko → fa → ar).
test('언어를 바꿔 가며 방향이 따라 바뀌고 같은 결과를 반복한다', () => {
  const sequence = ['ar', 'en', 'he', 'ko', 'fa', 'ar'];
  const expected = ['rtl', 'ltr', 'rtl', 'ltr', 'rtl', 'rtl'];
  for (let round = 0; round < 3; round += 1) {
    sequence.forEach((lng, i) => {
      assert.equal(getDirection(lng), expected[i], `${lng} round ${round}`);
    });
  }
});
