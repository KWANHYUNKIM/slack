import { TEST_PASSWORD } from './test-constants.js';
import { jest } from '@jest/globals';
import { fileURLToPath } from 'url';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import {
  CHANNEL_NAME_MAX,
  checkChannelName,
  normalizeChannelName,
  validateChannelName,
  type ChannelNameReason,
} from '../utils/channelName.js';

// 허용/거부 테스트 벡터. 백엔드와 프런트(frontend/src/lib/channelName.ts) 구현이 모두 이 결과를 내야 한다.
// 값이 문자열이면 허용되고 그 이름으로 저장된다는 뜻, { reason }이면 그 이유로 거부된다는 뜻이다.
type Expected = string | { reason: ChannelNameReason };
const VECTORS: [label: string, input: string, expected: Expected][] = [
  ['ascii', 'dev-team', 'dev-team'],
  ['trim + lowercase', '  Project_A ', 'project_a'],
  ['korean', '개발팀', '개발팀'],
  ['korean NFD -> NFC', '한글팀'.normalize('NFD'), '한글팀'],
  ['korean compatibility jamo kept', 'ㅋㅋ', 'ㅋㅋ'],
  ['korean + latin + underscore', '프로젝트_a', '프로젝트_a'],
  ['japanese', '日本語', '日本語'],
  ['halfwidth katakana -> fullwidth', 'ﾃﾞｰﾀ', 'データ'],
  ['arabic', 'قناة', 'قناة'],
  ['pure russian', 'общий', 'общий'],
  ['pure greek', 'ελληνικά', 'ελληνικά'],
  ['cyrillic + digits + hyphen', 'общий-2', 'общий-2'],
  ['arabic-indic digits alone', '٣٤', '٣٤'],
  ['arabic letters + arabic-indic digits', 'قناة٣', 'قناة٣'],
  ['combining accent after letter', 'cafe\u0301', 'café'],
  ['fullwidth -> ascii (NFKC)', 'ｇｅｎｅｒａｌ', 'general'],
  ['fullwidth uppercase', 'ＧＥＮＥＲＡＬ', 'general'],
  ['ligature fi', '\uFB01le', 'file'],
  ['math bold letter', '\u{1D420}en', 'gen'],
  ['kelvin sign', '\u212Aelvin', 'kelvin'],
  ['turkish I without locale', 'INFO', 'info'],
  ['max code points of astral han', '\u{20BB7}'.repeat(CHANNEL_NAME_MAX), '\u{20BB7}'.repeat(CHANNEL_NAME_MAX)],
  ['devanagari with vowel signs', 'हिन्दी', 'हिन्दी'],
  ['devanagari conjunct', 'क्षत्रिय', 'क्षत्रिय'],
  ['arabic with harakat', 'قَنَاةٌ', 'قَنَاةٌ'],
  ['arabic shadda + fatha + dammatan', 'اللَّهُ', 'اللَّهُ'],
  ['vietnamese precomposed', 'tiếng-việt', 'tiếng-việt'],
  ['vietnamese NFD -> NFC', 'tiếng-việt'.normalize('NFD'), 'tiếng-việt'],
  ['thai with tone marks', 'ภาษาไทย', 'ภาษาไทย'],
  ['4 combining marks in a row', 'x\u0301\u0302\u0303\u0304', 'x\u0301\u0302\u0303\u0304'],
  ['han + hiragana + hangul', '日本語ひらがな한글', '日本語ひらがな한글'],
  ['latin + hangul', 'team팀', 'team팀'],
  ['latin + han + digits', 'dev-開発-2', 'dev-開発-2'],
  ['cyrillic + hangul', 'общий팀', 'общий팀'],

  ['empty', '   ', { reason: 'required' }],
  ['over max code points', '가'.repeat(CHANNEL_NAME_MAX + 1), { reason: 'tooLong' }],
  ['zalgo: 5 combining marks in a row', 'x\u0301\u0302\u0303\u0304\u0305', { reason: 'tooManyMarks' }],
  ['zalgo: heavy stacking mid-name', 'abx\u0300\u0301\u0302\u0303\u0304\u0305\u0306cd', { reason: 'tooManyMarks' }],
  ['greek + latin (hyphen does not separate)', 'alpha-\u03B1', { reason: 'mixedScripts' }],
  ['variation selector FE0F', 'dev\uFE0F', { reason: 'invalidChars' }],
  ['variation selector supplement E0100', 'dev\u{E0100}', { reason: 'invalidChars' }],
  ['combining grapheme joiner', 'de\u034Fv', { reason: 'invalidChars' }],
  ['hangul filler 3164', 'dev\u3164', { reason: 'invalidChars' }],
  ['hangul filler only', '\u3164', { reason: 'invalidChars' }],
  ['hangul choseong filler 115F', '\u115F가', { reason: 'invalidChars' }],
  ['hangul jungseong filler 1160', '가\u1160', { reason: 'invalidChars' }],
  ['halfwidth hangul filler FFA0', 'dev\uFFA0', { reason: 'invalidChars' }],
  ['mongolian FVS 180B', 'dev\u180B', { reason: 'invalidChars' }],
  ['mongolian vowel separator 180E', 'dev\u180E', { reason: 'invalidChars' }],
  ['soft hyphen', 'de\u00ADv', { reason: 'invalidChars' }],
  ['bidi override U+202E', 'abc\u202Edef', { reason: 'invalidChars' }],
  ['bidi isolate U+2066', 'abc\u2066def', { reason: 'invalidChars' }],
  ['zero-width space', 'ab\u200Bcd', { reason: 'invalidChars' }],
  ['zero-width joiner', 'ab\u200Dcd', { reason: 'invalidChars' }],
  ['word joiner', 'ab\u2060cd', { reason: 'invalidChars' }],
  ['BOM inside', 'ab\uFEFFcd', { reason: 'invalidChars' }],
  ['emoji', 'party-\u{1F389}', { reason: 'invalidChars' }],
  ['inner space', 'two words', { reason: 'invalidChars' }],
  ['ideographic space inside', 'ab\u3000cd', { reason: 'invalidChars' }],
  ['control char', 'ab\u0007cd', { reason: 'invalidChars' }],
  ['leading hyphen', '-abc', { reason: 'invalidChars' }],
  ['leading underscore', '_abc', { reason: 'invalidChars' }],
  ['leading combining mark', '\u0301abc', { reason: 'invalidChars' }],
  ['combining mark after hyphen', 'a-\u0301b', { reason: 'invalidChars' }],
  ['symbol', 'a#b', { reason: 'invalidChars' }],
  ['path traversal', 'a..b', { reason: 'invalidChars' }],
  ['modifier letter okina (Common script)', 'hawai\u02BBi', { reason: 'invalidChars' }],
  ['modifier letter prime', 'a\u02B9b', { reason: 'invalidChars' }],
  ['fullwidth symbol', 'a\uFF03b', { reason: 'invalidChars' }],
  ['latin + cyrillic e', 'g\u0435neral', { reason: 'mixedScripts' }],
  ['latin + cyrillic a (all looks latin)', 'p\u0430y', { reason: 'mixedScripts' }],
  ['latin + greek omicron', 'hell\u03BF', { reason: 'mixedScripts' }],
  ['cyrillic + greek', 'общий\u03B1', { reason: 'mixedScripts' }],
  ['latin + armenian o', 'g\u0585', { reason: 'mixedScripts' }],
  ['latin + bengali digit 4 (looks like 8)', 'room\u09EA', { reason: 'mixedScripts' }],
  ['korean + bengali digit', '팀\u09EA', { reason: 'mixedScripts' }],
  ['ascii digit + arabic-indic digit', '1\u0663', { reason: 'mixedScripts' }],
];

