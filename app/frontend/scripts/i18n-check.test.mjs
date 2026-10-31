import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
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

test('실제 번역 파일(ko, ja, zh-Hans, zh-Hant, es, fr, de, pt-BR, it, ru, uk, pl, nl, tr, sv, da)이 검사를 통과한다', () => {
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
    ['it', 2],
    ['ru', 2],
    ['uk', 2],
    ['pl', 2],
    ['nl', 2],
    ['tr', 2],
    ['sv', 2],
    ['da', 2],
  ]) {
    const { errors } = checkLocale(en, load(locale), { tier });
    assert.deepEqual(errors, [], `${locale} 오류`);
  }
});

// CLDR 복수형 규칙(docs/architecture/i18n.md 6-2): ru·uk·pl은 one/few/many/other 분기를, it은 one/other 분기를 쓴다.
// 검사기는 분기 "개수"가 아니라 인자 이름만 비교하므로, 분기가 달라도 인자 이름이 같으면 통과해야 한다.
test('CLDR 복수형 분기: 기준(en)의 one/other를 ru가 one/few/many/other로 늘려도 인자 이름이 같으면 통과한다', () => {
  const data = {
    ...complete(),
    'messages:count': '{count, plural, one {# ответ} few {# ответа} many {# ответов} other {# ответа}}',
  };
  assert.deepEqual(checkLocale(base, data, { tier: 2 }).errors, []);
  assert.deepEqual(checkLocale(base, data, { tier: 1 }).errors, []);
});

test('CLDR 복수형 분기 안에서도 인자 이름이 다르면 실패한다(few 분기의 {n})', () => {
  const data = {
    ...complete(),
    'messages:count': '{count, plural, one {# ответ} few {{n} ответа} many {# ответов} other {# ответа}}',
  };
  assert.match(checkLocale(base, data, { tier: 2 }).errors[0], /인자 불일치: messages:count/);
});

// 실제 파일의 복수형 선택자(one, few, many, other 등)를 모은다. 분기 본문은 재귀로 확인한다.
function pluralSelectors(message) {
  const found = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === TYPE.plural) {
        found.push(...Object.keys(node.options));
        for (const option of Object.values(node.options)) walk(option.value);
      } else if (node.type === TYPE.select) {
        for (const option of Object.values(node.options)) walk(option.value);
      } else if (node.type === TYPE.tag) {
        walk(node.children);
      }
    }
  };
  walk(parse(String(message), { ignoreTag: false }));
  return found;
}

test('CLDR 분기 키는 Intl.PluralRules가 그 로캘에 대해 내는 카테고리 안에만 있다', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..', 'src', 'locales');
  const expected = {
    it: ['one', 'many', 'other'],
    ru: ['few', 'many', 'one', 'other'],
    uk: ['few', 'many', 'one', 'other'],
    pl: ['few', 'many', 'one', 'other'],
    nl: ['one', 'other'],
    tr: ['one', 'other'],
    sv: ['one', 'other'],
    da: ['one', 'other'],
  };
  for (const [locale, categories] of Object.entries(expected)) {
    // Intl이 내는 카테고리와 규칙서 값이 같은지 먼저 확인한다(이 Node의 ICU 데이터 기준)
    const actual = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    assert.deepEqual([...actual].sort(), [...categories].sort(), `${locale} Intl 카테고리`);

    const dir = join(root, locale);
    const used = new Set();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const flat = flattenNamespaces({ [file.replace(/\.json$/, '')]: JSON.parse(readFileSync(join(dir, file), 'utf8')) });
      for (const value of Object.values(flat)) {
        for (const selector of pluralSelectors(value)) {
          used.add(selector);
          assert.ok(
            selector === 'other' || categories.includes(selector),
            `${locale} 분기 ${selector}는 CLDR 카테고리가 아니다: ${value}`,
          );
        }
      }
    }
    assert.ok(used.has('other'), `${locale}은 other 분기가 있어야 한다`);
  }
  // ru·uk·pl은 few/many 분기를 실제로 썼는지 확인한다(영어식 one/other만 복사하지 않았는지)
  for (const locale of ['ru', 'uk', 'pl']) {
    const dir = join(root, locale);
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    assert.match(text, /few \{/, `${locale} few 분기 없음`);
    assert.match(text, /many \{/, `${locale} many 분기 없음`);
  }
});
