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
const WALK = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'pt-BR', 'it', 'ru', 'uk', 'pl', 'nl', 'tr', 'sv', 'da', 'vi', 'id', 'ms', 'fil', 'hi', 'bn', 'th', 'nb', 'fi', 'cs', 'el', 'hu', 'ro'];

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
    values: { en: 'Save', ko: '저장', ja: '保存', 'zh-Hans': '保存', 'zh-Hant': '儲存', es: 'Guardar', fr: 'Enregistrer', de: 'Speichern', 'pt-BR': 'Salvar', it: 'Salva', ru: 'Сохранить', uk: 'Зберегти', pl: 'Zapisz', nl: 'Opslaan', tr: 'Kaydet', sv: 'Spara', da: 'Gem', vi: 'Lưu', id: 'Simpan', ms: 'Simpan', fil: 'I-save', hi: 'सहेजें', bn: 'সংরক্ষণ করুন', th: 'บันทึก', nb: 'Lagre', fi: 'Tallenna', cs: 'Uložit', el: 'Αποθήκευση', hu: 'Mentés', ro: 'Salvează' },
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
      nl: 'Aanmelden met e-mail',
      tr: 'E-postayla giriş yap',
      sv: 'Logga in med e-post',
      da: 'Log ind med e-mail',
      vi: 'Đăng nhập bằng email',
      id: 'Masuk dengan Email',
      ms: 'Log masuk dengan Emel',
      fil: 'Mag-sign in gamit ang Email',
      hi: 'ईमेल से साइन इन करें',
      bn: 'ইমেল দিয়ে সাইন ইন করুন',
      th: 'เข้าสู่ระบบด้วยอีเมล',
      nb: 'Logg inn med e-post', fi: 'Kirjaudu sähköpostilla', cs: 'Přihlásit se e-mailem', el: 'Σύνδεση με email', hu: 'Bejelentkezés e-mail-címmel', ro: 'Conectare cu e-mail',
    },
  },
  {
    key: 'sidebar:nav.activity',
    values: { en: 'Activity', ko: '활동', ja: 'アクティビティ', 'zh-Hans': '动态', 'zh-Hant': '動態', es: 'Actividad', fr: 'Activité', de: 'Aktivität', 'pt-BR': 'Atividade', it: 'Attività', ru: 'Активность', uk: 'Активність', pl: 'Aktywność', nl: 'Activiteit', tr: 'Etkinlik', sv: 'Aktivitet', da: 'Aktivitet', vi: 'Hoạt động', id: 'Aktivitas', ms: 'Aktiviti', fil: 'Aktibidad', hi: 'गतिविधि', bn: 'কার্যকলাপ', th: 'กิจกรรม', nb: 'Aktivitet', fi: 'Toiminta', cs: 'Aktivita', el: 'Δραστηριότητα', hu: 'Tevékenység', ro: 'Activitate' },
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
      nl: 'Bericht verzenden',
      tr: 'İleti gönder',
      sv: 'Skicka meddelande',
      da: 'Send besked',
      vi: 'Gửi tin nhắn',
      id: 'Kirim pesan',
      ms: 'Hantar mesej',
      fil: 'Ipadala ang mensahe',
      hi: 'संदेश भेजें',
      bn: 'বার্তা পাঠান',
      th: 'ส่งข้อความ',
      nb: 'Send melding', fi: 'Lähetä viesti', cs: 'Odeslat zprávu', el: 'Αποστολή μηνύματος', hu: 'Üzenet küldése', ro: 'Trimite mesajul',
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
      nl: '2 leden',
      tr: '2 üye',
      sv: '2 medlemmar',
      da: '2 medlemmer',
      vi: '2 thành viên',
      id: '2 anggota',
      ms: '2 ahli',
      fil: '2 miyembro',
      hi: '2 सदस्य',
      bn: '২ জন সদস্য',
      th: '2 สมาชิก',
      nb: '2 medlemmer', fi: '2 jäsentä', cs: '2 členové', el: '2 μέλη', hu: '2 tag', ro: '2 membri',
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
      nl: 'Het item is niet gevonden.',
      tr: 'Öğe bulunamadı.',
      sv: 'Objektet hittades inte.',
      da: 'Elementet blev ikke fundet.',
      vi: 'Không tìm thấy mục này.',
      id: 'Item tidak ditemukan.',
      ms: 'Item tidak ditemui.',
      fil: 'Hindi nahanap ang item.',
      hi: 'आइटम नहीं मिला।',
      bn: 'আইটেমটি পাওয়া যায়নি।',
      th: 'ไม่พบรายการที่ต้องการ',
      nb: 'Fant ikke elementet.', fi: 'Kohdetta ei löytynyt.', cs: 'Položka nebyla nalezena.', el: 'Το στοιχείο δεν βρέθηκε.', hu: 'Az elem nem található.', ro: 'Elementul nu a fost găsit.',
    },
  },
  {
    key: 'settings:language.label',
    values: { en: 'Language', ko: '언어', ja: '言語', 'zh-Hans': '语言', 'zh-Hant': '語言', es: 'Idioma', fr: 'Langue', de: 'Sprache', 'pt-BR': 'Idioma', it: 'Lingua', ru: 'Язык', uk: 'Мова', pl: 'Język', nl: 'Taal', tr: 'Dil', sv: 'Språk', da: 'Sprog', vi: 'Ngôn ngữ', id: 'Bahasa', ms: 'Bahasa', fil: 'Wika', hi: 'भाषा', bn: 'ভাষা', th: 'ภาษา', nb: 'Språk', fi: 'Kieli', cs: 'Jazyk', el: 'Γλώσσα', hu: 'Nyelv', ro: 'Limbă' },
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
      nl: 'Gepauzeerd tot 9:00',
      tr: '9:00 saatine kadar duraklatıldı',
      sv: 'Pausad till 9:00',
      da: 'På pause indtil 9:00',
      vi: 'Tạm dừng đến 9:00',
      id: 'Dijeda sampai 9:00',
      ms: 'Dijeda sehingga 9:00',
      fil: 'Naka-pause hanggang 9:00',
      hi: '9:00 तक रुकी हुई',
      bn: '9:00 পর্যন্ত বিরতিতে',
      th: 'หยุดชั่วคราวจนถึง 9:00',
      nb: 'På pause til 9:00', fi: 'Keskeytetty klo 9:00 asti', cs: 'Pozastaveno do 9:00', el: 'Σε παύση έως τις 9:00', hu: 'Szüneteltetve eddig: 9:00', ro: 'Pe pauză până la 9:00',
    },
  },
];

