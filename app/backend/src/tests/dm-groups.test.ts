import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { listenOnLoopback } from './listenLoopback.js';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { clearTokenCache } from '../middleware/auth.js';
import { settleBackgroundWork as settle } from '../services/mentionService.js';

// 파트 02: 그룹 DM(생성·재사용, 메시지 CRUD, 스레드·리액션·핀·파일, 멤버 추가·나가기, 읽음, 소켓, 권한)

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-gdm@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const mention = (u: TestUser) => `<@${u.id}|${u.name}>`;

async function waitFor<T>(fn: () => Promise<T> | T, predicate: (v: T) => boolean = Boolean, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Group DMs', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  let alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser, eve: TestUser, zed: TestUser;
  let extras: TestUser[];
  const sockets: ClientSocket[] = [];

  const createGroup = (u: TestUser, userIds: number[]) =>
    request(app).post('/dms/groups').set(auth(u)).send({ userIds });
  const send = (u: TestUser, groupId: number, content: string, extra: object = {}) =>
    request(app).post(`/dms/groups/${groupId}/messages`).set(auth(u)).send({ content, ...extra });
  const messagesOf = (u: TestUser, groupId: number) =>
    request(app).get(`/dms/groups/${groupId}/messages`).set(auth(u));
  const listOf = async (u: TestUser) => {
    await settle();
    return (await request(app).get('/dms/groups').set(auth(u))).body as any[];
  };

  function connect(u: TestUser): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = Client(`http://127.0.0.1:${port}`, { auth: { token: u.token }, forceNew: true });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  function collect(s: ClientSocket, event: string): any[] {
    const received: any[] = [];
    s.on(event, (p) => received.push(p));
    return received;
  }

  beforeAll(async () => {
    await prisma.activity.deleteMany();
    await prisma.dMReaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.directMessage.deleteMany();
    await prisma.dMGroup.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    [alice, bob, carol, dave, eve, zed] = [
      await register('Alice'), await register('Bob'), await register('Carol'),
      await register('Dave'), await register('Eve'), await register('Zed'),
    ];
    extras = [];
    for (let i = 0; i < 6; i++) extras.push(await register(`Extra${i}`));
    await prisma.user.update({ where: { id: zed.id }, data: { deactivatedAt: new Date() } });

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    port = await listenOnLoopback(httpServer);
  });

  afterEach(() => {
    sockets.splice(0).forEach((s) => s.disconnect());
  });

  afterAll(async () => {
    io.close();
    httpServer.close();
  });

  beforeEach(async () => {
    await settle();
    await prisma.activity.deleteMany();
    await prisma.dMReaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.directMessage.deleteMany();
    await prisma.dMGroup.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
  });

  describe('POST /dms/groups', () => {
    it('creates a group with 2 others and reuses it for the same member set', async () => {
      const res = await createGroup(alice, [bob.id, carol.id]);
      expect(res.status).toBe(201);
      expect(res.body.created).toBe(true);
      expect(res.body.group.members.map((m: any) => m.id).sort()).toEqual([alice.id, bob.id, carol.id].sort());

      // 같은 집합(순서·본인 포함·중복 무관)이면 기존 그룹
      const again = await createGroup(bob, [carol.id, alice.id, bob.id, carol.id]);
      expect(again.status).toBe(200);
      expect(again.body.created).toBe(false);
      expect(again.body.group.id).toBe(res.body.group.id);
      expect(await prisma.dMGroup.count()).toBe(1);
    });

    it('allows up to 8 others (9 total) and rejects 1 other, 9 others, and deactivated or unknown users', async () => {
      const eight = [bob, carol, dave, eve, ...extras.slice(0, 4)].map((u) => u.id);
      expect((await createGroup(alice, eight)).status).toBe(201);

      expect((await createGroup(alice, [bob.id])).status).toBe(400);
      expect((await createGroup(alice, [alice.id, bob.id])).status).toBe(400);
      expect((await createGroup(alice, [...eight, extras[4].id])).status).toBe(400);
      expect((await createGroup(alice, [bob.id, zed.id])).status).toBe(400);
      expect((await createGroup(alice, [bob.id, 999999])).status).toBe(400);
      expect((await createGroup(alice, [])).status).toBe(400);
      expect((await request(app).post('/dms/groups').set(auth(alice)).send({ userIds: 'x' })).status).toBe(400);
    });

    it('returns one group when the same set is created concurrently', async () => {
      const results = await Promise.all([
        createGroup(alice, [bob.id, carol.id]),
        createGroup(bob, [alice.id, carol.id]),
        createGroup(carol, [alice.id, bob.id]),
      ]);
      const ids = new Set(results.map((r) => r.body.group.id));
      expect(ids.size).toBe(1);
      expect(await prisma.dMGroup.count()).toBe(1);
    });

    it('requires authentication', async () => {
      expect((await request(app).post('/dms/groups').send({ userIds: [bob.id, carol.id] })).status).toBe(401);
    });
  });

  describe('messages CRUD', () => {
    it('sends, reads, edits, and deletes group messages repeatedly (CRUD loop)', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;

      for (let round = 1; round <= 2; round++) {
        // Create
        const sent = await send(alice, groupId, `hello ${round}`);
        expect(sent.status).toBe(201);
        expect(sent.body.groupId).toBe(groupId);
        expect(sent.body.toUserId).toBeNull();
        const dmId = sent.body.id;

        // Read (다른 멤버)
        let read = await messagesOf(carol, groupId);
        expect(read.status).toBe(200);
        expect(read.body.messages.map((m: any) => m.content)).toContain(`hello ${round}`);
        expect(read.body.group.members).toHaveLength(3);

        // Update: 작성자만
        expect((await request(app).patch(`/dms/messages/${dmId}`).set(auth(bob)).send({ content: 'hack' })).status).toBe(403);
        const edited = await request(app).patch(`/dms/messages/${dmId}`).set(auth(alice)).send({ content: `edited ${round}` });
        expect(edited.status).toBe(200);
        expect(edited.body.editedAt).not.toBeNull();
        read = await messagesOf(bob, groupId);
        expect(read.body.messages.find((m: any) => m.id === dmId).content).toBe(`edited ${round}`);

        // Delete: 작성자만, 지운 뒤에는 안 보이고 메시지 단위 접근은 404
        expect((await request(app).delete(`/dms/messages/${dmId}`).set(auth(carol))).status).toBe(403);
        expect((await request(app).delete(`/dms/messages/${dmId}`).set(auth(alice))).status).toBe(200);
        read = await messagesOf(bob, groupId);
        expect(read.body.messages.find((m: any) => m.id === dmId)).toBeUndefined();
        expect((await request(app).get(`/dms/messages/${dmId}/thread`).set(auth(bob))).status).toBe(404);
      }
    });

    it('validates message body and paginates with a cursor', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      expect((await send(alice, groupId, '')).status).toBe(400);
      expect((await send(alice, groupId, 'a\u0000b')).status).toBe(400);

      for (let i = 0; i < 5; i++) await send(bob, groupId, `m${i}`);
      const first = await request(app).get(`/dms/groups/${groupId}/messages?limit=3`).set(auth(alice));
      expect(first.body.messages.map((m: any) => m.content)).toEqual(['m4', 'm3', 'm2']);
      expect(first.body.hasMore).toBe(true);
      const second = await request(app)
        .get(`/dms/groups/${groupId}/messages?limit=3&cursor=${first.body.nextCursor}`)
        .set(auth(alice));
      expect(second.body.messages.map((m: any) => m.content)).toEqual(['m1', 'm0']);
      expect(second.body.hasMore).toBe(false);
    });

    it('supports threads, reactions, pins, and file attachments on group messages', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      const parent = (await send(alice, groupId, 'parent')).body;

      // 스레드
      const reply = await request(app).post(`/dms/messages/${parent.id}/reply`).set(auth(bob)).send({ content: 'reply' });
      expect(reply.status).toBe(201);
      expect(reply.body.groupId).toBe(groupId);
      expect(reply.body.threadId).toBe(parent.id);
      const thread = await request(app).get(`/dms/messages/${parent.id}/thread`).set(auth(carol));
      expect(thread.status).toBe(200);
      expect(thread.body.replies.map((r: any) => r.content)).toEqual(['reply']);
      // 답글은 본문 목록에 나오지 않는다
      const main = await messagesOf(carol, groupId);
      expect(main.body.messages.map((m: any) => m.content)).toEqual(['parent']);
      expect(main.body.messages[0]._count.replies).toBe(1);

      // 리액션
      expect((await request(app).post(`/dms/messages/${parent.id}/reactions`).set(auth(carol)).send({ emoji: 'thumbsup' })).status).toBe(201);
      let msgs = (await messagesOf(bob, groupId)).body.messages;
      expect(msgs[0].reactions.map((r: any) => r.emoji)).toEqual(['thumbsup']);
      expect((await request(app).delete(`/dms/messages/${parent.id}/reactions/thumbsup`).set(auth(carol))).status).toBe(200);
      msgs = (await messagesOf(bob, groupId)).body.messages;
      expect(msgs[0].reactions).toHaveLength(0);

      // 핀
      expect((await request(app).post(`/dms/messages/${parent.id}/pin`).set(auth(bob))).status).toBe(200);
      let pins = await request(app).get(`/dms/groups/${groupId}/pins`).set(auth(carol));
      expect(pins.body.map((p: any) => p.id)).toEqual([parent.id]);
      expect((await request(app).delete(`/dms/messages/${parent.id}/pin`).set(auth(bob))).status).toBe(200);
      pins = await request(app).get(`/dms/groups/${groupId}/pins`).set(auth(carol));
      expect(pins.body).toHaveLength(0);

      // 파일: 멤버는 받을 수 있고, 비멤버는 404
      const upload = await request(app).post('/files').set(auth(alice)).attach('file', Buffer.from('group file'), 'group.txt');
      expect(upload.status).toBe(201);
      const withFile = await send(alice, groupId, 'see file', { fileIds: [upload.body.id] });
      expect(withFile.status).toBe(201);
      expect(withFile.body.files.map((f: any) => f.id)).toEqual([upload.body.id]);
      expect((await request(app).get(`/files/${upload.body.id}`).set(auth(carol))).status).toBe(200);
      expect((await request(app).get(`/files/${upload.body.id}`).set(auth(eve))).status).toBe(404);
    });
  });

  describe('access control', () => {
    it('denies every group endpoint and message-level endpoint to non-members', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      const dmId = (await send(alice, groupId, 'secret')).body.id;

      expect((await request(app).get(`/dms/groups/${groupId}`).set(auth(eve))).status).toBe(404);
      expect((await messagesOf(eve, groupId)).status).toBe(404);
      expect((await send(eve, groupId, 'intrude')).status).toBe(404);
      expect((await request(app).patch(`/dms/groups/${groupId}`).set(auth(eve)).send({ name: 'x' })).status).toBe(404);
      expect((await request(app).post(`/dms/groups/${groupId}/members`).set(auth(eve)).send({ userIds: [eve.id] })).status).toBe(404);
      expect((await request(app).post(`/dms/groups/${groupId}/read`).set(auth(eve))).status).toBe(404);
      expect((await request(app).get(`/dms/groups/${groupId}/pins`).set(auth(eve))).status).toBe(404);
      expect((await request(app).put(`/dms/groups/${groupId}/star`).set(auth(eve))).status).toBe(404);
      expect((await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(eve))).status).toBe(404);

      expect((await request(app).get(`/dms/messages/${dmId}/thread`).set(auth(eve))).status).toBe(403);
      expect((await request(app).post(`/dms/messages/${dmId}/reply`).set(auth(eve)).send({ content: 'x' })).status).toBe(403);
      expect((await request(app).post(`/dms/messages/${dmId}/reactions`).set(auth(eve)).send({ emoji: 'smile' })).status).toBe(403);
      expect((await request(app).post(`/dms/messages/${dmId}/pin`).set(auth(eve))).status).toBe(403);

      // 그룹 목록·검색·1:1 목록에도 새지 않는다
      expect(await listOf(eve)).toHaveLength(0);
      const search = await request(app).get('/search?q=secret').set(auth(eve));
      expect(search.body.results).toHaveLength(0);
      const found = await request(app).get('/search?q=secret').set(auth(bob));
      expect(found.body.results.map((r: any) => r.groupId)).toEqual([groupId]);
      const dmList = await request(app).get('/dms').set(auth(alice));
      expect(dmList.body).toHaveLength(0);

      expect((await request(app).get('/dms/groups/abc').set(auth(alice))).status).toBe(400);
      expect((await request(app).get('/dms/groups/999999').set(auth(alice))).status).toBe(404);
    });
  });

  describe('members', () => {
    it('adds members (history visible), leaves, and keeps the group with 2 left', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      await send(alice, groupId, 'before dave');

      // 추가: 기존 기록이 보이고, 이전 기록은 안 읽음으로 쌓이지 않는다
      const added = await request(app).post(`/dms/groups/${groupId}/members`).set(auth(bob)).send({ userIds: [dave.id, bob.id] });
      expect(added.status).toBe(200);
      expect(added.body.addedUserIds).toEqual([dave.id]);
      expect(added.body.group.members).toHaveLength(4);
      const daveView = await messagesOf(dave, groupId);
      expect(daveView.body.messages.map((m: any) => m.content)).toEqual(['before dave']);
      expect((await prisma.dMGroupMember.findUnique({ where: { groupId_userId: { groupId, userId: dave.id } } }))!.lastReadDmId)
        .not.toBeNull();

      // 이제 {alice,bob,carol,dave} 집합으로 만들면 이 그룹이 재사용되고, {alice,bob,carol}은 새 그룹
      expect((await createGroup(carol, [alice.id, bob.id, dave.id])).body.group.id).toBe(groupId);
      const trio = await createGroup(carol, [alice.id, bob.id]);
      expect(trio.status).toBe(201);
      expect(trio.body.group.id).not.toBe(groupId);

      // 비활성 사용자 추가 거부, 9명 초과 거부
      expect((await request(app).post(`/dms/groups/${groupId}/members`).set(auth(alice)).send({ userIds: [zed.id] })).status).toBe(400);
      expect((await request(app).post(`/dms/groups/${groupId}/members`).set(auth(alice))
        .send({ userIds: [eve.id, ...extras.map((u) => u.id)] })).status).toBe(400);

      // 나가기: 나간 사람은 접근 불가, 자기 메시지도 못 고친다
      const daveMsg = (await send(dave, groupId, 'dave was here')).body.id;
      expect((await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(dave))).status).toBe(200);
      expect((await messagesOf(dave, groupId)).status).toBe(404);
      expect((await request(app).patch(`/dms/messages/${daveMsg}`).set(auth(dave)).send({ content: 'x' })).status).toBe(403);
      expect((await request(app).delete(`/dms/messages/${daveMsg}`).set(auth(dave))).status).toBe(403);
      expect(await listOf(dave)).toHaveLength(0);

      // {alice,bob,carol}는 이미 trio가 쓰므로 원래 그룹의 키는 떼어 둔다(재생성 시 trio가 나온다)
      expect((await createGroup(alice, [bob.id, carol.id])).body.group.id).toBe(trio.body.group.id);

      // 2명 남아도 그룹은 유지
      expect((await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(carol))).status).toBe(200);
      const remaining = await messagesOf(alice, groupId);
      expect(remaining.status).toBe(200);
      expect(remaining.body.group.members.map((m: any) => m.id).sort()).toEqual([alice.id, bob.id].sort());
      expect((await send(bob, groupId, 'still here')).status).toBe(201);
    });

    it('records membership history on create, add, leave and rejoin (two spans for a rejoin)', async () => {
      const spansOf = (groupId: number, userId: number) =>
        prisma.dMGroupMembership.findMany({ where: { groupId, userId }, orderBy: { id: 'asc' } });

      // 생성: 구성원마다 그룹 생성 시각부터 열린 구간
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      const group = await prisma.dMGroup.findUniqueOrThrow({ where: { id: groupId } });
      const created = await prisma.dMGroupMembership.findMany({ where: { groupId } });
      expect(created.map((s) => s.userId).sort()).toEqual([alice.id, bob.id, carol.id].sort());
      expect(created.every((s) => s.leftAt === null && s.joinedAt.getTime() === group.createdAt.getTime())).toBe(true);
      // 같은 집합으로 다시 만들면(재사용) 이력이 늘지 않는다
      await createGroup(bob, [alice.id, carol.id]);
      expect(await prisma.dMGroupMembership.count({ where: { groupId } })).toBe(3);

      // 추가: 가입 시각이 DMGroupMember와 같고, 이미 구성원인 사람은 구간이 늘지 않는다
      await request(app).post(`/dms/groups/${groupId}/members`).set(auth(alice)).send({ userIds: [dave.id, bob.id] }).expect(200);
      const daveMember = await prisma.dMGroupMember.findUniqueOrThrow({ where: { groupId_userId: { groupId, userId: dave.id } } });
      const [daveFirst] = await spansOf(groupId, dave.id);
      expect(daveFirst).toMatchObject({ leftAt: null, joinedAt: daveMember.joinedAt });
      expect(await spansOf(groupId, bob.id)).toHaveLength(1);

      // 나가기: 구간이 닫힌다. 나간 사람이 다시 나가기를 불러도(404) 구간은 그대로
      await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(dave)).expect(200);
      await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(dave)).expect(404);
      const [closed] = await spansOf(groupId, dave.id);
      expect(closed.leftAt).not.toBeNull();
      expect(closed.leftAt!.getTime()).toBeGreaterThanOrEqual(closed.joinedAt.getTime());

      // 재가입: 새 구간이 열리고 이전 구간은 닫힌 채 남는다
      await request(app).post(`/dms/groups/${groupId}/members`).set(auth(bob)).send({ userIds: [dave.id] }).expect(200);
      const spans = await spansOf(groupId, dave.id);
      expect(spans).toHaveLength(2);
      expect(spans[0]).toMatchObject({ id: closed.id, leftAt: closed.leftAt });
      expect(spans[1].leftAt).toBeNull();
      expect(spans[1].joinedAt.getTime()).toBeGreaterThanOrEqual(closed.leftAt!.getTime());

      // 현재 구성원과 열린 구간은 언제나 1:1
      const members = await prisma.dMGroupMember.findMany({ where: { groupId }, select: { userId: true } });
      const open = await prisma.dMGroupMembership.findMany({ where: { groupId, leftAt: null }, select: { userId: true } });
      expect(open.map((o) => o.userId).sort()).toEqual(members.map((m) => m.userId).sort());
    });

    it('renames a group and clears the name', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      let res = await request(app).patch(`/dms/groups/${groupId}`).set(auth(bob)).send({ name: '  project  ' });
      expect(res.status).toBe(200);
      expect(res.body.group.name).toBe('project');
      res = await request(app).patch(`/dms/groups/${groupId}`).set(auth(bob)).send({ name: null });
      expect(res.body.group.name).toBeNull();
      expect((await request(app).patch(`/dms/groups/${groupId}`).set(auth(bob)).send({ name: 'x'.repeat(101) })).status).toBe(400);
    });
  });

  describe('read state, stars, mentions', () => {
    it('counts unread per member and clears it on read', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      await send(alice, groupId, 'one');
      await send(alice, groupId, 'two');
      await send(bob, groupId, 'three');

      const unreadOf = async (u: TestUser) => (await listOf(u)).find((c) => c.group.id === groupId).unreadCount;
      expect(await unreadOf(carol)).toBe(3);
      expect(await unreadOf(bob)).toBe(0); // 보낸 사람은 자기 메시지까지 읽은 것으로
      expect(await unreadOf(alice)).toBe(1);

      // 일부까지 읽음
      const msgs = await prisma.directMessage.findMany({ where: { groupId }, orderBy: { id: 'asc' } });
      expect((await request(app).post(`/dms/groups/${groupId}/read`).set(auth(carol)).send({ messageId: msgs[0].id })).status).toBe(200);
      expect(await unreadOf(carol)).toBe(2);
      // 커서는 뒤로 가지 않는다
      await request(app).post(`/dms/groups/${groupId}/read`).set(auth(carol)).send({ messageId: msgs[1].id });
      await request(app).post(`/dms/groups/${groupId}/read`).set(auth(carol)).send({ messageId: msgs[0].id });
      expect(await unreadOf(carol)).toBe(1);
      // 전부 읽음
      await request(app).post(`/dms/groups/${groupId}/read`).set(auth(carol)).send({});
      expect(await unreadOf(carol)).toBe(0);
      // 다른 대화의 메시지 id는 거부
      const other = (await createGroup(alice, [bob.id, dave.id])).body.group.id;
      const otherMsg = (await send(alice, other, 'x')).body.id;
      expect((await request(app).post(`/dms/groups/${groupId}/read`).set(auth(carol)).send({ messageId: otherMsg })).status).toBe(404);

      // 목록을 열면(첫 페이지) 읽음 처리
      await send(alice, groupId, 'four');
      expect(await unreadOf(carol)).toBe(1);
      await messagesOf(carol, groupId);
      expect(await unreadOf(carol)).toBe(0);
    });

    it('stars a group per user and emits star:updated', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      const s = await connect(alice);
      const stars = collect(s, 'star:updated');
      expect((await request(app).put(`/dms/groups/${groupId}/star`).set(auth(alice))).body.isStarred).toBe(true);
      expect((await listOf(alice))[0].isStarred).toBe(true);
      expect((await listOf(bob))[0].isStarred).toBe(false);
      await waitFor(() => stars, (e) => e.length === 1);
      expect(stars[0]).toEqual({ type: 'group', id: groupId, isStarred: true });
      expect((await request(app).delete(`/dms/groups/${groupId}/star`).set(auth(alice))).body.isStarred).toBe(false);
      expect((await listOf(alice))[0].isStarred).toBe(false);
    });

    it('creates mention and thread activities only for group members', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      const parent = (await send(alice, groupId, `hi ${mention(bob)} and ${mention(eve)}`)).body;
      await settle();

      let acts = await prisma.activity.findMany({ where: { dmId: parent.id } });
      expect(acts.map((a) => [a.userId, a.type, a.dmGroupId])).toEqual([[bob.id, 'MENTION', groupId]]);

      // 그룹별 멘션 수와 읽음
      expect((await listOf(bob))[0].mentionCount).toBe(1);
      const counts = await request(app).get('/activity/mention-counts').set(auth(bob));
      expect(counts.body.groups).toEqual({ [groupId]: 1 });
      expect(counts.body.dms).toEqual({});
      await request(app).post(`/dms/groups/${groupId}/read`).set(auth(bob)).send({});
      await settle();
      expect((await listOf(bob))[0].mentionCount).toBe(0);

      // 편집으로 멘션을 carol로 옮기면 bob 활동은 지워지고 carol에게 생긴다
      await request(app).patch(`/dms/messages/${parent.id}`).set(auth(alice)).send({ content: `hi ${mention(carol)}` });
      await settle();
      acts = await prisma.activity.findMany({ where: { dmId: parent.id } });
      expect(acts.map((a) => [a.userId, a.type])).toEqual([[carol.id, 'MENTION']]);

      // 스레드 답글: 부모 작성자(alice)에게 THREAD_REPLY
      const reply = (await request(app).post(`/dms/messages/${parent.id}/reply`).set(auth(bob)).send({ content: 'reply' })).body;
      await settle();
      acts = await prisma.activity.findMany({ where: { dmId: reply.id } });
      expect(acts.map((a) => [a.userId, a.type])).toEqual([[alice.id, 'THREAD_REPLY']]);

      // 리액션 활동, 나간 뒤에는 그룹 활동이 보이지 않는다
      await request(app).post(`/dms/messages/${parent.id}/reactions`).set(auth(bob)).send({ emoji: 'tada' });
      await settle();
      expect(await prisma.activity.count({ where: { userId: alice.id, type: 'REACTION', dmGroupId: groupId } })).toBe(1);
      let feed = await request(app).get('/activity').set(auth(alice));
      expect(feed.body.items.length).toBeGreaterThan(0);
      await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(alice));
      feed = await request(app).get('/activity').set(auth(alice));
      expect(feed.body.items).toHaveLength(0);

      // 삭제하면 활동 정리
      await request(app).delete(`/dms/messages/${parent.id}`).set(auth(alice));
      await settle();
    });
  });

  describe('WebSocket', () => {
    it('delivers dm:new to all members and not to outsiders; supports dmgroup:send and typing', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      const [sa, sb, sc, se] = await Promise.all([connect(alice), connect(bob), connect(carol), connect(eve)]);
      const bobNew = collect(sb, 'dm:new');
      const carolNew = collect(sc, 'dm:new');
      const eveNew = collect(se, 'dm:new');
      const aliceNew = collect(sa, 'dm:new');

      await send(alice, groupId, 'via http');
      await waitFor(() => carolNew, (e) => e.length === 1);
      await waitFor(() => bobNew, (e) => e.length === 1);
      await waitFor(() => aliceNew, (e) => e.length === 1);
      expect(carolNew[0].groupId).toBe(groupId);

      sb.emit('dmgroup:send', { groupId, content: 'via socket' });
      await waitFor(() => carolNew, (e) => e.length === 2);
      expect(carolNew[1].content).toBe('via socket');
      expect(carolNew[1].fromUserId).toBe(bob.id);

      // 비멤버는 소켓으로도 보낼 수 없다
      const errors = collect(se, 'error');
      se.emit('dmgroup:send', { groupId, content: 'intrude' });
      await waitFor(() => errors, (e) => e.length === 1);
      expect(await prisma.directMessage.count({ where: { groupId, fromUserId: eve.id } })).toBe(0);

      // 편집·삭제·리액션 이벤트에 groupId가 실린다
      const updated = collect(sc, 'dm:updated');
      const deleted = collect(sc, 'dm:deleted');
      const reacted = collect(sc, 'dm:reaction:added');
      const msgId = bobNew[0].id;
      await request(app).patch(`/dms/messages/${msgId}`).set(auth(alice)).send({ content: 'edited' });
      await request(app).post(`/dms/messages/${msgId}/reactions`).set(auth(bob)).send({ emoji: 'smile' });
      await request(app).delete(`/dms/messages/${msgId}`).set(auth(alice));
      await waitFor(() => deleted, (e) => e.length === 1);
      await waitFor(() => updated, (e) => e.length === 1);
      await waitFor(() => reacted, (e) => e.length === 1);
      expect(updated[0].content).toBe('edited');
      expect(deleted[0]).toMatchObject({ dmId: msgId, groupId });
      expect(reacted[0]).toMatchObject({ dmId: msgId, groupId });

      // 타이핑: 나를 뺀 멤버만 받는다
      const carolTyping = collect(sc, 'dmgroup:typing:start');
      const aliceTyping = collect(sa, 'dmgroup:typing:start');
      const eveTyping = collect(se, 'dmgroup:typing:start');
      sb.emit('dmgroup:typing:start', groupId);
      se.emit('dmgroup:typing:start', groupId); // 비멤버는 무시
      await waitFor(() => carolTyping, (e) => e.length === 1);
      expect(carolTyping[0]).toEqual({ groupId, userId: bob.id });
      await waitFor(() => aliceTyping, (e) => e.length === 1);

      await new Promise((r) => setTimeout(r, 200));
      expect(eveNew).toHaveLength(0);
      expect(eveTyping).toHaveLength(0);
      expect(carolTyping).toHaveLength(1);
    });

    it('emits member added/removed events', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      const [sa, sd] = await Promise.all([connect(alice), connect(dave)]);
      const aliceAdded = collect(sa, 'dmgroup:member:added');
      const daveAdded = collect(sd, 'dmgroup:member:added');
      const aliceRemoved = collect(sa, 'dmgroup:member:removed');
      const daveRemoved = collect(sd, 'dmgroup:member:removed');

      await request(app).post(`/dms/groups/${groupId}/members`).set(auth(bob)).send({ userIds: [dave.id] });
      await waitFor(() => daveAdded, (e) => e.length === 1);
      await waitFor(() => aliceAdded, (e) => e.length === 1);
      expect(daveAdded[0]).toMatchObject({ groupId, userIds: [dave.id], actorId: bob.id });
      expect(daveAdded[0].group.members).toHaveLength(4);

      await request(app).delete(`/dms/groups/${groupId}/members/me`).set(auth(dave));
      await waitFor(() => daveRemoved, (e) => e.length === 1);
      await waitFor(() => aliceRemoved, (e) => e.length === 1);
      expect(aliceRemoved[0]).toEqual({ groupId, userId: dave.id });

      // 나간 뒤에는 새 메시지를 받지 않는다
      const daveNew = collect(sd, 'dm:new');
      const aliceNew = collect(sa, 'dm:new');
      await send(alice, groupId, 'after dave left');
      await waitFor(() => aliceNew, (e) => e.length === 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(daveNew).toHaveLength(0);
    });
  });

  describe('review fixes', () => {
    // 게스트 G는 alice·bob과만 채널을 공유한다. carol은 G와 공유 채널이 없다.
    async function setupGuest(): Promise<{ guest: TestUser; channelId: number }> {
      const guest = await register(`Guest${Date.now()}`);
      await prisma.user.update({ where: { id: guest.id }, data: { role: 'GUEST' } });
      clearTokenCache();
      const ch = await prisma.channel.create({ data: { name: `guest-ch-${guest.id}`, isPrivate: true } });
      await prisma.channelMember.createMany({
        data: [alice, bob, guest].map((u) => ({ userId: u.id, channelId: ch.id })),
      });
      return { guest, channelId: ch.id };
    }

    it('rejects a group where a guest does not share a channel with every other member', async () => {
      const { guest } = await setupGuest();

      // 멤버(alice)가 만들어도 게스트와 공유 채널이 없는 carol이 끼면 거부
      expect((await createGroup(alice, [guest.id, carol.id])).status).toBe(400);
      // 게스트가 행위자여도 마찬가지
      expect((await createGroup(guest, [alice.id, carol.id])).status).toBe(400);
      // 모두 공유 채널이 있으면 허용
      const ok = await createGroup(alice, [guest.id, bob.id]);
      expect(ok.status).toBe(201);
      const groupId = ok.body.group.id;

      // 추가로도 우회할 수 없다
      const add = await request(app).post(`/dms/groups/${groupId}/members`).set(auth(alice)).send({ userIds: [carol.id] });
      expect(add.status).toBe(400);
      expect(await prisma.dMGroupMember.count({ where: { groupId } })).toBe(3);

      // 게스트를 사람이 없는 그룹에 추가하는 것도 같은 기준
      const plain = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      expect((await request(app).post(`/dms/groups/${plain}/members`).set(auth(alice)).send({ userIds: [guest.id] })).status).toBe(400);
    });

    it('lets a guest search its own group DMs even without shared-channel members', async () => {
      const { guest, channelId } = await setupGuest();
      const groupId = (await createGroup(alice, [guest.id, bob.id])).body.group.id;
      await send(alice, groupId, 'findable-guest-text');
      // 그 뒤 채널에서 빠져 공유 채널 멤버가 없어졌다
      await prisma.channelMember.deleteMany({ where: { channelId } });
      const res = await request(app).get('/search?q=findable-guest-text').set(auth(guest));
      expect(res.status).toBe(200);
      expect(res.body.results.map((r: any) => r.groupId)).toEqual([groupId]);
    });

    it('serializes concurrent member additions so the group never exceeds 9', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id, dave.id])).body.group.id; // 4명
      const [a, b] = await Promise.all([
        request(app).post(`/dms/groups/${groupId}/members`).set(auth(alice)).send({ userIds: extras.slice(0, 3).map((u) => u.id) }),
        request(app).post(`/dms/groups/${groupId}/members`).set(auth(bob)).send({ userIds: extras.slice(3, 6).map((u) => u.id) }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 400]);
      expect(await prisma.dMGroupMember.count({ where: { groupId } })).toBe(7);

      // 같은 사람을 동시에 추가해도 오류 없이 한 번만 들어간다
      const [c, d] = await Promise.all([
        request(app).post(`/dms/groups/${groupId}/members`).set(auth(alice)).send({ userIds: [eve.id] }),
        request(app).post(`/dms/groups/${groupId}/members`).set(auth(bob)).send({ userIds: [eve.id] }),
      ]);
      expect([c.status, d.status]).toEqual([200, 200]);
      expect([...c.body.addedUserIds, ...d.body.addedUserIds]).toEqual([eve.id]);
      expect(await prisma.dMGroupMember.count({ where: { groupId } })).toBe(8);
    });

    it('reuses the group after leave, and restores the original key once a clash is gone', async () => {
      // 나가기 후 같은 멤버로 다시 만들면 그 그룹이 나온다
      const g1 = (await createGroup(alice, [bob.id, carol.id, dave.id])).body.group.id;
      expect((await request(app).delete(`/dms/groups/${g1}/members/me`).set(auth(dave))).status).toBe(200);
      expect((await createGroup(carol, [alice.id, bob.id])).body.group.id).toBe(g1);

      // g2 = {alice,bob,carol,eve}. eve가 나가면 g1과 키가 겹치므로 접미사 키가 되고, 500이 나지 않는다
      const g2 = (await createGroup(alice, [bob.id, carol.id, eve.id])).body.group.id;
      expect((await request(app).delete(`/dms/groups/${g2}/members/me`).set(auth(eve))).status).toBe(200);
      expect((await prisma.dMGroup.findUnique({ where: { id: g2 } }))!.memberKey).toMatch(/#/);
      expect((await createGroup(alice, [bob.id, carol.id])).body.group.id).toBe(g1);

      // g1에서 carol이 나가 충돌이 풀린 뒤 g2의 멤버가 바뀌면 g2는 원래 키로 돌아간다
      expect((await request(app).delete(`/dms/groups/${g1}/members/me`).set(auth(carol))).status).toBe(200);
      expect((await request(app).post(`/dms/groups/${g2}/members`).set(auth(alice)).send({ userIds: [dave.id] })).status).toBe(200);
      expect((await request(app).delete(`/dms/groups/${g2}/members/me`).set(auth(dave))).status).toBe(200);
      expect((await prisma.dMGroup.findUnique({ where: { id: g2 } }))!.memberKey).not.toMatch(/#/);
      expect((await createGroup(alice, [bob.id, carol.id])).body.group.id).toBe(g2);
    });

    it('moves the read cursor only to top-level messages', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      const parent = (await send(alice, groupId, 'p')).body;
      const reply = (await request(app).post(`/dms/messages/${parent.id}/reply`).set(auth(bob)).send({ content: 'r' })).body;
      expect((await request(app).post(`/dms/groups/${groupId}/read`).set(auth(carol)).send({ messageId: reply.id })).status).toBe(404);
      const ok = await request(app).post(`/dms/groups/${groupId}/read`).set(auth(carol)).send({ messageId: parent.id });
      expect(ok.status).toBe(200);
      expect(ok.body.lastReadDmId).toBe(parent.id);
    });

    it('returns group info only on the first page', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      for (let i = 0; i < 3; i++) await send(alice, groupId, `m${i}`);
      const first = await request(app).get(`/dms/groups/${groupId}/messages?limit=2`).set(auth(bob));
      expect(first.body.group.id).toBe(groupId);
      const next = await request(app).get(`/dms/groups/${groupId}/messages?limit=2&cursor=${first.body.nextCursor}`).set(auth(bob));
      expect(next.body.group).toBeUndefined();
      expect(next.body.messages).toHaveLength(1);
    });

    it('answers 400 for invalid or already attached fileIds over HTTP and the socket', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      const upload = await request(app).post('/files').set(auth(alice)).attach('file', Buffer.from('x'), 'a.txt');
      const fileId = upload.body.id;
      expect((await send(alice, groupId, 'ok', { fileIds: [fileId] })).status).toBe(201);

      const again = await send(alice, groupId, 'again', { fileIds: [fileId] });
      expect(again.status).toBe(400);
      expect(again.body.code).toBe('INVALID_FILE_IDS');
      expect((await send(alice, groupId, 'missing', { fileIds: [999999] })).status).toBe(400);
      const parent = (await send(alice, groupId, 'parent')).body;
      const badReply = await request(app).post(`/dms/messages/${parent.id}/reply`).set(auth(alice)).send({ content: 'r', fileIds: [fileId] });
      expect(badReply.status).toBe(400);

      // 실패한 전송은 메시지를 남기지 않는다(트랜잭션 롤백)
      expect(await prisma.directMessage.count({ where: { groupId, content: { in: ['again', 'missing'] } } })).toBe(0);

      const s = await connect(alice);
      const ack = await new Promise<any>((resolve) => s.emit('dmgroup:send', { groupId, content: 'sock', fileIds: [fileId] }, resolve));
      expect(ack).toMatchObject({ code: 'INVALID_FILE_IDS' });
      const okAck = await new Promise<any>((resolve) => s.emit('dmgroup:send', { groupId, content: 'sock ok' }, resolve));
      expect(okAck.id).toEqual(expect.any(Number));
    });
  });

  describe('1:1 DMs are unaffected', () => {
    it('keeps 1:1 conversations separate from group messages', async () => {
      const groupId = (await createGroup(alice, [bob.id, carol.id])).body.group.id;
      await send(bob, groupId, 'group msg');
      const one = await request(app).post('/dms').set(auth(bob)).send({ toUserId: alice.id, content: 'direct' });
      expect(one.status).toBe(201);
      expect(one.body.groupId).toBeNull();

      const list = await request(app).get('/dms').set(auth(alice));
      expect(list.body).toHaveLength(1);
      expect(list.body[0].otherUser.id).toBe(bob.id);
      expect(list.body[0].lastMessage.content).toBe('direct');
      expect(list.body[0].unreadCount).toBe(1);

      const conv = await request(app).get(`/dms/${bob.id}`).set(auth(alice));
      expect(conv.body.messages.map((m: any) => m.content)).toEqual(['direct']);

      // DB 제약: toUserId와 groupId는 정확히 하나만
      await expect(prisma.directMessage.create({
        data: { content: 'bad', fromUserId: alice.id, toUserId: bob.id, groupId },
      })).rejects.toThrow();
      await expect(prisma.directMessage.create({
        data: { content: 'bad', fromUserId: alice.id },
      })).rejects.toThrow();
    });
  });
});
