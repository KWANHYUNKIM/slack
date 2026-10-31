// 언어 전환과 영어 대체, 번역 리소스 CRUD를 실제 번역 파일로 검증한다.
// 설정은 앱과 같은 createI18nInitOptions()를 쓰고, 번역 파일은 src/locales의 JSON을 그대로 읽는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import ICU from 'i18next-icu';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createI18nInitOptions,
  FALLBACK_LOCALE,
  SELECTABLE_LOCALES,
} from '../src/lib/i18n/config.ts';
import { TIER1_LOCALES, TIER2_LOCALES, isBetaLocale } from '../src/lib/i18n/tiers.ts';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const WALK = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'pt-BR', 'it', 'ru', 'uk', 'pl'];

function loadLocale(locale) {
  const dir = join(LOCALES_DIR, locale);
  const namespaces = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    namespaces[file.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  }
  return namespaces;
}

const RESOURCES = Object.fromEntries(WALK.map((l) => [l, loadLocale(l)]));

async function makeI18n(resources = RESOURCES) {
  const instance = i18next.createInstance();
  // 앱과 같은 옵션(fallbackLng 포함)에 리소스만 넣는다. structuredClone으로 테스트끼리 리소스를 공유하지 않는다.
  await instance.use(ICU).init({
    ...createI18nInitOptions(),
    lng: FALLBACK_LOCALE,
    resources: structuredClone(resources),
  });
  return instance;
}

// 주요 화면 문자열: 로그인, 사이드바, 메시지 입력, 채널 대화상자(복수형), 서버 오류, 설정, 보간
const SAMPLES = [
  {
    key: 'common:actions.save',
    values: { en: 'Save', ko: '저장', ja: '保存', 'zh-Hans': '保存', 'zh-Hant': '儲存', es: 'Guardar', fr: 'Enregistrer', de: 'Speichern', 'pt-BR': 'Salvar', it: 'Salva', ru: 'Сохранить', uk: 'Зберегти', pl: 'Zapisz' },
  },
  {
    key: 'auth:login.submit',
    values: {
      en: 'Sign in with Email',
      ko: '이메일로 로그인',
      ja: 'メールアドレスでサインイン',
      'zh-Hans': '使用电子邮件登录',
      'zh-Hant': '使用電子郵件登入',
      es: 'Iniciar sesión con correo',
      fr: "Se connecter avec l'e-mail",
      de: 'Mit E-Mail anmelden',
      'pt-BR': 'Entrar com e-mail',
      it: 'Accedi con email',
      ru: 'Войти по эл. почте',
      uk: 'Увійти через ел. пошту',
      pl: 'Zaloguj się adresem e-mail',
    },
  },
  {
    key: 'sidebar:nav.activity',
    values: { en: 'Activity', ko: '활동', ja: 'アクティビティ', 'zh-Hans': '动态', 'zh-Hant': '動態', es: 'Actividad', fr: 'Activité', de: 'Aktivität', 'pt-BR': 'Atividade', it: 'Attività', ru: 'Активность', uk: 'Активність', pl: 'Aktywność' },
  },
  {
    key: 'messages:input.send',
    values: {
      en: 'Send message',
      ko: '메시지 보내기',
      ja: 'メッセージを送信',
      'zh-Hans': '发送消息',
      'zh-Hant': '傳送訊息',
      es: 'Enviar mensaje',
      fr: 'Envoyer le message',
      de: 'Nachricht senden',
      'pt-BR': 'Enviar mensagem',
      it: 'Invia messaggio',
      ru: 'Отправить сообщение',
      uk: 'Надіслати повідомлення',
      pl: 'Wyślij wiadomość',
    },
  },
  {
    key: 'channels:dialog.memberCount',
    options: { count: 2 },
    values: {
      en: '2 members',
      ko: '멤버 2명',
      ja: '2 人のメンバー',
      'zh-Hans': '2 位成员',
      'zh-Hant': '2 位成員',
      es: '2 miembros',
      fr: '2 membres',
      de: '2 Mitglieder',
      'pt-BR': '2 membros',
      it: '2 membri',
      ru: '2 участника',
      uk: '2 учасники',
      pl: '2 członkowie',
    },
  },
  {
    key: 'errors:api.NOT_FOUND',
    values: {
      en: 'The item was not found.',
      ko: '찾을 수 없습니다.',
      ja: '項目が見つかりませんでした。',
      'zh-Hans': '未找到该项目。',
      'zh-Hant': '找不到此項目。',
      es: 'No se encontró el elemento.',
      fr: "L'élément est introuvable.",
      de: 'Das Element wurde nicht gefunden.',
      'pt-BR': 'O item não foi encontrado.',
      it: 'Elemento non trovato.',
      ru: 'Объект не найден.',
      uk: "Об'єкт не знайдено.",
      pl: 'Nie znaleziono elementu.',
    },
  },
  {
    key: 'settings:language.label',
    values: { en: 'Language', ko: '언어', ja: '言語', 'zh-Hans': '语言', 'zh-Hant': '語言', es: 'Idioma', fr: 'Langue', de: 'Sprache', 'pt-BR': 'Idioma', it: 'Lingua', ru: 'Язык', uk: 'Мова', pl: 'Język' },
  },
  {
    key: 'sidebar:userMenu.pausedUntil',
    options: { time: '9:00' },
    values: {
      en: 'Paused until 9:00',
      ko: '9:00까지 방해금지',
      ja: '9:00まで一時停止中',
      'zh-Hans': '暂停至 9:00',
      'zh-Hant': '暫停至 9:00',
      es: 'Pausadas hasta 9:00',
      fr: "Suspendues jusqu'à 9:00",
      de: 'Pausiert bis 9:00',
      'pt-BR': 'Pausadas até 9:00',
      it: 'In pausa fino alle 9:00',
      ru: 'Приостановлено до 9:00',
      uk: 'Призупинено до 9:00',
      pl: 'Wstrzymano do 9:00',
    },
  },
];