// 복수형 경계 값(1, 2, 5, 0, 11, 12, 21, 22, 111)으로 CLDR 분기가 맞게 고르는지 확인한다.
// ru·uk·pl은 one/few/many/other를 모두 쓰고, it은 one/other만 쓴다.
// nl·tr·sv·da는 one/other 두 분기만 쓴다. 경계 값(0, 1, 2, 5, 11, 12, 21, 22, 111)으로 확인한다.
const PLURAL_CASES = [
  {
    key: 'channels:dialog.memberCount',
    lng: 'nl',
    cases: { 0: '0 leden', 1: '1 lid', 2: '2 leden', 5: '5 leden', 11: '11 leden', 12: '12 leden', 21: '21 leden', 22: '22 leden', 111: '111 leden' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'tr',
    cases: { 0: '0 üye', 1: '1 üye', 2: '2 üye', 5: '5 üye', 11: '11 üye', 12: '12 üye', 21: '21 üye', 22: '22 üye', 111: '111 üye' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'sv',
    cases: { 0: '0 medlemmar', 1: '1 medlem', 2: '2 medlemmar', 5: '5 medlemmar', 11: '11 medlemmar', 12: '12 medlemmar', 21: '21 medlemmar', 22: '22 medlemmar', 111: '111 medlemmar' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'da',
    cases: { 0: '0 medlemmer', 1: '1 medlem', 2: '2 medlemmer', 5: '5 medlemmer', 11: '11 medlemmer', 12: '12 medlemmer', 21: '21 medlemmer', 22: '22 medlemmer', 111: '111 medlemmer' },
  },
  // vi·id·ms·fil 추가: vi는 Intl이 one/other를 내도 두 분기 문구가 같고, id·ms는 other만 쓴다.
  // fil은 Intl이 0,1,2,3,5,10,11,12,21,22,111을 one으로, 4,6,9를 other로 내므로 4를 other 경계로 확인한다.
  {
    key: 'channels:dialog.memberCount',
    lng: 'vi',
    cases: { 0: '0 thành viên', 1: '1 thành viên', 2: '2 thành viên', 5: '5 thành viên', 11: '11 thành viên', 12: '12 thành viên', 21: '21 thành viên', 22: '22 thành viên', 111: '111 thành viên' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'id',
    cases: { 0: '0 anggota', 1: '1 anggota', 2: '2 anggota', 5: '5 anggota', 11: '11 anggota', 12: '12 anggota', 21: '21 anggota', 22: '22 anggota', 111: '111 anggota' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'ms',
    cases: { 0: '0 ahli', 1: '1 ahli', 2: '2 ahli', 5: '5 ahli', 11: '11 ahli', 12: '12 ahli', 21: '21 ahli', 22: '22 ahli', 111: '111 ahli' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'fil',
    cases: { 0: '0 miyembro', 1: '1 miyembro', 2: '2 miyembro', 4: '4 na miyembro', 5: '5 miyembro', 6: '6 na miyembro', 9: '9 na miyembro', 11: '11 miyembro', 12: '12 miyembro', 21: '21 miyembro', 22: '22 miyembro', 111: '111 miyembro' },
  },
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
  // hi·bn·nb는 one/other 두 분기, th는 other 분기만 쓴다(CLDR). 힌디·벵골어 명사는 단수와 복수가 같다.
// bn은 Intl 기본 숫자 체계(벵골 숫자 ০-৯)를 따른다. 런타임 Intl 결과를 기준으로 한다.
  {
    key: 'channels:dialog.memberCount',
    lng: 'hi',
    cases: { 0: '0 सदस्य', 1: '1 सदस्य', 2: '2 सदस्य', 5: '5 सदस्य', 11: '11 सदस्य', 12: '12 सदस्य', 21: '21 सदस्य', 22: '22 सदस्य', 111: '111 सदस्य' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'bn',
    cases: { 0: '০ জন সদস্য', 1: '১ জন সদস্য', 2: '২ জন সদস্য', 5: '৫ জন সদস্য', 11: '১১ জন সদস্য', 12: '১২ জন সদস্য', 21: '২১ জন সদস্য', 22: '২২ জন সদস্য', 111: '১১১ জন সদস্য' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'nb',
    cases: { 0: '0 medlemmer', 1: '1 medlem', 2: '2 medlemmer', 5: '5 medlemmer', 11: '11 medlemmer', 12: '12 medlemmer', 21: '21 medlemmer', 22: '22 medlemmer', 111: '111 medlemmer' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'th',
    cases: { 0: '0 สมาชิก', 1: '1 สมาชิก', 2: '2 สมาชิก', 5: '5 สมาชิก', 11: '11 สมาชิก', 12: '12 สมาชิก', 21: '21 สมาชิก', 22: '22 สมาชิก', 111: '111 สมาชิก' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'fi',
    cases: { 0: '0 jäsentä', 1: '1 jäsen', 2: '2 jäsentä', 5: '5 jäsentä', 11: '11 jäsentä', 12: '12 jäsentä', 21: '21 jäsentä', 22: '22 jäsentä', 111: '111 jäsentä' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'cs',
    cases: { 0: '0 členů', 1: '1 člen', 2: '2 členové', 4: '4 členové', 5: '5 členů', 11: '11 členů', 12: '12 členů', 21: '21 členů', 22: '22 členů', 111: '111 členů' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'el',
    cases: { 0: '0 μέλη', 1: '1 μέλος', 2: '2 μέλη', 5: '5 μέλη', 11: '11 μέλη', 12: '12 μέλη', 21: '21 μέλη', 22: '22 μέλη', 111: '111 μέλη' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'hu',
    cases: { 0: '0 tag', 1: '1 tag', 2: '2 tag', 5: '5 tag', 11: '11 tag', 12: '12 tag', 21: '21 tag', 22: '22 tag', 111: '111 tag' },
  },
  {
    key: 'channels:dialog.memberCount',
    lng: 'ro',
    cases: { 0: '0 membri', 1: '1 membru', 2: '2 membri', 5: '5 membri', 11: '11 membri', 12: '12 membri', 21: '21 de membri', 22: '22 de membri', 111: '111 membri' },
  },
];

test('en→ja→zh-Hans→zh-Hant→es→fr→de→pt-BR→it→ru→uk→pl→nl→tr→sv→da→ko→en 순서로 바꿔도 주요 화면 문자열이 그 언어로 나온다', async () => {
  const i18n = await makeI18n();
  for (const lng of ['en', 'ja', 'zh-Hans', 'zh-Hant', 'es', 'fr', 'de', 'pt-BR', 'it', 'ru', 'uk', 'pl', 'nl', 'tr', 'sv', 'da', 'vi', 'id', 'ms', 'fil', 'hi', 'bn', 'th', 'nb', 'fi', 'cs', 'el', 'hu', 'ro', 'ko', 'en']) {
    await i18n.changeLanguage(lng);
    for (const sample of SAMPLES) {
      assert.equal(i18n.t(sample.key, sample.options), sample.values[lng], `${lng} ${sample.key}`);
    }
  }
});

test('같은 키를 여러 번 바꿔 읽어도 값이 흔들리지 않는다(반복 확인)', async () => {
  const i18n = await makeI18n();
  for (let round = 0; round < 3; round += 1) {
    for (const lng of ['ja', 'es', 'fr', 'de', 'pt-BR', 'zh-Hant', 'it', 'ru', 'uk', 'pl', 'nl', 'tr', 'sv', 'da', 'vi', 'id', 'ms', 'fil', 'hi', 'bn', 'th', 'nb', 'fi', 'cs', 'el', 'hu', 'ro', 'ko', 'zh-Hans', 'en']) {
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

// 2등급 4개 언어(nl, tr, sv, da) 번역 리소스 CRUD: 사이드바 nav.unreads로 읽기, 수정, 삭제(영어 대체), 다시 만들기를 반복한다.
test('신규 4개 언어(nl, tr, sv, da)도 번역 리소스 CRUD가 같게 동작한다', async () => {
  const i18n = await makeI18n();
  for (const [lng, unreads] of [
    ['nl', 'Ongelezen'],
    ['tr', 'Okunmamışlar'],
    ['sv', 'Olästa'],
    ['da', 'Ulæste'],
  ]) {
    await i18n.changeLanguage(lng);
    const bundle = () => structuredClone(RESOURCES[lng].sidebar);
    const setBundle = (value) => {
      i18n.removeResourceBundle(lng, 'sidebar');
      i18n.addResourceBundle(lng, 'sidebar', value, true, true);
    };

    // Read
    assert.equal(i18n.t('sidebar:nav.unreads'), unreads, `${lng} read`);

    // Update
    const updated = bundle();
    updated.nav.unreads = 'TEST';
    setBundle(updated);
    assert.equal(i18n.t('sidebar:nav.unreads'), 'TEST', `${lng} update`);

    // Delete: 키를 지우면 영어 원문(Unreads)으로 대체된다
    const removed = bundle();
    delete removed.nav.unreads;
    setBundle(removed);
    assert.equal(i18n.t('sidebar:nav.unreads'), 'Unreads', `${lng} delete`);

    // Create: 다시 추가하면 번역이 돌아온다
    setBundle(bundle());
    assert.equal(i18n.t('sidebar:nav.unreads'), unreads, `${lng} create`);
  }
});

// 3차 2등급 4개 언어(hi, bn, th, nb) 번역 리소스 CRUD: 읽기, 수정, 삭제(영어 대체), 다시 만들기를 두 바퀴 반복한다.
test('신규 4개 언어(hi, bn, th, nb)도 번역 리소스 CRUD가 같게 동작하고 반복해도 흔들리지 않는다', async () => {
  const i18n = await makeI18n();
  for (let round = 0; round < 2; round += 1) {
    for (const [lng, unreads] of [
      ['hi', 'बिना पढ़े'],
      ['bn', 'অপঠিত'],
      ['th', 'ยังไม่ได้อ่าน'],
      ['nb', 'Uleste'],
    ]) {
      await i18n.changeLanguage(lng);
      const bundle = () => structuredClone(RESOURCES[lng].sidebar);
      const setBundle = (value) => {
        i18n.removeResourceBundle(lng, 'sidebar');
        i18n.addResourceBundle(lng, 'sidebar', value, true, true);
      };

      // Read
      assert.equal(i18n.t('sidebar:nav.unreads'), unreads, `${lng} read round ${round}`);

      // Update
      const updated = bundle();
      updated.nav.unreads = 'TEST';
      setBundle(updated);
      assert.equal(i18n.t('sidebar:nav.unreads'), 'TEST', `${lng} update round ${round}`);

      // Delete: 키를 지우면 영어 원문(Unreads)으로 대체된다
      const removed = bundle();
      delete removed.nav.unreads;
      setBundle(removed);
      assert.equal(i18n.t('sidebar:nav.unreads'), 'Unreads', `${lng} delete round ${round}`);

      // Create: 다시 추가하면 번역이 돌아온다
      setBundle(bundle());
      assert.equal(i18n.t('sidebar:nav.unreads'), unreads, `${lng} create round ${round}`);
    }
  }
});

// 태국어는 단어 사이에 공백이 없어서 자리표시자 앞뒤 공백을 문장마다 따로 맞춘다. 보간이 그 공백을 그대로 지키는지 확인한다.
test('태국어 자리표시자는 번역문의 공백을 그대로 두고 보간되며, 복수형은 other 분기 하나로 정해진다', async () => {
  const i18n = await makeI18n();
  await i18n.changeLanguage('th');
  assert.equal(i18n.t('messages:filePreview.remove', { name: 'report.pdf' }), 'นำ report.pdf ออก');
  assert.equal(i18n.t('messages:search.inChannel', { channel: 'general' }), 'ใน #general');
  // 태국어 분기는 other 하나뿐이므로 1과 2가 같은 형태여야 한다
  assert.equal(i18n.t('messages:thread.replyCount', { count: 1 }), '1 การตอบกลับ');
  assert.equal(i18n.t('messages:thread.replyCount', { count: 2 }), '2 การตอบกลับ');
});

// 터키어 대소문자: 로캘 기준 변환은 İ/ı를 구분한다. 채널 이름 소문자화(toLocaleLowerCase)가 tr에서 İ→i가 되는지 확인한다.
test('터키어 번역의 İ는 로캘 기준 소문자화에서 i가 되고, 점 없는 ı와 섞이지 않는다', async () => {
  const i18n = await makeI18n();
  await i18n.changeLanguage('tr');
  const cancel = i18n.t('common:actions.cancel');
  assert.equal(cancel, 'İptal');
  assert.equal(cancel.toLocaleLowerCase('tr'), 'iptal');
  assert.equal('I'.toLocaleLowerCase('tr'), 'ı');
  assert.equal('i'.toLocaleUpperCase('tr'), 'İ');
});

// 2등급 4개 언어(vi, id, ms, fil) 번역 리소스 CRUD: sidebar nav.unreads로 읽기, 수정, 삭제(영어 대체), 다시 만들기를 반복한다.
test('신규 4개 언어(vi, id, ms, fil)도 번역 리소스 CRUD가 같게 동작한다', async () => {
  const i18n = await makeI18n();
  for (const [lng, unreads] of [
    ['vi', 'Chưa đọc'],
    ['id', 'Belum dibaca'],
    ['ms', 'Belum dibaca'],
    ['fil', 'Hindi pa nababasa'],
  ]) {
    await i18n.changeLanguage(lng);
    const bundle = () => structuredClone(RESOURCES[lng].sidebar);
    const setBundle = (value) => {
      i18n.removeResourceBundle(lng, 'sidebar');
      i18n.addResourceBundle(lng, 'sidebar', value, true, true);
    };

    // Read
    assert.equal(i18n.t('sidebar:nav.unreads'), unreads, `${lng} read`);

    // Update
    const updated = bundle();
    updated.nav.unreads = 'TEST';
    setBundle(updated);
    assert.equal(i18n.t('sidebar:nav.unreads'), 'TEST', `${lng} update`);

    // Delete: 키를 지우면 영어 원문(Unreads)으로 대체된다
    const removed = bundle();
    delete removed.nav.unreads;
    setBundle(removed);
    assert.equal(i18n.t('sidebar:nav.unreads'), 'Unreads', `${lng} delete`);

    // Create: 다시 추가하면 번역이 돌아온다
    setBundle(bundle());
    assert.equal(i18n.t('sidebar:nav.unreads'), unreads, `${lng} create`);
  }
});

// 복수형 경계 값 반복 확인: fil은 같은 키를 여러 번 바꿔도 one(1, 2, 3)과 other(4, 6, 9) 분기가 흔들리지 않는다.
test('fil 복수형 분기(one/other)는 언어를 바꾸고 되돌려도 같은 값을 낸다', async () => {
  const i18n = await makeI18n();
  for (let round = 0; round < 3; round += 1) {
    await i18n.changeLanguage('fil');
    assert.equal(i18n.t('channels:dialog.memberCount', { count: 3 }), '3 miyembro');
    assert.equal(i18n.t('channels:dialog.memberCount', { count: 4 }), '4 na miyembro');
    await i18n.changeLanguage('vi');
    assert.equal(i18n.t('channels:dialog.memberCount', { count: 4 }), '4 thành viên');
    await i18n.changeLanguage('en');
    assert.equal(i18n.t('channels:dialog.memberCount', { count: 4 }), '4 members');
  }
});

// 2등급 5개 언어(fi, cs, el, hu, ro) 번역 리소스 CRUD: 사이드바 nav.unreads로 읽기, 수정, 삭제(영어 대체), 다시 만들기를 두 번 반복한다.
test('신규 5개 언어(fi, cs, el, hu, ro)도 번역 리소스 CRUD가 같게 동작하고 반복해도 흔들리지 않는다', async () => {
  const i18n = await makeI18n();
  for (let round = 0; round < 2; round += 1) {
    for (const [lng, unreads] of [
      ['fi', 'Lukemattomat'],
      ['cs', 'Nepřečtené'],
      ['el', 'Μη αναγνωσμένα'],
      ['hu', 'Olvasatlanok'],
      ['ro', 'Necitite'],
    ]) {
      await i18n.changeLanguage(lng);
      const bundle = () => structuredClone(RESOURCES[lng].sidebar);
      const setBundle = (value) => {
        i18n.removeResourceBundle(lng, 'sidebar');
        i18n.addResourceBundle(lng, 'sidebar', value, true, true);
      };

      // Read
      assert.equal(i18n.t('sidebar:nav.unreads'), unreads, `${lng} read round ${round}`);

      // Update
      const updated = bundle();
      updated.nav.unreads = 'TEST';
      setBundle(updated);
      assert.equal(i18n.t('sidebar:nav.unreads'), 'TEST', `${lng} update round ${round}`);

      // Delete: 키를 지우면 영어 원문(Unreads)으로 대체된다
      const removed = bundle();
      delete removed.nav.unreads;
      setBundle(removed);
      assert.equal(i18n.t('sidebar:nav.unreads'), 'Unreads', `${lng} delete round ${round}`);

      // Create: 다시 추가하면 번역이 돌아온다
      setBundle(bundle());
      assert.equal(i18n.t('sidebar:nav.unreads'), unreads, `${lng} create round ${round}`);
    }
  }
});

// 복수형 경계 값 반복 확인: cs는 few 분기가 2~4에만 걸리고 22는 other로 간다. ro는 0과 111이 few, 21과 22는 other다.
test('신규 5개 언어 복수형 경계(cs, ro, el, fi, hu)는 언어를 바꾸고 되돌려도 같은 값을 낸다', async () => {
  const i18n = await makeI18n();
  for (let round = 0; round < 3; round += 1) {
    for (const [lng, count, expected] of [
      ['cs', 2, '2 členové'],
      ['cs', 22, '22 členů'],
      ['ro', 0, '0 membri'],
      ['ro', 21, '21 de membri'],
      ['ro', 111, '111 membri'],
      ['el', 1, '1 μέλος'],
      ['fi', 1, '1 jäsen'],
      ['hu', 2, '2 tag'],
    ]) {
      await i18n.changeLanguage(lng);
      assert.equal(i18n.t('channels:dialog.memberCount', { count }), expected, `${lng} ${count} round ${round}`);
    }
    await i18n.changeLanguage('en');
    assert.equal(i18n.t('channels:dialog.memberCount', { count: 2 }), '2 members');
  }
});
