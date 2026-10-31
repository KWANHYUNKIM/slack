import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-act@example.com`, password: TEST_PASSWORD, name });
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

describe('Activity: mentions, thread replies, reactions', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  let alice: TestUser, bob: TestUser, carol: TestUser, dave: TestUser, eve: TestUser, frank: TestUser;
  let pubId: number;
  let privId: number;
  const sockets: ClientSocket[] = [];

  const activityOf = (u: TestUser, query = '') =>
    request(app).get(`/activity${query}`).set(auth(u));
  const unread = async (u: TestUser) => (await request(app).get('/activity/unread-count').set(auth(u))).body;
  const post = (u: TestUser, channelId: number, content: string, extra: object = {}) =>
    request(app).post(`/channels/${channelId}/messages`).set(auth(u)).send({ content, ...extra });
  const dbActivities = (where: object) => prisma.activity.findMany({ where, orderBy: { id: 'asc' } });

  function connect(u: TestUser): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = Client(`http://localhost:${port}`, { auth: { token: u.token }, forceNew: true });
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
    [alice, bob, carol, dave, eve, frank] = [
      await register('Alice'), await register('Bob'), await register('Carol'),
      await register('Dave'), await register('Eve'), await register('Frank'),
    ];

    // #pub: alice, bob, carol, dave, eve. frank is NOT a member.
    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'act-pub' })).body.id;
    for (const u of [bob, carol, dave, eve]) {
      await request(app).post(`/channels/${pubId}/join`).set(auth(u));
    }
    // #priv: alice (creator), bob, carol. eve and frank are NOT members.
    privId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'act-priv', isPrivate: true })).body.id;
    for (const u of [bob, carol]) {
      await request(app).post(`/channels/${privId}/members`).set(auth(alice)).send({ userId: u.id });
    }
    // dave is deactivated but still a channel member
    await prisma.user.update({ where: { id: dave.id }, data: { deactivatedAt: new Date() } });

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(() => {
        const address = httpServer.address();
        port = typeof address === 'object' && address ? address.port : 3001;
        resolve();
      });
    });
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    io.close();
    httpServer.close();
  });

  afterEach(async () => {
    await prisma.activity.deleteMany();
  });

  describe('auth and validation', () => {
    it('requires authentication on every endpoint', async () => {
      expect((await request(app).get('/activity')).status).toBe(401);
      expect((await request(app).get('/activity/unread-count')).status).toBe(401);
      expect((await request(app).post('/activity/read').send({ all: true })).status).toBe(401);
    });

    it('rejects invalid query and body with 400', async () => {
      expect((await activityOf(alice, '?type=bogus')).status).toBe(400);
      expect((await activityOf(alice, '?limit=0')).status).toBe(400);
      expect((await activityOf(alice, '?limit=abc')).status).toBe(400);
      expect((await activityOf(alice, '?cursor=-1')).status).toBe(400);
      expect((await request(app).post('/activity/read').set(auth(alice)).send({})).status).toBe(400);
      expect((await request(app).post('/activity/read').set(auth(alice)).send({ ids: [] })).status).toBe(400);
      expect((await request(app).post('/activity/read').set(auth(alice)).send({ ids: ['x'] })).status).toBe(400);
      expect((await request(app).post('/activity/read').set(auth(alice)).send({ all: true, extra: 1 })).status).toBe(400);
    });
  });

  describe('HTTP: mention CRUD flow', () => {
    it('Create: mention creates activities only for eligible recipients', async () => {
      const res = await post(alice, pubId, `hi ${mention(bob)} ${mention(alice)} ${mention(dave)} ${mention(frank)} ${mention(carol)}`);
      expect(res.status).toBe(201);
      const rows = await dbActivities({ messageId: res.body.id });
      // bob and carol only: not self, not deactivated, not a non-member
      expect(rows.map((r) => r.userId).sort()).toEqual([bob.id, carol.id].sort());
      expect(rows.every((r) => r.type === 'MENTION' && r.actorId === alice.id && r.channelId === pubId)).toBe(true);
    });

    it('Read: lists items, counts unread, and hides them from other users', async () => {
      const m = await post(alice, pubId, `hello ${mention(bob)}`);
      const list = await activityOf(bob);
      expect(list.status).toBe(200);
      expect(list.body.items).toHaveLength(1);
      const item = list.body.items[0];
      expect(item).toMatchObject({
        type: 'MENTION',
        actor: { id: alice.id, name: 'Alice' },
        channel: { id: pubId, name: 'act-pub' },
        messageId: m.body.id,
        readAt: null,
      });
      expect(item.message.excerpt).toContain('hello');
      expect(await unread(bob)).toEqual({ total: 1, mentions: 1 });

      // carol sees nothing of bob's activity
      expect((await activityOf(carol)).body.items).toEqual([]);
      expect(await unread(carol)).toEqual({ total: 0, mentions: 0 });

      // carol cannot mark bob's activity as read: ignored, bob's stays unread
      const hijack = await request(app).post('/activity/read').set(auth(carol)).send({ ids: [item.id] });
      expect(hijack.status).toBe(200);
      expect(hijack.body.updated).toBe(0);
      expect(await unread(bob)).toEqual({ total: 1, mentions: 1 });

      const own = await request(app).post('/activity/read').set(auth(bob)).send({ ids: [item.id] });
      expect(own.body.updated).toBe(1);
      expect(await unread(bob)).toEqual({ total: 0, mentions: 0 });
      expect((await activityOf(bob)).body.items[0].readAt).not.toBeNull();
    });

    it('Update: editing adds only new mentions and drops removed ones', async () => {
      const m = await post(alice, pubId, `first ${mention(bob)}`);
      const bobActivity = (await dbActivities({ userId: bob.id }))[0];

      // keep bob, add carol: bob's row is untouched (same id), carol's is new
      let edit = await request(app).patch(`/messages/${m.body.id}`).set(auth(alice)).send({ content: `edit ${mention(bob)} ${mention(carol)}` });
      expect(edit.status).toBe(200);
      expect((await dbActivities({ userId: bob.id }))[0].id).toBe(bobActivity.id);
      expect(await dbActivities({ userId: carol.id })).toHaveLength(1);

      // drop bob
      edit = await request(app).patch(`/messages/${m.body.id}`).set(auth(alice)).send({ content: `edit ${mention(carol)}` });
      expect(edit.status).toBe(200);
      expect(await dbActivities({ userId: bob.id })).toHaveLength(0);
      expect(await dbActivities({ userId: carol.id })).toHaveLength(1);
      expect((await activityOf(bob)).body.items).toEqual([]);

      // drop all mentions
      await request(app).patch(`/messages/${m.body.id}`).set(auth(alice)).send({ content: 'no mentions now' });
      expect(await dbActivities({ messageId: m.body.id })).toHaveLength(0);
    });

    it('Delete: deleting the message removes its activities, listing no longer shows it', async () => {
      const m = await post(alice, pubId, `bye ${mention(bob)}`);
      expect(await dbActivities({ messageId: m.body.id })).toHaveLength(1);
      const del = await request(app).delete(`/messages/${m.body.id}`).set(auth(alice));
      expect(del.status).toBe(200);
      expect(await dbActivities({ messageId: m.body.id })).toHaveLength(0);
      expect((await activityOf(bob)).body.items).toEqual([]);
      expect(await unread(bob)).toEqual({ total: 0, mentions: 0 });
    });

    it('paginates with a cursor', async () => {
      for (let i = 0; i < 5; i++) await post(alice, pubId, `m${i} ${mention(bob)}`);
      const page1 = await activityOf(bob, '?limit=2');
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.nextCursor).not.toBeNull();
      const page2 = await activityOf(bob, `?limit=2&cursor=${page1.body.nextCursor}`);
      expect(page2.body.items).toHaveLength(2);
      const page3 = await activityOf(bob, `?limit=2&cursor=${page2.body.nextCursor}`);
      expect(page3.body.items).toHaveLength(1);
      expect(page3.body.nextCursor).toBeNull();
      const ids = [...page1.body.items, ...page2.body.items, ...page3.body.items].map((i: any) => i.id);
      expect(new Set(ids).size).toBe(5);
      expect(ids).toEqual([...ids].sort((a, b) => b - a)); // newest first
    });

    it('filters by type', async () => {
      const m = await post(alice, pubId, `x ${mention(bob)}`);
      await request(app).post(`/messages/${m.body.id}/reply`).set(auth(carol)).send({ content: 'reply' });
      await request(app).post(`/messages/${m.body.id}/reactions`).set(auth(carol)).send({ emoji: '👍' });
      expect((await activityOf(bob, '?type=mentions')).body.items.map((i: any) => i.type)).toEqual(['MENTION']);
      expect((await activityOf(alice, '?type=threads')).body.items.map((i: any) => i.type)).toEqual(['THREAD_REPLY']);
      expect((await activityOf(alice, '?type=reactions')).body.items.map((i: any) => i.type)).toEqual(['REACTION']);
      expect((await activityOf(alice, '?type=all')).body.items).toHaveLength(2);
    });

    it('stops showing activity of a channel the user left', async () => {
      await post(alice, privId, `secret ${mention(bob)}`);
      expect((await activityOf(bob)).body.items).toHaveLength(1);
      await prisma.channelMember.delete({ where: { userId_channelId: { userId: bob.id, channelId: privId } } });
      expect((await activityOf(bob)).body.items).toEqual([]);
      expect(await unread(bob)).toEqual({ total: 0, mentions: 0 });
      await prisma.channelMember.create({ data: { userId: bob.id, channelId: privId } });
    });
  });

  describe('@channel and @here', () => {
    it('@channel notifies every member except the author and inactive users', async () => {
      const m = await post(alice, pubId, 'heads up <@channel>');
      const rows = await dbActivities({ messageId: m.body.id });
      expect(rows.map((r) => r.userId).sort()).toEqual([bob.id, carol.id, eve.id].sort());
      expect(rows.every((r) => r.type === 'CHANNEL_MENTION')).toBe(true);
    });

    it('@here notifies only members who are online', async () => {
      const bobSocket = await connect(bob);
      const m = await post(alice, pubId, 'ping <@here>');
      const rows = await dbActivities({ messageId: m.body.id });
      expect(rows.map((r) => r.userId)).toEqual([bob.id]);
      expect(rows[0].type).toBe('HERE_MENTION');
      bobSocket.disconnect();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('a direct mention wins over @channel for the same person (one row)', async () => {
      const m = await post(alice, pubId, `<@channel> ${mention(bob)}`);
      const bobRows = await dbActivities({ messageId: m.body.id, userId: bob.id });
      expect(bobRows).toHaveLength(1);
      expect(bobRows[0].type).toBe('MENTION');
    });

    it('private channel: non-members are never targeted', async () => {
      const m = await post(alice, privId, `<@channel> ${mention(eve)} ${mention(frank)}`);
      const rows = await dbActivities({ messageId: m.body.id });
      expect(rows.map((r) => r.userId).sort()).toEqual([bob.id, carol.id].sort());
      expect((await activityOf(eve)).body.items).toEqual([]);
      expect((await activityOf(frank)).body.items).toEqual([]);
    });

    it('editing out @channel removes channel-mention rows, adding it later notifies again', async () => {
      const m = await post(alice, pubId, 'x <@channel>');
      expect(await dbActivities({ messageId: m.body.id })).toHaveLength(3);
      await request(app).patch(`/messages/${m.body.id}`).set(auth(alice)).send({ content: 'x' });
      expect(await dbActivities({ messageId: m.body.id })).toHaveLength(0);
      await request(app).patch(`/messages/${m.body.id}`).set(auth(alice)).send({ content: 'x <@channel>' });
      expect(await dbActivities({ messageId: m.body.id })).toHaveLength(3);
    });
  });

  describe('thread replies and reactions', () => {
    it('thread reply notifies the parent author and earlier participants, not the replier', async () => {
      const parent = await post(alice, pubId, 'parent');
      const r1 = await request(app).post(`/messages/${parent.body.id}/reply`).set(auth(bob)).send({ content: 'r1' });
      expect(r1.status).toBe(201);
      expect((await dbActivities({ type: 'THREAD_REPLY' })).map((a) => a.userId)).toEqual([alice.id]);

      await request(app).post(`/messages/${parent.body.id}/reply`).set(auth(carol)).send({ content: 'r2' });
      const rows = await dbActivities({ type: 'THREAD_REPLY', actorId: carol.id });
      expect(rows.map((a) => a.userId).sort()).toEqual([alice.id, bob.id].sort());
      expect(await unread(alice)).toEqual({ total: 2, mentions: 0 });
      const item = (await activityOf(alice, '?type=threads')).body.items[0];
      expect(item.threadId).toBe(parent.body.id);
    });

    it('a mention inside a thread reply creates a mention, not a duplicate thread-reply', async () => {
      const parent = await post(alice, pubId, 'parent');
      await request(app).post(`/messages/${parent.body.id}/reply`).set(auth(bob)).send({ content: 'r1' });
      await request(app).post(`/messages/${parent.body.id}/reply`).set(auth(carol)).send({ content: `hey ${mention(bob)}` });
      const bobRows = await dbActivities({ userId: bob.id });
      expect(bobRows.map((a) => a.type)).toEqual(['MENTION']);
    });

    it('reaction notifies the message author, not self, and no duplicates', async () => {
      const m = await post(alice, pubId, 'react to me');
      await request(app).post(`/messages/${m.body.id}/reactions`).set(auth(alice)).send({ emoji: '👍' });
      expect(await dbActivities({ type: 'REACTION' })).toHaveLength(0);

      const res = await request(app).post(`/messages/${m.body.id}/reactions`).set(auth(bob)).send({ emoji: '🎉' });
      expect(res.status).toBe(201);
      const dup = await request(app).post(`/messages/${m.body.id}/reactions`).set(auth(bob)).send({ emoji: '🎉' });
      expect(dup.status).toBe(400);
      const rows = await dbActivities({ type: 'REACTION' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: alice.id, actorId: bob.id, emoji: '🎉', messageId: m.body.id });
      expect((await activityOf(alice, '?type=reactions')).body.items[0].emoji).toBe('🎉');

      // removing the reaction removes the activity
      const del = await request(app).delete(`/messages/${m.body.id}/reactions/${encodeURIComponent('🎉')}`).set(auth(bob));
      expect(del.status).toBe(200);
      expect(await dbActivities({ type: 'REACTION' })).toHaveLength(0);
    });

    it('deleting the reacted message removes the reaction activity', async () => {
      const m = await post(alice, pubId, 'will be deleted');
      await request(app).post(`/messages/${m.body.id}/reactions`).set(auth(bob)).send({ emoji: '👍' });
      expect(await dbActivities({ type: 'REACTION' })).toHaveLength(1);
      await request(app).delete(`/messages/${m.body.id}`).set(auth(alice));
      expect(await dbActivities({ type: 'REACTION' })).toHaveLength(0);
    });
  });

  describe('read state and mentionCount', () => {
    it('/channels/:id/read lowers mentionCount and marks the mention read', async () => {
      const m1 = await post(alice, pubId, `a ${mention(bob)}`);
      const m2 = await post(alice, pubId, `b ${mention(bob)}`);
      const channelsOf = async (u: TestUser) =>
        (await request(app).get('/channels').set(auth(u))).body.find((c: any) => c.id === pubId);

      expect((await channelsOf(bob)).mentionCount).toBe(2);
      expect((await channelsOf(carol)).mentionCount).toBe(0);

      await request(app).post(`/channels/${pubId}/read`).set(auth(bob)).send({ messageId: m1.body.id });
      expect((await channelsOf(bob)).mentionCount).toBe(1);
      expect(await unread(bob)).toEqual({ total: 1, mentions: 1 });

      await request(app).post(`/channels/${pubId}/read`).set(auth(bob)).send({ messageId: m2.body.id });
      expect((await channelsOf(bob)).mentionCount).toBe(0);
      expect(await unread(bob)).toEqual({ total: 0, mentions: 0 });
    });

    it('POST /activity/read with all marks everything read', async () => {
      await post(alice, pubId, `a ${mention(bob)}`);
      await post(alice, privId, `b ${mention(bob)}`);
      expect((await unread(bob)).total).toBe(2);
      const res = await request(app).post('/activity/read').set(auth(bob)).send({ all: true });
      expect(res.body.updated).toBe(2);
      expect(await unread(bob)).toEqual({ total: 0, mentions: 0 });
    });
  });

  describe('DM', () => {
    it('DM mention flow: create, mentionCount, read, edit, delete', async () => {
      const send = await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: `yo ${mention(bob)}` });
      expect(send.status).toBe(201);
      const rows = await dbActivities({ dmId: send.body.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: bob.id, actorId: alice.id, type: 'MENTION', channelId: null });

      const item = (await activityOf(bob)).body.items[0];
      expect(item).toMatchObject({ dmId: send.body.id, channel: null });

      const convs = (await request(app).get('/dms').set(auth(bob))).body;
      expect(convs.find((c: any) => c.otherUser.id === alice.id).mentionCount).toBe(1);

      // edit removes the mention, edit again adds it back
      await request(app).patch(`/dms/messages/${send.body.id}`).set(auth(alice)).send({ content: 'no mention' });
      expect(await dbActivities({ dmId: send.body.id })).toHaveLength(0);
      await request(app).patch(`/dms/messages/${send.body.id}`).set(auth(alice)).send({ content: `again ${mention(bob)}` });
      expect(await dbActivities({ dmId: send.body.id })).toHaveLength(1);

      await request(app).post(`/dms/${alice.id}/read`).set(auth(bob));
      const convs2 = (await request(app).get('/dms').set(auth(bob))).body;
      expect(convs2.find((c: any) => c.otherUser.id === alice.id).mentionCount).toBe(0);

      const del = await request(app).delete(`/dms/messages/${send.body.id}`).set(auth(alice));
      expect(del.status).toBe(200);
      expect(await dbActivities({ dmId: send.body.id })).toHaveLength(0);
    });

    it('does not create activity for a self-DM mention or a plain DM', async () => {
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: alice.id, content: `me ${mention(alice)}` });
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'plain' });
      expect(await dbActivities({})).toHaveLength(0);
    });

    it('DM thread reply and reaction create activities', async () => {
      const parent = await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'parent' });
      const reply = await request(app).post(`/dms/messages/${parent.body.id}/reply`).set(auth(bob)).send({ content: 'reply' });
      expect(reply.status).toBe(201);
      expect((await dbActivities({ type: 'THREAD_REPLY' })).map((a) => a.userId)).toEqual([alice.id]);

      await request(app).post(`/dms/messages/${parent.body.id}/reactions`).set(auth(bob)).send({ emoji: '👍' });
      const rx = await dbActivities({ type: 'REACTION' });
      expect(rx).toHaveLength(1);
      expect(rx[0]).toMatchObject({ userId: alice.id, dmId: parent.body.id });
      await request(app).delete(`/dms/messages/${parent.body.id}/reactions/${encodeURIComponent('👍')}`).set(auth(bob));
      expect(await dbActivities({ type: 'REACTION' })).toHaveLength(0);
    });
  });

  describe('WebSocket path', () => {
    it('message:send with a mention creates an activity and emits activity:new', async () => {
      const aliceSocket = await connect(alice);
      const bobSocket = await connect(bob);
      const newEvents = collect(bobSocket, 'activity:new');

      const ack = await new Promise<any>((resolve) =>
        aliceSocket.emit('message:send', { channelId: pubId, content: `ws ${mention(bob)}` }, resolve));
      expect(ack).toEqual({});

      await waitFor(() => newEvents, (e) => e.length === 1);
      expect(newEvents[0].activity).toMatchObject({
        type: 'MENTION',
        actor: { id: alice.id },
        channel: { id: pubId },
      });
      expect(await dbActivities({ userId: bob.id })).toHaveLength(1);
      expect((await activityOf(bob)).body.items).toHaveLength(1);
      aliceSocket.disconnect();
      bobSocket.disconnect();
    });

    it('Create/Update/Delete over WebSocket keeps activities in sync', async () => {
      const aliceSocket = await connect(alice);
      const bobSocket = await connect(bob);
      const carolSocket = await connect(carol);
      const bobNew = collect(bobSocket, 'activity:new');
      const bobRemoved = collect(bobSocket, 'activity:removed');
      const carolNew = collect(carolSocket, 'activity:new');

      const created = new Promise<any>((resolve) => aliceSocket.once('message:new', resolve));
      aliceSocket.emit('message:send', { channelId: pubId, content: `v1 ${mention(bob)}` });
      const msg = await created;
      await waitFor(() => bobNew, (e) => e.length === 1);

      // edit: remove bob, add carol (only carol is newly notified)
      aliceSocket.emit('message:edit', { messageId: msg.id, content: `v2 ${mention(carol)}` });
      await waitFor(() => carolNew, (e) => e.length === 1);
      await waitFor(() => bobRemoved, (e) => e.length === 1);
      expect(await dbActivities({ messageId: msg.id, userId: bob.id })).toHaveLength(0);
      expect(await dbActivities({ messageId: msg.id, userId: carol.id })).toHaveLength(1);
      expect(bobNew).toHaveLength(1); // no new event for bob on edit

      // delete: carol's activity is cleaned up
      const carolRemoved = collect(carolSocket, 'activity:removed');
      aliceSocket.emit('message:delete', { messageId: msg.id });
      await waitFor(() => carolRemoved, (e) => e.length === 1);
      expect(await dbActivities({ messageId: msg.id })).toHaveLength(0);

      [aliceSocket, bobSocket, carolSocket].forEach((s) => s.disconnect());
    });

    it('message:send in a thread over WebSocket creates THREAD_REPLY', async () => {
      const parent = await post(alice, pubId, 'parent');
      const bobSocket = await connect(bob);
      const aliceNew = collect(await connect(alice), 'activity:new');
      const ack = await new Promise<any>((resolve) =>
        bobSocket.emit('message:send', { channelId: pubId, content: 'ws reply', threadId: parent.body.id }, resolve));
      expect(ack).toEqual({});
      await waitFor(() => aliceNew, (e) => e.length === 1);
      expect(aliceNew[0].activity.type).toBe('THREAD_REPLY');
    });

    it('dm:send with a mention creates an activity and emits activity:new', async () => {
      const aliceSocket = await connect(alice);
      const bobSocket = await connect(bob);
      const bobNew = collect(bobSocket, 'activity:new');
      aliceSocket.emit('dm:send', { toUserId: bob.id, content: `dm ${mention(bob)}` });
      await waitFor(() => bobNew, (e) => e.length === 1);
      expect(bobNew[0].activity).toMatchObject({ type: 'MENTION', channel: null });
      expect(bobNew[0].activity.dmId).toEqual(expect.any(Number));
    });

    it('activity:read is delivered to the user rooms when marking read', async () => {
      const bobSocket = await connect(bob);
      const reads = collect(bobSocket, 'activity:read');
      await post(alice, pubId, `r ${mention(bob)}`);
      const id = (await dbActivities({ userId: bob.id }))[0].id;
      await request(app).post('/activity/read').set(auth(bob)).send({ ids: [id] });
      await waitFor(() => reads, (e) => e.length === 1);
      expect(reads[0]).toEqual({ ids: [id] });
    });

    it('activity:new over the HTTP path reaches the recipient socket', async () => {
      const bobSocket = await connect(bob);
      const bobNew = collect(bobSocket, 'activity:new');
      await post(alice, pubId, `http ${mention(bob)}`);
      await waitFor(() => bobNew, (e) => e.length === 1);
      expect(bobNew[0].activity.type).toBe('MENTION');
    });
  });
});
