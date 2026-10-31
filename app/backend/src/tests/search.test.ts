import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { clearTokenCache } from '../middleware/auth.js';
import { settleBackgroundWork as settle } from '../services/mentionService.js';

// 파트 08: 검색 v2(연산자 필터, 탭, 하이라이트, 페이지네이션, 권한, NFC) 통합 테스트

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-srch@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const search = (u: TestUser, params: Record<string, string | number>) =>
  request(app).get('/search').query(params).set(auth(u));
const contents = (res: request.Response) => (res.body.results as any[]).map((r) => r.content);

describe('Search v2', () => {
  let alice: TestUser, bob: TestUser, carol: TestUser, gus: TestUser, eve: TestUser;
  let pub: number, priv: number, guestCh: number;

  const post = async (u: TestUser, channelId: number, content: string, extra: object = {}) => {
    const res = await request(app).post(`/channels/${channelId}/messages`).set(auth(u)).send({ content, ...extra });
    expect(res.status).toBe(201);
    return res.body.id as number;
  };

  beforeAll(async () => {
    [alice, bob, carol, gus, eve] = [
      await register('Alicesr'), await register('Bobsr'), await register('Carolsr'), await register('Gussr'), await register('Evesr'),
    ];
    await prisma.user.update({ where: { id: gus.id }, data: { role: 'GUEST' } });
    // 가입 때 기본 채널에 들어가므로 게스트를 만든 뒤 멤버십을 비운다(게스트는 기본 채널에 없다)
    await prisma.channelMember.deleteMany({ where: { userId: gus.id } });
    clearTokenCache();
    const mk = async (name: string, isPrivate: boolean, members: TestUser[]) => {
      const c = await prisma.channel.create({ data: { name, isPrivate, createdBy: alice.id } });
      await prisma.channelMember.createMany({ data: members.map((m) => ({ userId: m.id, channelId: c.id })) });
      return c.id;
    };
    pub = await mk('srch-public', false, [alice, bob, carol]);
    priv = await mk('srch-private', true, [alice]);
    guestCh = await mk('srch-guest', false, [alice, gus]);
  });

  describe('validation', () => {
    it('rejects too short keyword-only queries and accepts operator-only queries', async () => {
      expect((await search(alice, { q: 'a' })).status).toBe(400);
      expect((await search(alice, { q: '' })).status).toBe(400);
      expect((await search(alice, { q: 'x'.repeat(201) })).status).toBe(400);
      expect((await search(alice, { q: 'from:@nobody' })).status).toBe(200);
      expect((await request(app).get('/search').query({ q: 'ab' })).status).toBe(401);
    });

    it('rejects invalid type/sort/limit and ignores a broken cursor', async () => {
      expect((await search(alice, { q: 'ab', type: 'bogus' })).status).toBe(400);
      expect((await search(alice, { q: 'ab', sort: 'bogus' })).status).toBe(400);
      expect((await search(alice, { q: 'ab', limit: 500 })).status).toBe(400);
      expect((await search(alice, { q: 'ab', cursor: '!!!' })).status).toBe(200);
    });

    it('treats LIKE wildcards literally', async () => {
      await post(alice, pub, 'discount 100% off today');
      await post(alice, pub, 'discount 100 percent');
      const res = await search(alice, { q: '"100%"' });
      expect(contents(res)).toEqual(['discount 100% off today']);
      const under = await search(alice, { q: 'in:srch-public "t_oday"' });
      expect(contents(under)).toEqual([]);
    });
  });

  describe('filters', () => {
    let fileMsg: number, pinned: number, reacted: number, parent: number;

    beforeAll(async () => {
      await post(alice, pub, 'plan alpha kickoff');
      await post(bob, pub, 'plan beta kickoff');
      await post(alice, priv, 'plan secret kickoff');
      fileMsg = await post(bob, pub, 'plan with attachment kickoff');
      await prisma.file.create({
        data: { filename: 'f1.txt', originalName: 'budget-report.txt', mimetype: 'text/plain', size: 10, url: '/files/x', userId: bob.id, messageId: fileMsg },
      });
      pinned = await post(alice, pub, 'plan pinned kickoff');
      await request(app).post(`/messages/${pinned}/pin`).set(auth(alice));
      reacted = await post(carol, pub, 'plan reacted kickoff');
      await request(app).post(`/messages/${reacted}/reactions`).set(auth(bob)).send({ emoji: '👍' });
      await post(carol, pub, 'plan link kickoff https://example.com/x');
      parent = await post(alice, pub, 'plan thread parent kickoff');
      await post(bob, pub, 'plan thread reply kickoff', { threadId: parent });
    });

    it('from: filters by author, with or without @', async () => {
      const a = await search(alice, { q: 'from:@Bobsr plan' });
      expect(contents(a)).toEqual(expect.arrayContaining(['plan beta kickoff']));
      expect((a.body.results as any[]).every((r) => r.user.name === 'Bobsr')).toBe(true);
      const b = await search(alice, { q: 'from:bobsr plan' });
      expect(b.body.results.length).toBe(a.body.results.length);
      expect(a.body.parsedFilters.from).toEqual(['Bobsr']);
    });

    it('in: filters by channel and accepts several', async () => {
      const onlyPub = await search(alice, { q: 'in:#srch-public plan' });
      expect((onlyPub.body.results as any[]).every((r) => r.channel.id === pub)).toBe(true);
      const both = await search(alice, { q: 'in:srch-public in:srch-private secret' });
      expect(contents(both)).toEqual(['plan secret kickoff']);
    });

    it('operator-only queries work and keyword terms are ANDed', async () => {
      const onlyFrom = await search(alice, { q: 'from:@Alicesr in:srch-private' });
      expect(contents(onlyFrom)).toEqual(['plan secret kickoff']);
      expect(contents(await search(alice, { q: 'plan alpha' }))).toEqual(['plan alpha kickoff']);
      expect(contents(await search(alice, { q: 'plan nonexistentword' }))).toEqual([]);
    });

    it('before:/after:/on: filter by date (UTC)', async () => {
      const id = await post(alice, pub, 'dated message zeta');
      await prisma.message.update({ where: { id }, data: { createdAt: new Date('2026-09-15T12:00:00Z') } });
      expect(contents(await search(alice, { q: 'zeta before:2026-09-16' }))).toEqual(['dated message zeta']);
      expect(contents(await search(alice, { q: 'zeta before:2026-09-15' }))).toEqual([]);
      expect(contents(await search(alice, { q: 'zeta after:2026-09-14' }))).toEqual(['dated message zeta']);
      expect(contents(await search(alice, { q: 'zeta after:2026-09-15' }))).toEqual([]);
      expect(contents(await search(alice, { q: 'zeta on:2026-09-15' }))).toEqual(['dated message zeta']);
      expect(contents(await search(alice, { q: 'zeta on:2026-09-16' }))).toEqual([]);
      // 형식 오류 날짜는 일반 단어로 취급되어 결과가 없다(400이 아님)
      const bad = await search(alice, { q: 'zeta before:2026-99-99' });
      expect(bad.status).toBe(200);
      expect(contents(bad)).toEqual([]);
    });

    it('has:file, has:link, has:pin, has:reaction', async () => {
      expect(contents(await search(alice, { q: 'has:file kickoff' }))).toEqual(['plan with attachment kickoff']);
      expect(contents(await search(alice, { q: 'has:link kickoff' }))).toEqual(['plan link kickoff https://example.com/x']);
      expect(contents(await search(alice, { q: 'has:pin kickoff' }))).toEqual(['plan pinned kickoff']);
      expect(contents(await search(alice, { q: 'has:reaction kickoff' }))).toEqual(['plan reacted kickoff']);
    });

    it('is:thread matches parents with replies and replies; is:saved matches bookmarks', async () => {
      const t = contents(await search(alice, { q: 'is:thread kickoff', sort: 'recent' }));
      expect(t).toEqual(['plan thread reply kickoff', 'plan thread parent kickoff']);
      await prisma.bookmark.create({ data: { userId: alice.id, messageId: pinned } });
      expect(contents(await search(alice, { q: 'is:saved kickoff' }))).toEqual(['plan pinned kickoff']);
      expect(contents(await search(bob, { q: 'is:saved kickoff' }))).toEqual([]);
    });

    it('unknown operators are plain words', async () => {
      expect(contents(await search(alice, { q: 'foo:bar' }))).toEqual([]);
      await post(alice, pub, 'ratio is 3:4 today');
      expect(contents(await search(alice, { q: '3:4' }))).toEqual(['ratio is 3:4 today']);
    });

    it('returns highlight offsets for the matched content', async () => {
      const res = await search(alice, { q: 'ALPHA' });
      const item = res.body.results.find((r: any) => r.content === 'plan alpha kickoff');
      expect(item.highlights).toEqual([[5, 10]]);
    });

    it('sort=recent orders newest first; relevance puts author-name matches first', async () => {
      const recent = await search(alice, { q: 'from:@Alicesr in:srch-public plan', sort: 'recent' });
      const times = (recent.body.results as any[]).map((r) => new Date(r.createdAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });
  });

  describe('permissions', () => {
    it('does not leak private channels or non-member in: filters', async () => {
      expect(contents(await search(bob, { q: 'secret' }))).toEqual([]);
      expect(contents(await search(bob, { q: 'in:srch-private secret' }))).toEqual([]);
      expect(contents(await search(bob, { q: 'secret', channelId: priv }))).toEqual([]);
      expect(contents(await search(alice, { q: 'secret' }))).toEqual(['plan secret kickoff']);
      // 비멤버의 in:은 존재 여부를 알 수 없게 존재하지 않는 채널과 똑같이 보인다
      const real = await search(bob, { q: 'in:srch-private plan' });
      const fake = await search(bob, { q: 'in:srch-nothing plan' });
      expect(real.body.results).toEqual(fake.body.results);
    });

    it('does not leak other users DMs', async () => {
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'dm private banana' });
      expect(contents(await search(alice, { q: 'banana' }))).toEqual(['dm private banana']);
      expect(contents(await search(bob, { q: 'banana' }))).toEqual(['dm private banana']);
      expect(contents(await search(carol, { q: 'banana' }))).toEqual([]);
      expect(contents(await search(carol, { q: 'from:@Alicesr banana' }))).toEqual([]);
    });

    it('group DMs are visible to current members only, guests included', async () => {
      const g = await request(app).post('/dms/groups').set(auth(alice)).send({ userIds: [bob.id, eve.id] });
      expect(g.status).toBeLessThan(300);
      const groupId = g.body.group.id;
      // 멤버가 나중에 게스트로 강등된 경우를 흉내 낸다(게스트는 새 그룹을 만들 수 없다)
      await prisma.dMGroupMember.create({ data: { groupId, userId: gus.id } });
      await request(app).post(`/dms/groups/${groupId}/messages`).set(auth(alice)).send({ content: 'group mango plan' });
      for (const u of [alice, bob, gus]) {
        expect(contents(await search(u, { q: 'mango' }))).toEqual(['group mango plan']);
      }
      expect(contents(await search(carol, { q: 'mango' }))).toEqual([]);
      // 나간 멤버는 더 이상 검색하지 못한다
      await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(bob));
      expect(contents(await search(bob, { q: 'mango' }))).toEqual([]);
      expect(contents(await search(gus, { q: 'mango' }))).toEqual(['group mango plan']);
    });

    it('guests see only their channels, not public ones they have not joined', async () => {
      await post(alice, guestCh, 'guest visible kiwi');
      await post(alice, pub, 'guest hidden kiwi');
      expect(contents(await search(gus, { q: 'kiwi' }))).toEqual(['guest visible kiwi']);
    });

    it('guest 1:1 DM search is limited to shared-channel members', async () => {
      await request(app).post('/dms').set(auth(carol)).send({ toUserId: gus.id, content: 'dm to guest papaya' });
      // 게스트와 carol은 공유 채널이 없다
      expect(contents(await search(gus, { q: 'papaya' }))).toEqual([]);
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: gus.id, content: 'dm from alice papaya' });
      expect(contents(await search(gus, { q: 'papaya' }))).toEqual(['dm from alice papaya']);
    });
  });

  describe('tabs', () => {
    it('files tab searches filenames in accessible conversations only', async () => {
      const ok = await search(alice, { q: 'budget', type: 'files' });
      expect(ok.body.results.map((f: any) => f.filename)).toEqual(['budget-report.txt']);
      expect(ok.body.results[0].type).toBe('file');
      expect((await search(gus, { q: 'budget', type: 'files' })).body.results).toEqual([]);
      const hidden = await prisma.message.create({ data: { content: 'x', userId: alice.id, channelId: priv } });
      await prisma.file.create({
        data: { filename: 'p.txt', originalName: 'private-budget.txt', mimetype: 'text/plain', size: 1, url: '/f', userId: alice.id, messageId: hidden.id },
      });
      const bobFiles = await search(bob, { q: 'budget', type: 'files' });
      expect(bobFiles.body.results.map((f: any) => f.filename)).toEqual(['budget-report.txt']);
      const aliceFiles = await search(alice, { q: 'budget', type: 'files' });
      expect(aliceFiles.body.results.length).toBe(2);
      expect((await search(alice, { q: 'from:@Bobsr budget', type: 'files' })).body.results.length).toBe(1);
    });

    it('people tab finds users by name; guests only see shared-channel members', async () => {
      const res = await search(alice, { q: 'sr', type: 'people' });
      expect(res.body.results.map((u: any) => u.name)).toEqual(expect.arrayContaining(['Alicesr', 'Bobsr']));
      expect(res.body.results[0]).not.toHaveProperty('email');
      const g = await search(gus, { q: 'sr', type: 'people' });      expect(g.body.results.map((u: any) => u.name).sort()).toEqual(['Alicesr', 'Gussr']);
    });

    it('channels tab lists public channels and own private ones only', async () => {
      const a = await search(alice, { q: 'srch', type: 'channels' });
      expect(a.body.results.map((c: any) => c.name)).toEqual(['srch-guest', 'srch-private', 'srch-public']);
      const b = await search(bob, { q: 'srch', type: 'channels' });
      expect(b.body.results.map((c: any) => c.name)).toEqual(['srch-guest', 'srch-public']);
      const g = await search(gus, { q: 'srch', type: 'channels' });
      expect(g.body.results.map((c: any) => c.name)).toEqual(['srch-guest']);
    });

    it('dms type and messages type are separated', async () => {
      const dms = await search(alice, { q: 'banana', type: 'dms' });
      expect(dms.body.results.map((r: any) => r.type)).toEqual(['dm']);
      expect((await search(alice, { q: 'banana', type: 'messages' })).body.results).toEqual([]);
    });
  });

  describe('NFC / NFD Korean', () => {
    it('finds NFC and NFD content with an NFD or NFC query', async () => {
      const nfcMsg = await post(alice, pub, '오늘 회의록 공유합니다');
      const nfdMsg = await post(alice, pub, '내일 기획안 공유합니다'.normalize('NFD'));
      const q1 = await search(alice, { q: '회의록'.normalize('NFD') });
      expect(q1.body.results.map((r: any) => r.id)).toEqual([nfcMsg]);
      const q2 = await search(alice, { q: '기획안' });
      expect(q2.body.results.map((r: any) => r.id)).toEqual([nfdMsg]);
      const q3 = await search(alice, { q: '공유'.normalize('NFD'), sort: 'recent' });
      expect(q3.body.results.map((r: any) => r.id)).toEqual([nfdMsg, nfcMsg]);
      expect(q3.body.parsedFilters.terms).toEqual(['공유']);
      // 하이라이트는 저장된 본문(NFD) 기준 오프셋이다
      const hl = q3.body.results[0].highlights[0];
      expect(q3.body.results[0].content.slice(hl[0], hl[1])).toBe('공유'.normalize('NFD'));
    });

    it('matches Korean author names with from:', async () => {
      const kimRes = await request(app).post('/auth/register')
        .send({ email: 'kimseochi-srch@example.com', password: TEST_PASSWORD, name: '김서치' });
      const kim: TestUser = { id: kimRes.body.user.id, token: kimRes.body.token, name: '김서치' };
      await prisma.channelMember.create({ data: { userId: kim.id, channelId: pub } });
      await post(kim, pub, 'korean author message');
      const res = await search(alice, { q: `from:@${'김서치'.normalize('NFD')}` });
      expect(contents(res)).toEqual(['korean author message']);
    });
  });

  describe('pagination', () => {
    it('pages through results with the cursor without duplicates', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 25; i++) ids.push(await post(alice, pub, `pagetoken item ${i}`));
      const seen: number[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await search(alice, { q: 'pagetoken', sort: 'recent', limit: 10, ...(cursor ? { cursor } : {}) });
        expect(res.status).toBe(200);
        seen.push(...res.body.results.map((r: any) => r.id));
        cursor = res.body.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
    });
  });

  describe('CRUD loop: create, search, update, search, delete, search', () => {
    it('reflects edits and deletes in results across rounds', async () => {
      for (let round = 0; round < 3; round++) {
        const id = await post(alice, pub, `crudword${round} original`);
        expect(contents(await search(alice, { q: `crudword${round}` }))).toEqual([`crudword${round} original`]);

        const edit = await request(app).patch(`/messages/${id}`).set(auth(alice)).send({ content: `edited${round} newcontent` });
        expect(edit.status).toBe(200);
        expect(contents(await search(alice, { q: `crudword${round}` }))).toEqual([]);
        expect(contents(await search(alice, { q: `edited${round}` }))).toEqual([`edited${round} newcontent`]);

        const del = await request(app).delete(`/messages/${id}`).set(auth(alice));
        expect(del.status).toBeLessThan(300);
        expect(contents(await search(alice, { q: `edited${round}` }))).toEqual([]);
      }
    });

    it('DM edit and delete are reflected too', async () => {
      const sent = await request(app).post('/dms').set(auth(alice)).send({ toUserId: carol.id, content: 'dmcrud original' });
      const id = sent.body.id;
      expect(contents(await search(carol, { q: 'dmcrud' }))).toEqual(['dmcrud original']);
      await request(app).patch(`/dms/messages/${id}`).set(auth(alice)).send({ content: 'dmedited changed' });
      expect(contents(await search(carol, { q: 'dmcrud' }))).toEqual([]);
      expect(contents(await search(carol, { q: 'dmedited' }))).toEqual(['dmedited changed']);
      await request(app).delete(`/dms/messages/${id}`).set(auth(alice));
      expect(contents(await search(carol, { q: 'dmedited' }))).toEqual([]);
    });
  });

  describe('performance (recorded only)', () => {
    it('answers one request over ~1000 messages', async () => {
      await prisma.message.createMany({
        data: Array.from({ length: 1000 }, (_, i) => ({ content: `bulkperf message number ${i} filler text`, userId: alice.id, channelId: pub })),
      });
      const t0 = Date.now();
      const res = await search(alice, { q: 'bulkperf number from:@Alicesr', limit: 20 });
      const ms = Date.now() - t0;
      console.log(`[search perf] 1000 messages, one request: ${ms}ms`);
      expect(res.status).toBe(200);
      expect(res.body.results.length).toBe(20);
      expect(res.body.hasMore).toBe(true);
    });
  });

  afterAll(async () => { await settle(); });
});
