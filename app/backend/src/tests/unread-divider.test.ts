import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';

// 안 읽음 구분선: GET /channels/:id가 내려주는 열기 직전의 읽음 기준점과 안 읽음 수
describe('GET /channels/:id unread baseline', () => {
  let aToken: string;
  let bToken: string;
  let channelId: number;
  let bUserId: number;

  const post = async (token: string, content: string, extra: object = {}) => {
    const res = await request(app).post(`/channels/${channelId}/messages`).set('Authorization', `Bearer ${token}`).send({ content, ...extra });
    expect(res.status).toBe(201);
    return res.body.id as number;
  };
  const open = async (token: string) => {
    const res = await request(app).get(`/channels/${channelId}?withUnread=1`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as { lastReadMessageId: number | null; unreadCount: number };
  };
  const read = (token: string, messageId: number) =>
    request(app).post(`/channels/${channelId}/read`).set('Authorization', `Bearer ${token}`).send({ messageId });

  beforeEach(async () => {
    await prisma.directMessage.deleteMany();
    await prisma.reaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    const a = await request(app).post('/auth/register').send({ email: 'divider-a@example.com', password: TEST_PASSWORD, name: 'Divider A' });
    aToken = a.body.token;
    const b = await request(app).post('/auth/register').send({ email: 'divider-b@example.com', password: TEST_PASSWORD, name: 'Divider B' });
    bToken = b.body.token;
    bUserId = b.body.user.id;
    const ch = await request(app).post('/channels').set('Authorization', `Bearer ${aToken}`).send({ name: 'divider-channel' });
    channelId = ch.body.id;
    await request(app).post(`/channels/${channelId}/join`).set('Authorization', `Bearer ${bToken}`);
  });

  it('CRUD 흐름: 쓰기 -> 열기(기준점) -> 읽음 -> 재진입 -> 추가 쓰기', async () => {
    const ids = [await post(bToken, 'one'), await post(bToken, 'two'), await post(bToken, 'three')];

    // A가 연다: 기준점은 읽음 처리 이전 값(아직 아무것도 안 읽음), 안 읽음 3
    expect(await open(aToken)).toMatchObject({ lastReadMessageId: null, unreadCount: 3 });
    // 열기 응답은 읽음 처리를 하지 않는다: 다시 열어도 같다
    expect(await open(aToken)).toMatchObject({ lastReadMessageId: null, unreadCount: 3 });

    await read(aToken, ids[2]);
    expect(await open(aToken)).toMatchObject({ lastReadMessageId: ids[2], unreadCount: 0 });

    const four = await post(bToken, 'four');
    expect(await open(aToken)).toMatchObject({ lastReadMessageId: ids[2], unreadCount: 1 });
    await read(aToken, four);
    expect((await open(aToken)).unreadCount).toBe(0);
  });

  it('내가 쓴 메시지가 있어도 기준점은 그대로다', async () => {
    const first = await post(bToken, 'b1');
    await read(aToken, first);
    await post(aToken, 'mine');
    expect((await open(aToken)).lastReadMessageId).toBe(first);
  });

  it('삭제된 메시지와 스레드 답글은 센 값에서 빠지고 채널에도 보낸 답글은 센다', async () => {
    const first = await post(bToken, 'b1');
    const second = await post(bToken, 'b2');
    await post(bToken, 'reply', { threadId: first });
    await post(bToken, 'reply too', { threadId: first, alsoSendToChannel: true });
    expect((await open(aToken)).unreadCount).toBe(3);
    const del = await request(app).delete(`/messages/${second}`).set('Authorization', `Bearer ${bToken}`);
    expect(del.status).toBe(200);
    expect((await open(aToken)).unreadCount).toBe(2);
  });

  it('읽지 않음으로 표시하면 기준점이 그 앞 메시지로 돌아간다', async () => {
    const ids = [await post(bToken, 'm1'), await post(bToken, 'm2'), await post(bToken, 'm3')];
    await read(aToken, ids[2]);
    const res = await request(app).post(`/channels/${channelId}/unread`).set('Authorization', `Bearer ${aToken}`).send({ messageId: ids[1] });
    expect(res.status).toBe(200);
    expect(await open(aToken)).toMatchObject({ lastReadMessageId: ids[0], unreadCount: 2 });
  });

  it('읽음 행이 없으면 목록 배지처럼 전부 안 읽음으로 본다', async () => {
    await post(bToken, 'x');
    await prisma.channelRead.deleteMany({ where: { channelId } });
    expect(await open(aToken)).toMatchObject({ lastReadMessageId: null, unreadCount: 1 });
  });

  it('비멤버가 공개 채널을 열어도 기준점 필드는 없다', async () => {
    const c = await request(app).post('/auth/register').send({ email: 'divider-c@example.com', password: TEST_PASSWORD, name: 'Divider C' });
    const res = await request(app).get(`/channels/${channelId}?withUnread=1`).set('Authorization', `Bearer ${c.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.lastReadMessageId).toBeUndefined();
  });

  it('?withUnread=1이 없으면 기준점을 계산하지 않는다', async () => {
    await post(bToken, 'x');
    const res = await request(app).get(`/channels/${channelId}`).set('Authorization', `Bearer ${aToken}`);
    expect(res.status).toBe(200);
    expect(res.body.lastReadMessageId).toBeUndefined();
    expect(res.body.unreadCount).toBeUndefined();
  });

  it('처음 여는 채널(읽음 행 없음): 기준점 조회 -> baseline -> 재조회 순서', async () => {
    const ids = [await post(bToken, 'one'), await post(bToken, 'two')];
    await prisma.channelRead.deleteMany({ where: { channelId } });
    // 프런트는 기준점을 먼저 받고 그다음에 baseline을 부른다: 기준점은 전부 안 읽음
    expect(await open(aToken)).toMatchObject({ lastReadMessageId: null, unreadCount: 2 });
    const baseline = await request(app).post(`/channels/${channelId}/read/baseline`).set('Authorization', `Bearer ${aToken}`);
    expect(baseline.status).toBe(200);
    // baseline 뒤에는 최신이 기준점이 된다(순서를 거꾸로 하면 구분선이 사라지는 이유)
    expect(await open(aToken)).toMatchObject({ lastReadMessageId: ids[1], unreadCount: 0 });
  });

  it('범위 밖 60개에 실시간 10개: 서버 수는 열 때 60, 이후 70이다', async () => {
    await prisma.message.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({ content: `bulk ${i}`, channelId, userId: bUserId })),
    });
    expect((await open(aToken)).unreadCount).toBe(60);
    await prisma.message.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ content: `live ${i}`, channelId, userId: bUserId })),
    });
    expect((await open(aToken)).unreadCount).toBe(70);
  });

  it('모두 읽음 후 새 메시지가 오면 기준점은 마지막 읽은 메시지, 안 읽음은 1이다', async () => {
    const ids = [await post(bToken, 'm1'), await post(bToken, 'm2')];
    await read(aToken, ids[1]);
    expect((await open(aToken)).unreadCount).toBe(0);
    await post(bToken, 'm3');
    expect(await open(aToken)).toMatchObject({ lastReadMessageId: ids[1], unreadCount: 1 });
  });
});
