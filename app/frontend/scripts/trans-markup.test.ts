import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Trans, I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import ICU from 'i18next-icu';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 번역 문자열의 태그(<bold>, <kbd>)가 en·ko 모두에서 실제 요소로 렌더링되는지 확인한다.
// 번역 파일을 직접 읽어 리소스로 넣으므로 실제 번역 값이 그대로 검사된다.
const here = dirname(fileURLToPath(import.meta.url));
const load = (locale: string, ns: string) =>
  JSON.parse(readFileSync(join(here, `../src/locales/${locale}/${ns}.json`), 'utf8'));

async function instanceFor(locale: string) {
  const instance = i18next.createInstance();
  await instance.use(ICU).init({
    lng: locale,
    fallbackLng: 'en',
    resources: {
      [locale]: { messages: load(locale, 'messages'), channels: load(locale, 'channels') },
    },
    interpolation: { escapeValue: false },
  });
  return instance;
}

const KBD = (text: string) => ({ kbd: createElement('kbd', { className: 'k' }, text) });

// Trans는 Provider에 있는 i18n 인스턴스를 읽으므로 감싸서 렌더링한다
const render = (i18n: i18next.i18n, element: ReactElement) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element));

test('en·ko 채널 안내의 채널 이름이 <strong>으로 강조된다', async () => {
  for (const locale of ['en', 'ko']) {
    const i18n = await instanceFor(locale);
    const t = i18n.getFixedT(locale, 'messages');
    const html = render(i18n, createElement(Trans, {
      t,
      i18nKey: 'area.viewing',
      values: { channel: 'general' },
      components: { bold: createElement('strong') },
    }));
    assert.match(html, /<strong>#general<\/strong>/, locale);
    assert.doesNotMatch(html, /<bold>/, locale);
  }
});

test('en·ko 메시지 입력 안내의 단축키가 <kbd>로 렌더링된다', async () => {
  for (const locale of ['en', 'ko']) {
    const i18n = await instanceFor(locale);
    const t = i18n.getFixedT(locale, 'messages');
    const html = render(i18n, createElement(Trans, { t, i18nKey: 'input.hint', components: KBD('x') }));
    assert.match(html, /<kbd class="k">Enter<\/kbd>/, locale);
    assert.match(html, /<kbd class="k">Shift \+ Enter<\/kbd>/, locale);
    assert.doesNotMatch(html, /<kbd>[^<]*<\/kbd>[^<]*<kbd>/, `${locale} 중복 태그 없음`);
  }
});

test('en·ko 멤버 제거 확인 문구의 이름이 <strong>으로 강조된다', async () => {
  for (const locale of ['en', 'ko']) {
    const i18n = await instanceFor(locale);
    const t = i18n.getFixedT(locale, 'channels');
    const html = render(i18n, createElement(Trans, {
      t,
      i18nKey: 'membersPanel.removeDialog.message',
      values: { name: '김철수' },
      components: { bold: createElement('strong') },
    }));
    assert.match(html, /<strong>김철수<\/strong>/, locale);
  }
});
