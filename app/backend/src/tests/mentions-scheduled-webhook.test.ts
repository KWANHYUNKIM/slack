import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { settleBackgroundWork } from '../services/mentionService.js';
import { processDueScheduledMessages } from '../scheduler.js';

// 예약 메시지와 웹훅 메시지도 일반 메시지처럼 멘션 활동(Activity)을 만든다.
// 예약은 처리 함수를 직접 불러 전송하고, 웹훅은 공개 엔드포인트로 보낸다.

interface TestUser { id: number; token: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-smw@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token };
}

async function login(email: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ email, password: TEST_PASSWORD });
  return res.body.token;
}

// 예약 시각을 과거로 돌려 스케줄러가 집어 가게 한다(API는 과거 시각을 거부한다).
async function makeDue(scheduledId: number): Promise<void> {
  await prisma.scheduledMessage.update({
    where: { id: scheduledId },
    data: { scheduledAt: new Date(Date.now() - 1000) },
  });
}

describe('예약 메시지와 웹훅의 멘션 활동', () => {
  let author: TestUser;
  let mentioned: TestUser;
  let channelId: number;

  beforeEach(async () => {
    // 테스트마다 사용자를 새로 만들므로 이 파일의 데이터를 모두 비운다(setup.ts는 파일당 한 번만 비운다)
    await prisma.activity.deleteMany();
    await prisma.webhook.deleteMany();
    await prisma.scheduledMessage.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    // 웹훅은 ADMIN만 만들 수 있으므로 작성자를 ADMIN으로 올린 뒤 다시 로그인해 권한이 든 토큰을 받는다
    const authorReg = await register('Smw-Author');
    await prisma.user.update({ where: { id: authorReg.id }, data: { role: 'ADMIN' } });
    author = { id: authorReg.id, token: await login('smw-author-smw@example.com') };

    mentioned = await register('Smw-Mentioned');

    const channelRes = await request(app)
      .post('/channels')
      .set('Authorization', `Bearer ${author.token}`)
      .send({ name: 'smw-test-channel' });
    channelId = channelRes.body.id;

    // 멘션 대상이 채널 멤버여야 활동이 생긴다
    await prisma.channelMember.create({ data: { userId: mentioned.id, channelId } });
  });

  async function mentionActivities(userId: number, messageId?: number) {
    return prisma.activity.findMany({
      where: { userId, type: { in: ['MENTION', 'CHANNEL_MENTION', 'HERE_MENTION'] }, ...(messageId && { messageId }) },
    });
  }

  describe('예약 메시지', () => {
    it('생성, 조회, 수정, 삭제 후 처리 함수로 전송하면 멘션 활동이 1건 생긴다', async () => {
      const content = `예약 안내 <@${mentioned.id}|Smw-Mentioned> 확인 부탁해요`;

      // Create
      const createRes = await request(app)
        .post('/messages/schedule')
        .set('Authorization', `Bearer ${author.token}`)
        .send({ content, channelId, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
      expect(createRes.status).toBe(201);
      const scheduledId = createRes.body.id as number;

      // 지울 예약을 하나 더 만든다(Delete 확인용)
      const extraRes = await request(app)
        .post('/messages/schedule')
        .set('Authorization', `Bearer ${author.token}`)
        .send({ content: 'extra', channelId, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
      const extraId = extraRes.body.id as number;

      // Read
      const listRes = await request(app)
        .get('/messages/scheduled')
        .set('Authorization', `Bearer ${author.token}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.map((m: { id: number }) => m.id)).toEqual(expect.arrayContaining([scheduledId, extraId]));

      // Update: 본문을 고쳐도 멘션은 그대로 남는다
      const updated = `${content} (수정)`;
      const patchRes = await request(app)
        .patch(`/messages/scheduled/${scheduledId}`)
        .set('Authorization', `Bearer ${author.token}`)
        .send({ content: updated });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.content).toBe(updated);

      // Delete
      const delRes = await request(app)
        .delete(`/messages/scheduled/${extraId}`)
        .set('Authorization', `Bearer ${author.token}`);
      expect(delRes.status).toBe(200);
      const afterDelete = await request(app)
        .get('/messages/scheduled')
        .set('Authorization', `Bearer ${author.token}`);
      expect(afterDelete.body.map((m: { id: number }) => m.id)).not.toContain(extraId);

      // 아직 시각 전이면 처리 함수가 보내지 않는다
      await processDueScheduledMessages();
      await settleBackgroundWork();
      expect(await mentionActivities(mentioned.id)).toHaveLength(0);

      // 시각이 되면 처리 함수가 전송하고, 활동이 1건 생긴다
      await makeDue(scheduledId);
      await processDueScheduledMessages();
      await settleBackgroundWork();

      const sent = await prisma.message.findFirst({ where: { channelId, content: updated } });
      expect(sent).not.toBeNull();
      const activities = await mentionActivities(mentioned.id);
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({ type: 'MENTION', actorId: author.id, messageId: sent!.id, channelId });

      // 같은 예약을 다시 처리해도 메시지와 활동이 늘지 않는다(중복 생성 없음)
      await processDueScheduledMessages();
      await settleBackgroundWork();
      expect(await prisma.message.count({ where: { channelId, content: updated } })).toBe(1);
      expect(await mentionActivities(mentioned.id)).toHaveLength(1);
    });

    it('멘션 활동이 생긴 뒤 GET /activity 목록에도 보인다', async () => {
      const createRes = await request(app)
        .post('/messages/schedule')
        .set('Authorization', `Bearer ${author.token}`)
        .send({ content: `<@${mentioned.id}|Smw-Mentioned> 예약`, channelId, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
      await makeDue(createRes.body.id);
      await processDueScheduledMessages();
      await settleBackgroundWork();

      const res = await request(app)
        .get('/activity?type=mentions')
        .set('Authorization', `Bearer ${mentioned.token}`);
      expect(res.status).toBe(200);
      expect(res.body.items.some((a: { type: string; actor: { id: number } }) => a.type === 'MENTION' && a.actor.id === author.id)).toBe(true);
    });

    it('멘션이 없는 예약은 활동을 만들지 않는다', async () => {
      const createRes = await request(app)
        .post('/messages/schedule')
        .set('Authorization', `Bearer ${author.token}`)
        .send({ content: '멘션 없는 예약', channelId, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
      await makeDue(createRes.body.id);
      await processDueScheduledMessages();
      await settleBackgroundWork();

      expect(await mentionActivities(mentioned.id)).toHaveLength(0);
    });
  });

  describe('웹훅 메시지', () => {
    let token: string;
    let webhookId: number;

    beforeEach(async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${author.token}`)
        .send({ name: 'Smw Hook', channelId });
      token = res.body.token;
      webhookId = res.body.id;
    });

    it('@멘션이 든 웹훅 메시지는 멘션 활동을 만들고, 멘션이 없으면 만들지 않는다', async () => {
      // Create
      const sendRes = await request(app)
        .post(`/webhooks/${token}`)
        .send({ content: `배포 완료 <@${mentioned.id}|Smw-Mentioned>` });
      expect(sendRes.status).toBe(201);
      const messageId = sendRes.body.messageId as number;
      await settleBackgroundWork();

      const activities = await mentionActivities(mentioned.id, messageId);
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({ type: 'MENTION', actorId: author.id, channelId });

      // 멘션이 없는 웹훅 메시지는 활동을 늘리지 않는다
      const plain = await request(app).post(`/webhooks/${token}`).send({ content: '멘션 없음' });
      expect(plain.status).toBe(201);
      await settleBackgroundWork();
      expect(await mentionActivities(mentioned.id)).toHaveLength(1);

      // Read: 메시지가 채널에 남아 있다
      expect(await prisma.message.findUnique({ where: { id: messageId } })).not.toBeNull();
    });

    it('웹훅을 지우면 토큰으로 더 이상 보낼 수 없고, 그 뒤로 활동도 생기지 않는다', async () => {
      const delRes = await request(app)
        .delete(`/webhooks/${webhookId}`)
        .set('Authorization', `Bearer ${author.token}`);
      expect(delRes.status).toBe(200);

      const res = await request(app)
        .post(`/webhooks/${token}`)
        .send({ content: `<@${mentioned.id}|Smw-Mentioned> 지운 뒤` });
      expect(res.status).toBe(403);
      await settleBackgroundWork();
      expect(await mentionActivities(mentioned.id)).toHaveLength(0);
    });
  });
});
