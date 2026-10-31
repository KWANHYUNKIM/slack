import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { clearTokenCache } from '../middleware/auth.js';

// 안 읽음 구분선(1:1 DM, 그룹 DM): ?withUnread=1 응답의 { lastReadId, unreadCount }는 읽음 처리 이전 값이다.
interface TestUser { id: number; token: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app).post('/auth/register').send({ email: `${name}-dmdiv@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token };
}
const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

describe('DM unread baseline', () => {
  let a: TestUser, b: TestUser, c: TestUser, d: TestUser;

  const sendDM = async (from: TestUser, to: TestUser, content: string) => {
    const res = await request(app).post('/dms').set(auth(from)).send({ toUserId: to.id, content });
    expect(res.status).toBe(201);
    return res.body.id as number;
  };
  const openDM = async (u: TestUser, other: TestUser) => {
    const res = await request(app).get(`/dms/${other.id}?withUnread=1`).set(auth(u));
    expect(res.status).toBe(200);
    return res.body as { messages: Array<{ id: number }>; lastReadId: number | null; unreadCount: number };
  };
  const sendGroup = async (from: TestUser, groupId: number, content: string) => {
    const res = await request(app).post(`/dms/groups/${groupId}/messages`).set(auth(from)).send({ content });
    expect(res.status).toBe(201);
    return res.body.id as number;
  };
  const openGroup = async (u: TestUser, groupId: number) => {
    const res = await request(app).get(`/dms/groups/${groupId}/messages?withUnread=1`).set(auth(u));
    expect(res.status).toBe(200);
    return res.body as { messages: Array<{ id: number }>; lastReadId: number | null; unreadCount: number };
  };

  beforeEach(async () => {
    clearTokenCache();
    await prisma.directMessage.deleteMany();
    await prisma.dMGroupMember.deleteMany();
    await prisma.dMGroup.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();
    [a, b, c, d] = [await register('a'), await register('b'), await register('c'), await register('d')];
  });

  describe('1:1 DM', () => {
    it('CRUD: 상대가 3개 보낸 뒤 열면 기준점이 있고, 다시 열면 안 읽음이 없다', async () => {
      const mine = await sendDM(a, b, 'hello');
      const ids = [await sendDM(b, a, 'one'), await sendDM(b, a, 'two'), await sendDM(b, a, 'three')];

      // 상대가 쓴 3개가 안 읽음: 기준점은 그 앞의 내 메시지
      const first = await openDM(a, b);
      expect(first).toMatchObject({ lastReadId: mine, unreadCount: 3 });
      expect(first.messages).toHaveLength(4);

      // 열면서 읽음 처리됨: 다시 열면 기준점이 최신, 안 읽음 0
      expect(await openDM(a, b)).toMatchObject({ lastReadId: ids[2], unreadCount: 0 });

      // 새 메시지 1개 -> 그 앞이 기준점
      await sendDM(b, a, 'four');
      expect(await openDM(a, b)).toMatchObject({ lastReadId: ids[2], unreadCount: 1 });
    });

    it('처음부터 전부 안 읽음이면 lastReadId가 null이다', async () => {
      await sendDM(b, a, 'one');
      expect(await openDM(a, b)).toMatchObject({ lastReadId: null, unreadCount: 1 });
    });

    it('안 읽은 메시지를 삭제하면 센 값이 줄고 기준점이 다음으로 옮겨 간다', async () => {
      const ids = [await sendDM(b, a, 'one'), await sendDM(b, a, 'two'), await sendDM(b, a, 'three')];
      const del = await request(app).delete(`/dms/messages/${ids[0]}`).set(auth(b));
      expect(del.status).toBe(200);
      // 삭제된 첫 메시지는 건너뛴다: 안 읽음 2
      const res = await openDM(a, b);
      expect(res.unreadCount).toBe(2);
      expect(res.messages.map((m) => m.id).sort()).toEqual([ids[1], ids[2]]);
    });

    it('읽지 않음으로 표시하면 기준점이 그 앞 메시지로 돌아간다', async () => {
      const ids = [await sendDM(b, a, 'm1'), await sendDM(b, a, 'm2'), await sendDM(b, a, 'm3')];
      await openDM(a, b); // 읽음 처리
      const mark = await request(app).post(`/dms/${b.id}/unread`).set(auth(a)).send({ messageId: ids[1] });
      expect(mark.status).toBe(200);
      expect(await openDM(a, b)).toMatchObject({ lastReadId: ids[0], unreadCount: 2 });
    });

    it('?withUnread=1이 없거나 이전 페이지·around 요청이면 기준점 필드가 없다', async () => {
      const ids = [await sendDM(b, a, 'x'), await sendDM(b, a, 'y')];
      const plain = await request(app).get(`/dms/${b.id}`).set(auth(a));
      expect(plain.body.unreadCount).toBeUndefined();
      const around = await request(app).get(`/dms/${b.id}?withUnread=1&around=${ids[0]}`).set(auth(a));
      expect(around.body.unreadCount).toBeUndefined();
      const paged = await request(app).get(`/dms/${b.id}?withUnread=1&cursor=${ids[1]}`).set(auth(a));
      expect(paged.body.unreadCount).toBeUndefined();
    });

    it('나와의 대화와 빈 대화는 안 읽음 0이다', async () => {
      const selfId = await sendDM(a, a, 'memo');
      expect(await openDM(a, a)).toMatchObject({ lastReadId: selfId, unreadCount: 0 });
      expect(await openDM(a, c)).toMatchObject({ lastReadId: null, unreadCount: 0 });
    });

    it('남의 대화 기준점은 볼 수 없다: 내 토큰으로는 항상 내 쪽 대화만 계산된다', async () => {
      await sendDM(b, a, 'for a only');
      // c가 a와의 대화를 열어도 b->a 메시지는 c에게 보이지 않고 안 읽음도 없다
      const res = await openDM(c, a);
      expect(res.messages).toHaveLength(0);
      expect(res.unreadCount).toBe(0);
    });
  });

  describe('그룹 DM', () => {
    let groupId: number;
    beforeEach(async () => {
      const g = await request(app).post('/dms/groups').set(auth(a)).send({ userIds: [b.id, c.id] });
      expect(g.status).toBeLessThan(300);
      groupId = g.body.group.id;
    });

    it('CRUD: 다른 멤버가 3개 보낸 뒤 열면 기준점이 있고, 다시 열면 안 읽음이 없다', async () => {
      const mine = await sendGroup(a, groupId, 'hello');
      await openGroup(a, groupId); // 내 커서를 mine까지
      const ids = [await sendGroup(b, groupId, 'one'), await sendGroup(c, groupId, 'two'), await sendGroup(b, groupId, 'three')];

      const first = await openGroup(a, groupId);
      expect(first).toMatchObject({ lastReadId: mine, unreadCount: 3 });
      expect(first.messages).toHaveLength(4);

      // 열면 커서가 옮겨진다
      expect(await openGroup(a, groupId)).toMatchObject({ lastReadId: ids[2], unreadCount: 0 });

      await sendGroup(c, groupId, 'four');
      expect(await openGroup(a, groupId)).toMatchObject({ lastReadId: ids[2], unreadCount: 1 });
    });

    it('안 읽은 메시지를 삭제하면 센 값에서 빠진다', async () => {
      await openGroup(a, groupId);
      const ids = [await sendGroup(b, groupId, 'one'), await sendGroup(b, groupId, 'two')];
      const del = await request(app).delete(`/dms/messages/${ids[0]}`).set(auth(b));
      expect(del.status).toBe(200);
      const res = await openGroup(a, groupId);
      expect(res.unreadCount).toBe(1);
      expect(res.messages.map((m) => m.id)).toEqual([ids[1]]);
    });

    it('비멤버가 기준점을 요청하면 거부된다', async () => {
      await sendGroup(b, groupId, 'secret');
      const res = await request(app).get(`/dms/groups/${groupId}/messages?withUnread=1`).set(auth(d));
      expect([403, 404]).toContain(res.status);
      expect(res.body.unreadCount).toBeUndefined();
      expect(res.body.messages).toBeUndefined();
    });

    it('?withUnread=1이 없으면 기준점 필드가 없다', async () => {
      await sendGroup(b, groupId, 'x');
      const res = await request(app).get(`/dms/groups/${groupId}/messages`).set(auth(a));
      expect(res.body.unreadCount).toBeUndefined();
    });
  });
});
