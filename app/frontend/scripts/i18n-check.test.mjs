import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLocale, flattenNamespaces } from './i18n-check-lib.mjs';

// 기준(en) 픽스처: 복수형, 인자, Trans 태그를 모두 넣는다
const base = flattenNamespaces({
  messages: {
    greet: 'Hi {name}',
    count: '{count, plural, one {# reply} other {# replies}}',
    hint: 'Press <kbd>Enter</kbd> to send',
    nested: { pick: '{g, select, male {{name} he} other {{name} they}}' },
  },
});

const complete = () => ({ ...base });

test('1등급(ko): 누락 키가 있으면 오류다', () => {
  const data = complete();
  delete data['messages:greet'];
  const { errors, warnings } = checkLocale(base, data, { tier: 1 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /누락: messages:greet/);
  assert.equal(warnings.length, 0);
});

test('2등급(ja): 누락 키는 경고만 하고 실패하지 않는다', () => {
  const data = complete();
  delete data['messages:greet'];
  const { errors, warnings } = checkLocale(base, data, { tier: 2 });
  assert.equal(errors.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /누락: messages:greet/);
});

test('2등급: en에 없는 키가 있으면 실패한다', () => {
  const data = { ...complete(), 'messages:extra': 'x' };
  const { errors } = checkLocale(base, data, { tier: 2 });
  assert.deepEqual(errors, ['en에 없는 키: messages:extra']);
});

test('2등급: ICU 자리표시자 이름이 다르면 실패한다', () => {
  const data = { ...complete(), 'messages:greet': '안녕 {user}' };
  const { errors } = checkLocale(base, data, { tier: 2 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /인자 불일치: messages:greet/);
});

test('2등급: 자리표시자를 빠뜨리면 실패한다', () => {
  const data = { ...complete(), 'messages:greet': 'こんにちは' };
  const { errors } = checkLocale(base, data, { tier: 2 });
  assert.match(errors[0], /인자 불일치: messages:greet/);
});

test('복수형 분기 수가 달라도(en 2개, 번역 1개) 인자 이름이 같으면 통과한다', () => {
  const data = { ...complete(), 'messages:count': '{count, plural, other {返信 #件}}' };
  assert.deepEqual(checkLocale(base, data, { tier: 2 }).errors, []);
});

test('복수형 인자 이름을 바꾸면 실패한다', () => {
  const data = { ...complete(), 'messages:count': '{n, plural, other {# 件}}' };
  assert.match(checkLocale(base, data, { tier: 2 }).errors[0], /인자 불일치: messages:count/);
});

test('Trans 태그가 en과 다르면 실패한다(<kbd> 대신 <strong>)', () => {
  const data = { ...complete(), 'messages:hint': '<strong>Enter</strong>로 보내기' };
  const { errors } = checkLocale(base, data, { tier: 2 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /태그 불일치: messages:hint/);
});

test('Trans 태그 본문은 번역해도 된다(태그 이름만 같으면 통과)', () => {
  const data = { ...complete(), 'messages:hint': '<kbd>Enter</kbd>キーで送信' };
  assert.deepEqual(checkLocale(base, data, { tier: 2 }).errors, []);
});

test('중첩 select 분기 안의 자리표시자도 비교한다', () => {
  const data = {
    ...complete(),
    'messages:nested.pick': '{g, select, male {{name} 그는} other {{name} 그들은}}',
  };
  assert.deepEqual(checkLocale(base, data, { tier: 2 }).errors, []);
  const bad = { ...complete(), 'messages:nested.pick': '{g, select, male {{who} 그는} other {{who} 그들은}}' };
  assert.match(checkLocale(base, bad, { tier: 2 }).errors[0], /인자 불일치/);
});

test('{{ 문법(i18next 기본)을 쓰면 실패한다', () => {
  const data = { ...complete(), 'messages:greet': '안녕 {{name}}' };
  assert.match(checkLocale(base, data, { tier: 2 }).errors[0], /'\{\{' 사용 금지/);
});

test('빈 문자열 값은 등급과 관계없이 실패한다', () => {
  const data = { ...complete(), 'messages:greet': '   ' };
  assert.match(checkLocale(base, data, { tier: 2 }).errors[0], /빈 값: messages:greet/);
});

test('실제 번역 파일(ko, ja, zh-Hans, zh-Hant, es, fr, de, pt-BR)이 검사를 통과한다', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', 'src', 'locales');
  const load = (locale) => {
    const dir = join(root, locale);
    const namespaces = {};
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      namespaces[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    }
    return flattenNamespaces(namespaces);
  };
  const en = load('en');
  for (const [locale, tier] of [
    ['ko', 1],
    ['ja', 2],
    ['zh-Hans', 2],
    ['zh-Hant', 2],
    ['es', 2],
    ['fr', 2],
    ['de', 2],
    ['pt-BR', 2],
  ]) {
    const { errors } = checkLocale(en, load(locale), { tier });
    assert.deepEqual(errors, [], `${locale} 오류`);
  }
});
