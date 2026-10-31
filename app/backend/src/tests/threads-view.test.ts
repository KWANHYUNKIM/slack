import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { listenOnLoopback } from './listenLoopback.js';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { settleBackgroundWork as settle } from '../services/mentionService.js';
import { onThreadReplyCreated } from '../services/threadService.js';

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-thv@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

describe('Threads view: list, read state, also send to channel', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  let alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser;
  let pubId: number;
  let privId: number;
  const sockets: ClientSocket[] = [];

  const post = (u: TestUser, channelId: number, content: string, extra: object = {}) =>
    request(app).post(`/channels/${channelId}/messages`).set(auth(u)).send({ content, ...extra });
  const reply = (u: TestUser, parentId: number, content: string, extra: object = {}) =>
    request(app).post(`/messages/${parentId}/reply`).set(auth(u)).send({ content, ...extra });
  const list = async (u: TestUser, query = '') => {
    await settle();
    return request(app).get(`/threads${query}`).set(auth(u));
  };
  const parentIds = (res: request.Response) => res.body.items.map((i: { parent: { id: number } }) => i.parent.id);
  const unreadCount = async (u: TestUser) => {
    await settle();
    return (await request(app).get('/threads/unread-count').set(auth(u))).body.count;
  };
  const timeline = async (u: TestUser, channelId: number) =>
    (await request(app).get(`/channels/${channelId}/messages`).set(auth(u))).body.messages as Array<{ id: number; content: string; threadId: number | null; alsoSendToChannel: boolean; parent: { id: number; content: string } | null }>;

  function connect(u: TestUser): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = Client(`http://127.0.0.1:${port}`, { auth: { token: u.token }, forceNew: true });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  // 이벤트를 모아 두었다가 확인한다(안 온다는 것도 확인해야 해서 고정 대기를 쓴다)
  const collect = (s: ClientSocket, event: string) => {
    const got: any[] = [];
    s.on(event, (p) => got.push(p));
    return got;
  };
  const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    [alice, bob, carol, dave] = [await register('Alice'), await register('Bob'), await register('Carol'), await register('Dave')];
    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'thv-pub' })).body.id;
    for (const u of [bob, carol]) await request(app).post(`/channels/${pubId}/join`).set(auth(u));
    privId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'thv-priv', isPrivate: true })).body.id;
    await request(app).post(`/channels/${privId}/members`).set(auth(alice)).send({ userId: bob.id });

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    port = await listenOnLoopback(httpServer);
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    io.close();
    httpServer.close();
  });

  afterEach(async () => {
    await settle();
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/threads')).status).toBe(401);
    expect((await request(app).get('/threads/unread-count')).status).toBe(401);
    expect((await request(app).post('/threads/1/read').send({})).status).toBe(401);
    expect((await request(app).post('/messages/1/broadcast')).status).toBe(401);
  });

  describe('participation', () => {
    it('lists only threads the user wrote the parent of or replied in', async () => {
      const parent = (await post(alice, pubId, 'alice parent')).body;
      const other = (await post(carol, pubId, 'carol parent, nobody of ours replies')).body;
      expect((await reply(bob, parent.id, 'bob reply')).status).toBe(201);
      expect((await reply(carol, other.id, 'carol own reply')).status).toBe(201);

      // 부모 작성자
      expect(parentIds(await list(alice))).toContain(parent.id);
      // 답글 작성자
      expect(parentIds(await list(bob))).toContain(parent.id);
      expect(parentIds(await list(bob))).not.toContain(other.id);
      // 비참여 멤버
      expect(parentIds(await list(carol))).not.toContain(parent.id);
      expect(parentIds(await list(carol))).toContain(other.id);
      // 다른 채널에 아무 것도 안 한 사람
      expect((await list(dave)).body.items).toEqual([]);
    });

    it('returns parent, channel, counts, last reply and inline replies', async () => {
      const parent = (await post(alice, pubId, 'shape parent')).body;
      await reply(bob, parent.id, 'first');
      const last = (await reply(bob, parent.id, 'second')).body;
      const item = (await list(alice)).body.items.find((i: any) => i.parent.id === parent.id);
      expect(item.channel).toMatchObject({ id: pubId, name: 'thv-pub' });
      expect(item.replyCount).toBe(2);
      expect(item.unreadCount).toBe(2);
      expect(item.lastReply.id).toBe(last.id);
      expect(item.replies.map((r: any) => r.content)).toEqual(['first', 'second']);
      expect(item.replies[0].user.name).toBe('Bob');
      expect(new Date(item.lastActivityAt).getTime()).toBe(new Date(last.createdAt).getTime());
    });

    it('sorts by the most recent reply', async () => {
      const a = (await post(alice, pubId, 'sort A')).body;
      const b = (await post(alice, pubId, 'sort B')).body;
      await reply(bob, a.id, 'a1');
      await reply(bob, b.id, 'b1');
      let ids = parentIds(await list(alice));
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
      await reply(bob, a.id, 'a2');
      ids = parentIds(await list(alice));
      expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    });
  });

  describe('access rules', () => {
    it('hides private-channel threads from users who are not members, and after leaving', async () => {
      const parent = (await post(alice, privId, 'private parent')).body;
      await reply(bob, parent.id, 'private reply');
      expect(parentIds(await list(bob))).toContain(parent.id);

      expect((await request(app).post(`/channels/${privId}/leave`).set(auth(bob))).status).toBe(200);
      expect(parentIds(await list(bob))).not.toContain(parent.id);
      expect(await unreadCount(bob)).toBe(0);
      // 다시 들어가면 되돌아온다
      await request(app).post(`/channels/${privId}/members`).set(auth(alice)).send({ userId: bob.id });
      expect(parentIds(await list(bob))).toContain(parent.id);
    });

    it('keeps a deleted parent as a placeholder while live replies remain, then drops the card', async () => {
      const gone = (await post(alice, pubId, 'parent to delete')).body;
      const r1 = (await reply(bob, gone.id, 'reply under deleted parent')).body;
      const r2 = (await reply(carol, gone.id, 'second reply')).body;
      expect((await request(app).delete(`/messages/${gone.id}`).set(auth(alice))).status).toBe(200);

      // 목록: 카드는 남고 부모는 비워진 채 deletedAt이 표시된다
      const item = (await list(bob)).body.items.find((i: any) => i.parent.id === gone.id);
      expect(item.parent.deletedAt).toBeTruthy();
      expect(item.parent.content).toBe('');
      expect(item.replies.map((r: any) => r.id)).toEqual([r1.id, r2.id]);
      expect(parentIds(await list(alice))).toContain(gone.id);

      // 채널 타임라인에도 자리표시자로 남고, 스레드 패널 조회와 읽음 처리가 된다
      const placeholder = (await timeline(alice, pubId)).find((m) => m.id === gone.id) as any;
      expect(placeholder.deletedAt).toBeTruthy();
      expect(placeholder.content).toBe('');
      expect(placeholder._count.replies).toBe(2);
      const thread = await request(app).get(`/messages/${gone.id}/thread`).set(auth(bob));
      expect(thread.status).toBe(200);
      expect(thread.body.parent.content).toBe('');
      expect(thread.body.replies).toHaveLength(2);
      expect((await request(app).post(`/threads/${gone.id}/read`).set(auth(bob)).send({})).status).toBe(200);
      // 삭제된 부모에는 새 답글을 달 수 없다
      expect((await reply(bob, gone.id, 'late')).status).toBe(404);

      // 답글이 모두 지워지면 카드와 자리표시자가 함께 사라진다
      await request(app).delete(`/messages/${r1.id}`).set(auth(bob));
      expect(parentIds(await list(alice))).toContain(gone.id);
      expect(parentIds(await list(bob))).not.toContain(gone.id); // bob의 답글은 모두 지워져 더는 참여자가 아니다
      await request(app).delete(`/messages/${r2.id}`).set(auth(carol));
      expect(parentIds(await list(alice))).not.toContain(gone.id);
      expect((await timeline(alice, pubId)).some((m) => m.id === gone.id)).toBe(false);
    });

    it('hides a thread when its last reply is deleted, and when the channel is archived', async () => {
      const lonely = (await post(alice, pubId, 'lonely parent')).body;
      const only = (await reply(bob, lonely.id, 'only reply')).body;
      expect(parentIds(await list(alice))).toContain(lonely.id);
      await request(app).delete(`/messages/${only.id}`).set(auth(bob));
      expect(parentIds(await list(alice))).not.toContain(lonely.id);

      const arch = (await request(app).post('/channels').set(auth(alice)).send({ name: 'thv-arch' })).body.id;
      await request(app).post(`/channels/${arch}/join`).set(auth(bob));
      const ap = (await post(alice, arch, 'archived parent')).body;
      await reply(bob, ap.id, 'archived reply');
      expect(parentIds(await list(bob))).toContain(ap.id);
      await prisma.channel.update({ where: { id: arch }, data: { archivedAt: new Date() } });
      expect(parentIds(await list(bob))).not.toContain(ap.id);
    });

    it('rejects read for non-members and missing messages', async () => {
      const parent = (await post(alice, privId, 'private read parent')).body;
      await reply(alice, parent.id, 'x');
      expect((await request(app).post(`/threads/${parent.id}/read`).set(auth(carol)).send({})).status).toBe(403);
      expect((await request(app).post('/threads/99999999/read').set(auth(carol)).send({})).status).toBe(404);
      expect((await request(app).post('/threads/abc/read').set(auth(carol)).send({})).status).toBe(400);
    });

    it('rejects read on a reply and a foreign lastReadReplyId', async () => {
      const p1 = (await post(alice, pubId, 'rp1')).body;
      const p2 = (await post(alice, pubId, 'rp2')).body;
      const r1 = (await reply(bob, p1.id, 'r1')).body;
      const r2 = (await reply(bob, p2.id, 'r2')).body;
      expect((await request(app).post(`/threads/${r1.id}/read`).set(auth(alice)).send({})).status).toBe(400);
      expect((await request(app).post(`/threads/${p1.id}/read`).set(auth(alice)).send({ lastReadReplyId: r2.id })).status).toBe(400);
      expect((await request(app).post(`/threads/${p1.id}/read`).set(auth(alice)).send({ lastReadReplyId: 'x' })).status).toBe(400);
    });
  });

  describe('read state', () => {
    it('counts unread replies from others, resets on read, and own replies are read', async () => {
      const base = await unreadCount(alice);
      const parent = (await post(alice, pubId, 'unread parent')).body;
      await reply(alice, parent.id, 'my own reply');
      expect(await unreadCount(alice)).toBe(base);

      await reply(bob, parent.id, 'b1');
      await reply(bob, parent.id, 'b2');
      const item = (await list(alice)).body.items.find((i: any) => i.parent.id === parent.id);
      expect(item.unreadCount).toBe(2);
      expect(await unreadCount(alice)).toBe(base + 1);

      const res = await request(app).post(`/threads/${parent.id}/read`).set(auth(alice)).send({});
      expect(res.status).toBe(200);
      const after = (await list(alice)).body.items.find((i: any) => i.parent.id === parent.id);
      expect(after.unreadCount).toBe(0);
      expect(await unreadCount(alice)).toBe(base);

      // 새 답글이 오면 다시 안 읽음
      await reply(carol, parent.id, 'c1');
      expect(await unreadCount(alice)).toBe(base + 1);
    });

    it('supports partial reads and never moves the read position backwards', async () => {
      const parent = (await post(alice, pubId, 'partial parent')).body;
      const r1 = (await reply(bob, parent.id, 'p1')).body;
      const r2 = (await reply(bob, parent.id, 'p2')).body;
      await reply(bob, parent.id, 'p3');
      await request(app).post(`/threads/${parent.id}/read`).set(auth(alice)).send({ lastReadReplyId: r2.id });
      const unreadOf = async () => (await list(alice)).body.items.find((i: any) => i.parent.id === parent.id).unreadCount;
      expect(await unreadOf()).toBe(1);
      const back = await request(app).post(`/threads/${parent.id}/read`).set(auth(alice)).send({ lastReadReplyId: r1.id });
      expect(back.body.lastReadReplyId).toBe(r2.id);
      expect(await unreadOf()).toBe(1);
    });

    it('deleting an unread reply lowers the unread count; editing keeps it', async () => {
      const parent = (await post(alice, pubId, 'edit-del parent')).body;
      const r1 = (await reply(bob, parent.id, 'e1')).body;
      await reply(bob, parent.id, 'e2');
      const get = async () => (await list(alice)).body.items.find((i: any) => i.parent.id === parent.id);
      expect((await get()).unreadCount).toBe(2);

      const edited = await request(app).patch(`/messages/${r1.id}`).set(auth(bob)).send({ content: 'e1 edited' });
      expect(edited.status).toBe(200);
      let item = await get();
      expect(item.unreadCount).toBe(2);
      expect(item.replies[0].content).toBe('e1 edited');
      expect(item.replies[0].editedAt).toBeTruthy();

      expect((await request(app).delete(`/messages/${r1.id}`).set(auth(bob))).status).toBe(200);
      item = await get();
      expect(item.unreadCount).toBe(1);
      expect(item.replyCount).toBe(1);
      expect(item.replies.map((r: any) => r.content)).toEqual(['e2']);
    });
  });

  describe('also send to channel', () => {
    it('shows broadcast replies in the channel timeline with a parent excerpt, hides normal replies', async () => {
      const parent = (await post(alice, pubId, 'broadcast parent '.padEnd(150, 'x'))).body;
      const normal = (await reply(bob, parent.id, 'normal reply')).body;
      const cast = (await reply(bob, parent.id, 'cast reply', { alsoSendToChannel: true })).body;
      expect(cast.alsoSendToChannel).toBe(true);
      expect(cast.parent).toMatchObject({ id: parent.id });
      expect(cast.parent.content.length).toBeLessThanOrEqual(100);

      const tl = await timeline(alice, pubId);
      expect(tl.find((m) => m.id === normal.id)).toBeUndefined();
      const inTl = tl.find((m) => m.id === cast.id)!;
      expect(inTl.threadId).toBe(parent.id);
      expect(inTl.parent!.id).toBe(parent.id);
      // 스레드 안에도 둘 다 있다
      const thread = (await request(app).get(`/messages/${parent.id}/thread`).set(auth(alice))).body;
      expect(thread.replies.map((r: any) => r.id)).toEqual([normal.id, cast.id]);
    });

    it('toggles after the fact (author only, replies only) and removes the copy on delete', async () => {
      const parent = (await post(alice, pubId, 'toggle parent')).body;
      const r = (await reply(bob, parent.id, 'toggle reply')).body;
      expect((await timeline(alice, pubId)).some((m) => m.id === r.id)).toBe(false);

      expect((await request(app).post(`/messages/${r.id}/broadcast`).set(auth(alice))).status).toBe(403);
      expect((await request(app).post(`/messages/${parent.id}/broadcast`).set(auth(alice))).status).toBe(400);
      expect((await request(app).post(`/messages/${r.id}/broadcast`).set(auth(carol))).status).toBe(403);

      const on = await request(app).post(`/messages/${r.id}/broadcast`).set(auth(bob));
      expect(on.status).toBe(200);
      expect(on.body.alsoSendToChannel).toBe(true);
      expect((await timeline(alice, pubId)).some((m) => m.id === r.id)).toBe(true);

      const off = await request(app).delete(`/messages/${r.id}/broadcast`).set(auth(bob));
      expect(off.status).toBe(200);
      expect((await timeline(alice, pubId)).some((m) => m.id === r.id)).toBe(false);

      await request(app).post(`/messages/${r.id}/broadcast`).set(auth(bob));
      const edit = await request(app).patch(`/messages/${r.id}`).set(auth(bob)).send({ content: 'toggle reply edited' });
      expect(edit.status).toBe(200);
      expect((await timeline(alice, pubId)).find((m) => m.id === r.id)!.content).toBe('toggle reply edited');

      expect((await request(app).delete(`/messages/${r.id}`).set(auth(bob))).status).toBe(200);
      expect((await timeline(alice, pubId)).some((m) => m.id === r.id)).toBe(false);
      expect((await request(app).post(`/messages/${r.id}/broadcast`).set(auth(bob))).status).toBe(404);
    });

    it('works through POST /channels/:id/messages with threadId and through the socket', async () => {
      const parent = (await post(alice, pubId, 'via other paths')).body;
      const viaHttp = (await post(bob, pubId, 'http cast', { threadId: parent.id, alsoSendToChannel: true })).body;
      expect(viaHttp.alsoSendToChannel).toBe(true);
      // threadId 없이 보내면 플래그는 무시된다
      const top = (await post(bob, pubId, 'top level', { alsoSendToChannel: true })).body;
      expect(top.alsoSendToChannel).toBe(false);

      const s = await connect(bob);
      const ack = await new Promise<any>((resolve) => s.emit('message:send', { channelId: pubId, content: 'ws cast', threadId: parent.id, alsoSendToChannel: true }, resolve));
      expect(ack).toEqual({});
      await settle();
      const tl = await timeline(alice, pubId);
      expect(tl.some((m) => m.content === 'ws cast' && m.threadId === parent.id)).toBe(true);
      expect(parentIds(await list(alice))).toContain(parent.id);
      const item = (await list(alice)).body.items.find((i: any) => i.parent.id === parent.id);
      expect(item.replyCount).toBe(2);
    });
  });

  describe('channel unread rules', () => {
    it('counts broadcast replies, not plain thread replies, in the channel unread count', async () => {
      const ch = (await request(app).post('/channels').set(auth(alice)).send({ name: 'thv-unread' })).body.id;
      await request(app).post(`/channels/${ch}/join`).set(auth(bob));
      const parent = (await post(alice, ch, 'unread rule parent')).body;
      await request(app).post(`/channels/${ch}/read`).set(auth(bob)).send({ messageId: parent.id });
      const unreadOf = async () => {
        const res = await request(app).get('/channels').set(auth(bob));
        const list = Array.isArray(res.body) ? res.body : res.body.channels;
        return list.find((c: any) => c.id === ch).unreadCount;
      };
      expect(await unreadOf()).toBe(0);
      await reply(alice, parent.id, 'plain reply');
      expect(await unreadOf()).toBe(0);
      await reply(alice, parent.id, 'cast reply', { alsoSendToChannel: true });
      expect(await unreadOf()).toBe(1);
      const unreads = await request(app).get('/unreads').set(auth(bob));
      expect(unreads.body.messages.filter((m: any) => m.channelId === ch).map((m: any) => m.content)).toEqual(['cast reply']);
    });
  });

  describe('events', () => {
    it('sends thread:updated only to participants, and thread:read to the reader', async () => {
      const parent = (await post(alice, pubId, 'event parent')).body;
      await reply(bob, parent.id, 'bob joins');
      const [sa, sb, sc] = [await connect(alice), await connect(bob), await connect(carol)];
      const [ea, eb, ec] = [collect(sa, 'thread:updated'), collect(sb, 'thread:updated'), collect(sc, 'thread:updated')];
      const readA = collect(sa, 'thread:read');
      const readB = collect(sb, 'thread:read');

      const r = (await reply(bob, parent.id, 'event reply')).body;
      await settle();
      await pause();
      expect(ea).toHaveLength(1);
      expect(ea[0]).toMatchObject({ parentId: parent.id, channelId: pubId, lastReplyId: r.id, replyCount: 2, actorId: bob.id });
      expect(eb).toHaveLength(1);
      expect(ec).toHaveLength(0);

      await request(app).post(`/threads/${parent.id}/read`).set(auth(alice)).send({});
      await pause();
      expect(readA).toEqual([{ parentId: parent.id }]);
      expect(readB).toHaveLength(0);

      // 삭제도 참여자에게 알린다
      await request(app).delete(`/messages/${r.id}`).set(auth(bob));
      await settle();
      await pause();
      expect(ea).toHaveLength(2);
      expect(ea[1]).toMatchObject({ parentId: parent.id, replyCount: 1 });
      expect(ec).toHaveLength(0);
    });

    it('does not notify a participant who left the channel', async () => {
      const parent = (await post(alice, privId, 'leave event parent')).body;
      await request(app).post(`/channels/${privId}/members`).set(auth(alice)).send({ userId: bob.id });
      await reply(bob, parent.id, 'bob in');
      await request(app).post(`/channels/${privId}/leave`).set(auth(bob));
      const sb = await connect(bob);
      const eb = collect(sb, 'thread:updated');
      await reply(alice, parent.id, 'alice again');
      await settle();
      await pause();
      expect(eb).toHaveLength(0);
      // 남은 정리: 다음 테스트를 위해 bob을 되돌린다
      await request(app).post(`/channels/${privId}/members`).set(auth(alice)).send({ userId: bob.id });
    });
  });

  describe('pagination', () => {
    it('pages with a cursor without gaps or duplicates', async () => {
      const made: number[] = [];
      await request(app).post(`/channels/${pubId}/join`).set(auth(dave));
      for (let i = 0; i < 5; i++) {
        const p = (await post(dave, pubId, `page parent ${i}`)).body;
        await reply(dave, p.id, `page reply ${i}`);
        made.push(p.id);
      }
      const seen: number[] = [];
      let cursor: number | undefined;
      let pages = 0;
      do {
        const res = await list(dave, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.status).toBe(200);
        expect(res.body.items.length).toBeLessThanOrEqual(2);
        seen.push(...parentIds(res));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual([...made].reverse());
    });
  });

  describe('review follow-ups', () => {
    it('rejects replying to a reply through POST /channels/:id/messages and the socket', async () => {
      const parent = (await post(alice, pubId, 'nest parent')).body;
      const r = (await reply(bob, parent.id, 'first level')).body;
      expect((await post(carol, pubId, 'second level', { threadId: r.id })).status).toBe(400);
      expect((await request(app).post(`/messages/${r.id}/reply`).set(auth(carol)).send({ content: 'x' })).status).toBe(400);

      const s = await connect(carol);
      const err = collect(s, 'error');
      const ack = await new Promise<any>((resolve) => s.emit('message:send', { channelId: pubId, content: 'ws nested', threadId: r.id }, resolve));
      await pause();
      expect(err.length + (ack?.error ? 1 : 0)).toBeGreaterThan(0);
      expect(await prisma.message.count({ where: { content: 'ws nested' } })).toBe(0);
      expect(await prisma.message.count({ where: { content: 'second level' } })).toBe(0);
    });

    it('keeps the parent excerpt when a broadcast reply is edited, over HTTP and the socket, and emits message:updated', async () => {
      const parent = (await post(alice, pubId, 'excerpt parent')).body;
      const cast = (await reply(bob, parent.id, 'cast v1', { alsoSendToChannel: true })).body;
      const sa = await connect(alice);
      const updated = collect(sa, 'message:updated');
      await request(app).post(`/channels/${pubId}/join`).set(auth(alice));
      sa.emit('join:channel', pubId);
      await pause();

      const http = await request(app).patch(`/messages/${cast.id}`).set(auth(bob)).send({ content: 'cast v2' });
      expect(http.status).toBe(200);
      expect(http.body.parent).toMatchObject({ id: parent.id, content: 'excerpt parent' });
      await pause();
      expect(updated.find((m) => m.id === cast.id && m.content === 'cast v2')?.parent).toMatchObject({ id: parent.id });

      const sb = await connect(bob);
      sb.emit('message:edit', { messageId: cast.id, content: 'cast v3' });
      await pause(400);
      expect(updated.find((m) => m.id === cast.id && m.content === 'cast v3')?.parent).toMatchObject({ id: parent.id });
      expect((await timeline(alice, pubId)).find((m) => m.id === cast.id)!.content).toBe('cast v3');
      const thread = (await request(app).get(`/messages/${parent.id}/thread`).set(auth(alice))).body;
      expect(thread.replies.find((r: any) => r.id === cast.id).content).toBe('cast v3');
      // 삭제하면 타임라인과 스레드 양쪽에서 사라진다
      await request(app).delete(`/messages/${cast.id}`).set(auth(bob));
      expect((await timeline(alice, pubId)).some((m) => m.id === cast.id)).toBe(false);
      const after = (await request(app).get(`/messages/${parent.id}/thread`).set(auth(alice))).body;
      expect(after.replies.some((r: any) => r.id === cast.id)).toBe(false);
    });

    it('notifies the parent author and repliers when the parent is deleted', async () => {
      const parent = (await post(alice, pubId, 'delete event parent')).body;
      await reply(bob, parent.id, 'still here');
      const [sa, sb, sc] = [await connect(alice), await connect(bob), await connect(carol)];
      const [ea, eb, ec] = [collect(sa, 'thread:updated'), collect(sb, 'thread:updated'), collect(sc, 'thread:updated')];
      expect((await request(app).delete(`/messages/${parent.id}`).set(auth(alice))).status).toBe(200);
      await settle();
      await pause();
      expect(ea).toHaveLength(1);
      expect(ea[0]).toMatchObject({ parentId: parent.id, replyCount: 1 });
      expect(eb).toHaveLength(1);
      expect(ec).toHaveLength(0);
      // 부모 작성자는 삭제 뒤에도 답글이 달리면 알림을 받지 못하는 것이 아니라 참여자로 남는다(새 답글은 404라 달 수 없다)
      expect(parentIds(await list(alice))).toContain(parent.id);
    });

    it('never moves the read position backwards', async () => {
      const parent = (await post(alice, pubId, 'greatest parent')).body;
      const r1 = (await reply(bob, parent.id, 'g1')).body;
      const r2 = (await reply(bob, parent.id, 'g2')).body;
      await request(app).post(`/threads/${parent.id}/read`).set(auth(alice)).send({ lastReadReplyId: r2.id });
      // 늦게 처리된 오래된 답글 후처리가 읽음 위치를 되돌리면 안 된다
      await onThreadReplyCreated({ id: r1.id, userId: alice.id, channelId: pubId, threadId: parent.id });
      const row = await prisma.threadRead.findUnique({ where: { userId_threadId: { userId: alice.id, threadId: parent.id } } });
      expect(row!.lastReadReplyId).toBe(r2.id);
      // 동시에 여러 번 호출해도 하나의 행으로 앞쪽 값만 남는다
      const r3 = (await reply(bob, parent.id, 'g3')).body;
      await Promise.all([r1, r3, r2].map((r) => onThreadReplyCreated({ id: r.id, userId: carol.id, channelId: pubId, threadId: parent.id })));
      const rows = await prisma.threadRead.findMany({ where: { userId: carol.id, threadId: parent.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].lastReadReplyId).toBe(r3.id);
    });

    it('limits inline replies per thread to the most recent 20 and returns the real total', async () => {
      const parent = (await post(alice, pubId, 'many replies parent')).body;
      const ids: number[] = [];
      for (let i = 0; i < 22; i++) ids.push((await reply(bob, parent.id, `m${i}`)).body.id);
      const item = (await list(alice)).body.items.find((i: any) => i.parent.id === parent.id);
      expect(item.replyCount).toBe(22);
      expect(item.replies).toHaveLength(20);
      expect(item.replies[19].id).toBe(ids[21]);
      expect(item.lastReply.id).toBe(ids[21]);
    });
  });
});