describe('Channel names (unicode)', () => {
  let token: string;
  let adminToken: string;

  const create = (name: unknown) =>
    request(app).post('/channels').set('Authorization', `Bearer ${token}`).send({ name });
  const adminEdit = (id: number, name: string) =>
    request(app).patch(`/admin/channels/${id}`).set('Authorization', `Bearer ${adminToken}`).send({ name });

  beforeEach(async () => {
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    const res = await request(app).post('/auth/register')
      .send({ email: 'cn-user@example.com', password: TEST_PASSWORD, name: 'CN User' });
    token = res.body.token;

    const adminRes = await request(app).post('/auth/register')
      .send({ email: 'cn-admin@example.com', password: TEST_PASSWORD, name: 'CN Admin' });
    await prisma.user.update({ where: { id: adminRes.body.user.id }, data: { role: 'ADMIN' } });
    const login = await request(app).post('/auth/login')
      .send({ email: 'cn-admin@example.com', password: TEST_PASSWORD });
    adminToken = login.body.token;
  });

  describe('normalize / validate (unit)', () => {
    it.each(VECTORS)('%s', (_label, input, expected) => {
      const result = validateChannelName(input);
      if (typeof expected === 'string') {
        expect(result).toEqual({ ok: true, name: expected });
        // 정규화는 멱등이어야 한다(저장된 이름을 다시 넣어도 같은 이름)
        expect(normalizeChannelName(expected)).toBe(expected);
        expect(checkChannelName(expected)).toBeNull();
      } else {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe(expected.reason);
          expect(result.code).toBe('CHANNEL_NAME_INVALID');
        }
      }
    });

    it('rejects non-string input', () => {
      const result = validateChannelName(123);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('required');
    });

    it('uses a separate message for too long names', () => {
      const short = validateChannelName('가'.repeat(CHANNEL_NAME_MAX + 1));
      expect(!short.ok && short.error).toMatch(new RegExp(`${CHANNEL_NAME_MAX} characters or fewer`));
      expect(validateChannelName('a'.repeat(CHANNEL_NAME_MAX)).ok).toBe(true);
    });
  });

  // 프런트와 백엔드 규칙이 어긋나지 않는지(복붙 드리프트) 같은 벡터로 비교한다.
  // 경로를 실행 시점에 만들어 백엔드 tsc(rootDir=src)가 프런트 파일을 따라가지 않게 한다.
  describe('frontend rules match backend', () => {
    type FrontendModule = {
      CHANNEL_NAME_MAX: number;
      normalizeChannelName: (input: string) => string;
      checkChannelName: (name: string, maxLength?: number) => ChannelNameReason | null;
    };
    let frontend: FrontendModule;

    beforeAll(async () => {
      const frontendPath = fileURLToPath(new URL('../../../frontend/src/lib/channelName.ts', import.meta.url));
      frontend = (await import(frontendPath)) as FrontendModule;
    });

    it('shares the length limits', () => {
      expect(frontend.CHANNEL_NAME_MAX).toBe(CHANNEL_NAME_MAX);
      expect(CHANNEL_NAME_MAX).toBe(80);
    });

    it.each(VECTORS)('%s', (_label, input, expected) => {
      const name = frontend.normalizeChannelName(input);
      expect(name).toBe(normalizeChannelName(input));
      const reason = frontend.checkChannelName(name);
      expect(reason).toBe(checkChannelName(name));
      expect(reason).toBe(typeof expected === 'string' ? null : expected.reason);
      if (typeof expected === 'string') expect(name).toBe(expected);
    });

    it('applies the shared limit the same way', () => {
      const long = 'a'.repeat(CHANNEL_NAME_MAX + 1);
      expect(frontend.checkChannelName(long)).toBe('tooLong');
      expect(frontend.checkChannelName(long.slice(1))).toBeNull();
    });
  });

  describe('CRUD with unicode names', () => {
    const names = ['개발팀', '프로젝트_a', '日本語', 'قناة', 'общий', 'ελληνικά'];

    it.each(names)('creates, reads, searches, renames and deletes %s (repeated)', async (name) => {
      for (let round = 0; round < 2; round++) {
        // Create
        const created = await create(name);
        expect(created.status).toBe(201);
        expect(created.body.name).toBe(name);
        const id = created.body.id;

        // Read: list + detail
        const list = await request(app).get('/channels').set('Authorization', `Bearer ${token}`);
        expect(list.status).toBe(200);
        const items = Array.isArray(list.body) ? list.body : list.body.items;
        expect(items.map((c: { name: string }) => c.name)).toContain(name);

        // Read: search by channel name (via a message in the channel)
        const msg = await request(app).post(`/channels/${id}/messages`)
          .set('Authorization', `Bearer ${token}`).send({ content: 'hello' });
        expect(msg.status).toBe(201);
        const search = await request(app).get('/search').query({ q: name })
          .set('Authorization', `Bearer ${token}`);
        expect(search.status).toBe(200);
        expect(JSON.stringify(search.body)).toContain(name);

        // Update (admin rename)
        const renamed = await adminEdit(id, `${name}_2`);
        expect(renamed.status).toBe(200);
        expect(renamed.body.name).toBe(`${name}_2`);

        // Delete (permanent, admin) then read fails
        const del = await request(app).delete(`/admin/channels/${id}`)
          .set('Authorization', `Bearer ${adminToken}`);
        expect(del.status).toBeLessThan(300);
        const after = await request(app).get('/channels').set('Authorization', `Bearer ${token}`);
        const afterItems = Array.isArray(after.body) ? after.body : after.body.items;
        expect(afterItems.map((c: { name: string }) => c.name)).not.toContain(`${name}_2`);
      }
    });

    it('normalizes uppercase and surrounding spaces', async () => {
      const res = await create('  Project_A ');
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('project_a');
    });

    it('folds fullwidth names (NFKC) through create, read, rename and delete (repeated)', async () => {
      for (let round = 0; round < 2; round++) {
        // Create: 전각 입력은 ASCII 이름으로 저장된다
        const created = await create('ｌｏｂｂｙ');
        expect(created.status).toBe(201);
        expect(created.body.name).toBe('lobby');
        const id = created.body.id;

        // 같은 이름의 ASCII·전각 대문자 입력은 중복이다
        for (const dupName of ['lobby', 'ＬＯＢＢＹ', 'ｌｏｂｂｙ']) {
          const dup = await create(dupName);
          expect(dup.status).toBe(400);
          expect(dup.body.code).toBe('CHANNEL_NAME_TAKEN');
        }

        // Read
        const list = await request(app).get('/channels').set('Authorization', `Bearer ${token}`);
        const items = Array.isArray(list.body) ? list.body : list.body.items;
        expect(items.map((c: { name: string }) => c.name)).toContain('lobby');

        // Update: 관리자 이름 변경도 NFKC로 접는다
        const renamed = await adminEdit(id, 'ｄｅｖ－ｔｅａｍ');
        expect(renamed.status).toBe(200);
        expect(renamed.body.name).toBe('dev-team');

        // Delete then read fails
        const del = await request(app).delete(`/admin/channels/${id}`)
          .set('Authorization', `Bearer ${adminToken}`);
        expect(del.status).toBeLessThan(300);
        const after = await request(app).get('/channels').set('Authorization', `Bearer ${token}`);
        const afterItems = Array.isArray(after.body) ? after.body : after.body.items;
        expect(afterItems.map((c: { name: string }) => c.name)).not.toContain('dev-team');
      }
    });
  });

  describe('rejections', () => {
    const bad = VECTORS.filter((v): v is [string, string, { reason: ChannelNameReason }] => typeof v[2] !== 'string');

    it.each(bad)('rejects %s on create with CHANNEL_NAME_INVALID', async (_label, name) => {
      const res = await create(name);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CHANNEL_NAME_INVALID');
      expect(typeof res.body.error).toBe('string');
    });

    it('rejects non-string name', async () => {
      const res = await create(123);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CHANNEL_NAME_INVALID');
    });

    it('rejects over the max code points but accepts exactly the max Hangul syllables', async () => {
      const long = await create('가'.repeat(CHANNEL_NAME_MAX + 1));
      expect(long.status).toBe(400);
      expect(long.body.error).toMatch(new RegExp(`${CHANNEL_NAME_MAX} characters or fewer`));
      expect((await create('가'.repeat(CHANNEL_NAME_MAX))).status).toBe(201);
    });

    it('rejects zalgo names with CHANNEL_NAME_INVALID and accepts normal combining marks', async () => {
      const zalgo = await create('x\u0300\u0301\u0302\u0303\u0304');
      expect(zalgo.status).toBe(400);
      expect(zalgo.body.code).toBe('CHANNEL_NAME_INVALID');
      expect(zalgo.body.reason).toBe('tooManyMarks');
      for (const ok of ['हिन्दी', 'قَنَاةٌ', 'tiếng-việt'.normalize('NFD')]) {
        expect((await create(ok)).status).toBe(201);
      }
    });

    it('rejects the same name arriving as NFD as a duplicate', async () => {
      const nfc = '한글팀';
      expect((await create(nfc)).status).toBe(201);
      const dup = await create(nfc.normalize('NFD'));
      expect(dup.status).toBe(400);
      expect(dup.body.error).toMatch(/already exists/);
    });

    it('rejects a look-alike of an existing channel (latin + cyrillic)', async () => {
      expect((await create('lobby')).status).toBe(201);
      const fake = await create('l\u043Ebby');
      expect(fake.status).toBe(400);
      expect(fake.body.code).toBe('CHANNEL_NAME_INVALID');
    });
  });

  describe('admin rename', () => {
    it.each(VECTORS.filter((v) => typeof v[2] !== 'string' && v[2].reason !== 'tooLong'))(
      'rejects %s with CHANNEL_NAME_INVALID',
      async (_label, name) => {
        const created = await create('rename-me');
        const res = await adminEdit(created.body.id, name);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CHANNEL_NAME_INVALID');
      },
    );

    it('uses the admin length limit with its own message', async () => {
      const created = await create('rename-me');
      const id = created.body.id;
      const tooLong = await adminEdit(id, 'a'.repeat(81));
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error).toMatch(/80 characters or fewer/);
      const ok = await adminEdit(id, 'a'.repeat(80));
      expect(ok.status).toBe(200);
    });

    it('renames to a unicode name and rejects NFD/fullwidth renames onto existing names', async () => {
      const created = await create('rename-me');
      const id = created.body.id;
      const ok = await adminEdit(id, '개발팀');
      expect(ok.status).toBe(200);
      expect(ok.body.name).toBe('개발팀');

      // 한글은 NFD와 NFC가 다르다(日本語는 같아서 이 검사가 의미 없다)
      expect('한글팀'.normalize('NFD')).not.toBe('한글팀');
      expect((await create('한글팀')).status).toBe(201);
      const nfdDup = await adminEdit(id, '한글팀'.normalize('NFD'));
      expect(nfdDup.status).toBe(409);
      expect(nfdDup.body.code).toBe('CHANNEL_NAME_TAKEN');

      expect((await create('lobby')).status).toBe(201);
      const fullwidthDup = await adminEdit(id, 'ｌｏｂｂｙ');
      expect(fullwidthDup.status).toBe(409);
      expect(fullwidthDup.body.code).toBe('CHANNEL_NAME_TAKEN');

      const unchanged = await request(app).get('/channels').set('Authorization', `Bearer ${token}`);
      const items = Array.isArray(unchanged.body) ? unchanged.body : unchanged.body.items;
      expect(items.find((c: { id: number }) => c.id === id)?.name).toBe('개발팀');
    });

    it('returns 409 CHANNEL_NAME_TAKEN when the unique constraint fires (race after the duplicate check)', async () => {
      const created = await create('rename-me');
      expect((await create('taken')).status).toBe(201);
      // 중복 검사(워크스페이스 단위 nameKey 조회, E1c)와 update 사이에 다른 요청이 같은 이름을 저장한 상황을 만든다
      const spy = jest.spyOn(prisma.channelWorkspace, 'findFirst').mockResolvedValueOnce(null);
      try {
        const res = await adminEdit(created.body.id, 'taken');
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CHANNEL_NAME_TAKEN');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