// 복수형 경계 값(1, 2, 5, 0, 11, 12, 21, 22, 111)으로 CLDR 분기가 맞게 고르는지 확인한다.
// ru·uk·pl은 one/few/many/other를 모두 쓰고, it은 one/other만 쓴다.
const PLURAL_CASES = [
  {
    key: 'channels:dialog.memberCount',
    lng: 'ru',
    cases: { 0: '0 участников', 1: '1 участник', 2: '2 участника', 5: '5 участников', 11: '11 участников', 21: '21 участник', 22: '22 участника', 111: '111 участников' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'uk',
    cases: { 0: '0 учасників', 1: '1 учасник', 2: '2 учасники', 5: '5 учасників', 11: '11 учасників', 21: '21 учасник', 22: '22 учасники', 111: '111 учасників' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'pl',
    cases: { 0: '0 członków', 1: '1 członek', 2: '2 członkowie', 5: '5 członków', 12: '12 członków', 21: '21 członków', 22: '22 członkowie', 111: '111 członków' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'it',
    cases: { 0: '0 membri', 1: '1 membro', 2: '2 membri', 5: '5 membri', 21: '21 membri' },
  },
  {
    key: 'messages:thread.replyCount',
    lng: 'ru',
    cases: { 1: '1 ответ', 2: '2 ответа', 5: '5 ответов', 11: '11 ответов', 21: '21 ответ' },
  },
  {
    key: 'messages:thread.replyCount',
    lng: 'pl',
    cases: { 1: '1 odpowiedź', 2: '2 odpowiedzi', 5: '5 odpowiedzi', 12: '12 odpowiedzi', 22: '22 odpowiedzi' },
  },
];

test('en→ja→zh-Hans→zh-Hant→es→fr→de→pt-BR→it→ru→uk→pl→ko→en 순서로 바꿔도 주요 화면 문자열이 그 언어로 나온다', async () => {
  const i18n = await makeI18n();
  for (const lng of ['en', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'pt-BR', 'it', 'ru', 'uk', 'pl', 'ko', 'en']) {
    await i18n.changeLanguage(lng);
    for (const sample of SAMPLES) {
      assert.equal(i18n.t(sample.key, sample.options), sample.values[lng], `${lng} ${sample.key}`);
    }
  }
});

test('같은 키를 여러 번 바꿔 읽어도 값이 흔들리지 않는다(반복 확인)', async () => {
  const i18n = await makeI18n();
  for (let round = 0; round < 3; round += 1) {
    for (const lng of ['ja', 'es', 'fr', 'de', 'pt-BR', 'zh-Hant', 'it', 'ru', 'uk', 'pl', 'ko', 'zh-Hans', 'en']) {
      await i18n.changeLanguage(lng);
      assert.equal(i18n.t('settings:language.label'), SAMPLES[6].values[lng]);
    }
  }
});

test('복수형 경계 값(0, 1, 2, 5, 11, 12, 21, 22, 111)에서 언어별 CLDR 분기가 맞게 나온다', async () => {
  const i18n = await makeI18n();
  for (const { key, lng, cases } of PLURAL_CASES) {
    await i18n.changeLanguage(lng);
    for (const [count, expected] of Object.entries(cases)) {
      assert.equal(i18n.t(key, { count: Number(count) }), expected, `${lng} ${key} count=${count}`);
    }
  }
});

test('2등급 로캘에서 빠진 키는 영어로 대체되고, 나머지 키는 번역을 유지한다', async () => {
  const resources = structuredClone(RESOURCES);
  delete resources.ja.sidebar.nav.later;
  const i18n = await makeI18n(resources);
  await i18n.changeLanguage('ja');
  assert.equal(i18n.t('sidebar:nav.later'), 'Later');
  assert.equal(i18n.t('sidebar:nav.activity'), 'アクティビティ');
});

test('네임스페이스 파일 전체가 빠져도 해당 화면 문자열은 영어로 나온다', async () => {
  const resources = structuredClone(RESOURCES);
  delete resources.es.huddle;
  const i18n = await makeI18n(resources);
  await i18n.changeLanguage('es');
  assert.equal(i18n.t('huddle:bar.mute'), 'Mute');
  assert.equal(i18n.t('common:actions.save'), 'Guardar');
});

test('번역 파일이 없는 로캘(3등급)은 전부 영어로 나온다', async () => {
  const i18n = await makeI18n();
  // fr은 이제 번역 파일이 있으므로, 파일이 없는 로캘(sw)으로 영어 대체를 확인한다
  await i18n.changeLanguage('sw');
  assert.equal(i18n.t('common:actions.save'), 'Save');
  assert.equal(i18n.t('sidebar:nav.activity'), 'Activity');
});

test('번역 리소스 CRUD: 읽기, 수정, 삭제(영어 대체), 다시 만들기', async () => {
  const i18n = await makeI18n();
  await i18n.changeLanguage('ja');
  const bundle = () => structuredClone(RESOURCES.ja.sidebar);
  const setBundle = (value) => {
    i18n.removeResourceBundle('ja', 'sidebar');
    i18n.addResourceBundle('ja', 'sidebar', value, true, true);
  };

  // Read
  assert.equal(i18n.t('sidebar:nav.later'), '後で');

  // Update
  const updated = bundle();
  updated.nav.later = 'テスト更新';
  setBundle(updated);
  assert.equal(i18n.t('sidebar:nav.later'), 'テスト更新');

  // Delete: 파일에서 키를 지우면 영어 원문으로 대체된다
  const removed = bundle();
  delete removed.nav.later;
  setBundle(removed);
  assert.equal(i18n.t('sidebar:nav.later'), 'Later');

  // Create: 다시 추가하면 번역이 돌아온다
  setBundle(bundle());
  assert.equal(i18n.t('sidebar:nav.later'), '後で');
});

test('신규 4개 언어(it, ru, uk, pl)도 번역 리소스 CRUD가 같게 동작한다', async () => {
  const i18n = await makeI18n();
  for (const [lng, later] of [
    ['it', 'Più tardi'],
    ['ru', 'Позже'],
    ['uk', 'Пізніше'],
    ['pl', 'Później'],
  ]) {
    await i18n.changeLanguage(lng);
    const bundle = () => structuredClone(RESOURCES[lng].sidebar);
    const setBundle = (value) => {
      i18n.removeResourceBundle(lng, 'sidebar');
      i18n.addResourceBundle(lng, 'sidebar', value, true, true);
    };

    // Read
    assert.equal(i18n.t('sidebar:nav.later'), later, `${lng} read`);

    // Update
    const updated = bundle();
    updated.nav.later = 'TEST';
    setBundle(updated);
    assert.equal(i18n.t('sidebar:nav.later'), 'TEST', `${lng} update`);

    // Delete: 키를 지우면 영어 원문으로 대체된다
    const removed = bundle();
    delete removed.nav.later;
    setBundle(removed);
    assert.equal(i18n.t('sidebar:nav.later'), 'Later', `${lng} delete`);

    // Create: 다시 추가하면 번역이 돌아온다
    setBundle(bundle());
    assert.equal(i18n.t('sidebar:nav.later'), later, `${lng} create`);
  }
});

test('언어 등급 상수: 1등급 2개, 2등급 31개(i18n.md 표 순서), 선택 목록의 2등급은 베타', () => {
  assert.deepEqual([...TIER1_LOCALES], ['en', 'ko']);
  assert.equal(TIER2_LOCALES.length, 31);
  assert.equal(new Set(TIER2_LOCALES).size, 31);
  assert.equal(TIER2_LOCALES[0], 'ja');
  assert.equal(TIER2_LOCALES[1], 'zh-Hans');
  assert.equal(TIER2_LOCALES[3], 'es');
  assert.equal(isBetaLocale('ja'), true);
  assert.equal(isBetaLocale('ko'), false);
  assert.equal(isBetaLocale('en'), false);
  for (const option of SELECTABLE_LOCALES) {
    const tier1 = TIER1_LOCALES.includes(option.code);
    assert.ok(tier1 || isBetaLocale(option.code), `${option.code}은 1등급이나 2등급이어야 한다`);
    assert.equal(isBetaLocale(option.code), !tier1, `${option.code} 베타 표시`);
    assert.ok(existsSync(join(LOCALES_DIR, option.code)), `${option.code} 번역 디렉터리`);
  }
});

test('초기 설정 객체는 호출할 때마다 새로 만들어져 리소스를 공유하지 않는다', () => {
  const a = createI18nInitOptions();
  const b = createI18nInitOptions();
  assert.notEqual(a.resources, b.resources);
  assert.equal(a.fallbackLng, 'en');
  assert.equal(a.partialBundledLanguages, true);
});
