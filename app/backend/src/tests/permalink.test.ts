import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';

interface TestUser { id: number; token: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-plk@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

describe('Message permalink: locate and around', () => {
  let alice: TestUser, bob: TestUser, carol: TestUser;
  let pubId: number;
  let privId: number;
  let groupId: number;

  const post = (u: TestUser, channelId: number, content: string) =>
    request(app).post(`/channels/${channelId}/messages`).set(auth(u)).send({ content });
  const locate = (u: TestUser, id: number, kind?: string) =>
    request(app).get(`/messages/${id}/locate${kind ? `?kind=${kind}` : ''}`).set(auth(u));

  beforeAll(async () => {
    [alice, bob, carol] = [await register('Alice'), await register('Bob'), await register('Carol')];
    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'plk-pub' })).body.id;
    await request(app).post(`/channels/${pubId}/join`).set(auth(bob));
    privId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'plk-priv', isPrivate: true })).body.id;
    await request(app).post(`/channels/${privId}/members`).set(auth(alice)).send({ userId: bob.id });
    groupId = (await request(app).post('/dms/groups').set(auth(alice)).send({ userIds: [bob.id, carol.id] })).body.group.id;
  });

  it('requires authentication and a valid id', async () => {
    expect((await request(app).get('/messages/1/locate')).status).toBe(401);
    expect((await locate(alice, 0)).status).toBe(400);
    expect((await locate(alice, 1, 'bogus')).status).toBe(400);
  });

  it('CRUD: create -> locate -> edit keeps link -> delete makes it not found', async () => {
    const msg = (await post(alice, pubId, 'permalink target')).body;

    // Read: 멤버는 채널 id를 받는다
    const found = await locate(alice, msg.id);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ messageId: msg.id, channelId: pubId });

    // around로 열면 대상이 들어 있다
    const around = await request(app).get(`/channels/${pubId}/messages?around=${msg.id}`).set(auth(alice));
    expect(around.status).toBe(200);
    expect(around.body.messages.map((m: { id: number }) => m.id)).toContain(msg.id);

    // Update: 수정해도 같은 링크가 유효하다
    expect((await request(app).patch(`/messages/${msg.id}`).set(auth(alice)).send({ content: 'edited' })).status).toBe(200);
    expect((await locate(alice, msg.id)).status).toBe(200);
    const afterEdit = await request(app).get(`/channels/${pubId}/messages?around=${msg.id}`).set(auth(alice));
    expect(afterEdit.body.messages.find((m: { id: number }) => m.id === msg.id).content).toBe('edited');

    // Delete: 삭제 뒤에는 locate와 around 모두 404
    expect((await request(app).delete(`/messages/${msg.id}`).set(auth(alice))).status).toBe(200);
    const gone = await locate(alice, msg.id);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('MESSAGE_NOT_FOUND');
    const goneAround = await request(app).get(`/channels/${pubId}/messages?around=${msg.id}`).set(auth(alice));
    expect(goneAround.status).toBe(404);
    expect(goneAround.body.code).toBe('MESSAGE_NOT_FOUND');
  });

  it('returns parentId for a thread reply', async () => {
    const parent = (await post(alice, pubId, 'parent')).body;
    const rep = (await request(app).post(`/messages/${parent.id}/reply`).set(auth(bob)).send({ content: 'reply' })).body;
    const res = await locate(alice, rep.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messageId: rep.id, channelId: pubId, parentId: parent.id });
  });

  it('hides private channel messages from non-members with the same 404 as a missing message', async () => {
    const msg = (await post(alice, privId, 'secret')).body;
    expect((await locate(bob, msg.id)).status).toBe(200);
    const denied = await locate(carol, msg.id);
    const missing = await locate(carol, 99999999);
    expect(denied.status).toBe(404);
    expect(denied.body).toEqual(missing.body);
    // around로도 내용을 얻을 수 없다
    expect((await request(app).get(`/channels/${privId}/messages?around=${msg.id}`).set(auth(carol))).status).toBe(403);
  });

  it('lets a non-member read a public channel message link', async () => {
    const msg = (await post(alice, pubId, 'public')).body;
    expect((await locate(carol, msg.id)).status).toBe(200);
  });

  it('returns 404 when around targets a message of another channel', async () => {
    const other = (await post(alice, privId, 'other channel')).body;
    const res = await request(app).get(`/channels/${pubId}/messages?around=${other.id}`).set(auth(alice));
    expect(res.status).toBe(404);
  });

  it('locates 1:1 DMs for both participants and hides them from others', async () => {
    const dm = (await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'hi bob' })).body;
    expect((await locate(alice, dm.id, 'dm')).body).toEqual({ messageId: dm.id, dmUserId: bob.id });
    expect((await locate(bob, dm.id, 'dm')).body).toEqual({ messageId: dm.id, dmUserId: alice.id });
    expect((await locate(carol, dm.id, 'dm')).status).toBe(404);
    // 삭제하면 참여자에게도 404
    await request(app).delete(`/dms/messages/${dm.id}`).set(auth(alice));
    expect((await locate(alice, dm.id, 'dm')).status).toBe(404);
  });

  it('locates group DM messages for members only', async () => {
    const dm = (await request(app).post(`/dms/groups/${groupId}/messages`).set(auth(alice)).send({ content: 'hi group' })).body;
    expect((await locate(carol, dm.id, 'dm')).body).toEqual({ messageId: dm.id, groupId });
    const dave = await register('Dave');
    expect((await locate(dave, dm.id, 'dm')).status).toBe(404);
  });
});
