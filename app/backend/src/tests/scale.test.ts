import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { settleBackgroundWork } from '../services/mentionService.js';

// 상태를 확인하지 않으면 실패한 POST가 뒤의 개수 검증에서야 원인 없이 드러난다. 실패하면 응답 전체를 메시지에 담는다.
function expectCreated(res: request.Response, i: number): void {
  if (res.status !== 201) {
    throw new Error(`message #${i} POST -> ${res.status} ${JSON.stringify(res.body)} ${res.text?.slice(0, 200)}`);
  }
}

describe('Scale & Performance Tests', () => {
  beforeEach(async () => {
    await prisma.reaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();
  });

  describe('Bulk User Creation', () => {
    it('should create 50 users successfully', async () => {
      const userPromises = [];

      for (let i = 1; i <= 50; i++) {
        userPromises.push(
          request(app)
            .post('/auth/register')
            .send({
              email: `user${i}@test.com`,
              password: TEST_PASSWORD,
              name: `User ${i}`,
            })
        );
      }

      const results = await Promise.all(userPromises);

      // All should succeed
      results.forEach((res) => {
        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty('token');
      });

      // Verify in database
      const userCount = await prisma.user.count();
      expect(userCount).toBe(50);
    });
  });

  describe('Many Users in Same Channel', () => {
    let channelId: number;
    let creatorToken: string;
    let userTokens: string[] = [];

    beforeEach(async () => {
      // Create channel creator
      const creatorRes = await request(app).post('/auth/register').send({
        email: 'creator@test.com',
        password: TEST_PASSWORD,
        name: 'Creator',
      });
      creatorToken = creatorRes.body.token;

      // Create channel
      const channelRes = await request(app)
        .post('/channels')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({ name: 'popular-channel' });
      channelId = channelRes.body.id;

      // Create 20 users and store their tokens
      for (let i = 1; i <= 20; i++) {
        const userRes = await request(app).post('/auth/register').send({
          email: `member${i}@test.com`,
          password: TEST_PASSWORD,
          name: `Member ${i}`,
        });
        userTokens.push(userRes.body.token);
      }
    });

    it('should allow 20 users to join the same channel', async () => {
      const joinPromises = userTokens.map((token) =>
        request(app)
          .post(`/channels/${channelId}/join`)
          .set('Authorization', `Bearer ${token}`)
      );

      const results = await Promise.all(joinPromises);

      results.forEach((res) => {
        expect(res.status).toBe(200);
      });

      // Verify members count (creator + 20 members)
      const res = await request(app)
        .get(`/channels/${channelId}/members`)
        .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(21);
    });
  });

  describe('Bulk Message Creation', () => {
    let channelId: number;
    let authToken: string;

    beforeEach(async () => {
      const userRes = await request(app).post('/auth/register').send({
        email: 'bulk-test@test.com',
        password: TEST_PASSWORD,
        name: 'Bulk Tester',
      });
      authToken = userRes.body.token;

      const channelRes = await request(app)
        .post('/channels')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'bulk-channel' });
      channelId = channelRes.body.id;
    });

    it('should create 100 messages successfully', async () => {
      const messagePromises = [];

      for (let i = 1; i <= 100; i++) {
        messagePromises.push(
          request(app)
            .post(`/channels/${channelId}/messages`)
            .set('Authorization', `Bearer ${authToken}`)
            .send({ content: `Message number ${i}` })
        );
      }

      const results = await Promise.all(messagePromises);

      results.forEach((res) => {
        expect(res.status).toBe(201);
      });

      // Verify in database
      const messageCount = await prisma.message.count({
        where: { channelId },
      });
      expect(messageCount).toBe(100);
    });

    it('should paginate through many messages correctly', async () => {
      // Create 50 messages
      for (let i = 1; i <= 50; i++) {
        const res = await request(app)
          .post(`/channels/${channelId}/messages`)
          .set('Authorization', `Bearer ${authToken}`)
          .send({ content: `Message ${i}` });
        expectCreated(res, i);
      }

      // Get first page
      const page1 = await request(app)
        .get(`/channels/${channelId}/messages?limit=20`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(page1.status).toBe(200);
      expect(page1.body.messages).toHaveLength(20);
      expect(page1.body.hasMore).toBe(true);

      // Get second page
      const page2 = await request(app)
        .get(`/channels/${channelId}/messages?limit=20&cursor=${page1.body.nextCursor}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(page2.status).toBe(200);
      expect(page2.body.messages).toHaveLength(20);
      expect(page2.body.hasMore).toBe(true);

      // Get third page
      const page3 = await request(app)
        .get(`/channels/${channelId}/messages?limit=20&cursor=${page2.body.nextCursor}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(page3.status).toBe(200);
      expect(page3.body.messages).toHaveLength(10);
      expect(page3.body.hasMore).toBe(false);

      // Ensure no duplicate messages across pages
      const allMessageIds = [
        ...page1.body.messages.map((m: any) => m.id),
        ...page2.body.messages.map((m: any) => m.id),
        ...page3.body.messages.map((m: any) => m.id),
      ];
      const uniqueIds = new Set(allMessageIds);
      expect(uniqueIds.size).toBe(50);
    });
  });

  describe('Bulk Message CRUD', () => {
    it('should create 10, read, update and delete one, and see each change', async () => {
      const userRes = await request(app).post('/auth/register').send({
        email: 'crud-test@test.com',
        password: TEST_PASSWORD,
        name: 'Crud Tester',
      });
      const token = userRes.body.token;
      const channelRes = await request(app)
        .post('/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'crud-channel' });
      const chId = channelRes.body.id;

      const ids: number[] = [];
      for (let i = 1; i <= 10; i++) {
        const res = await request(app)
          .post(`/channels/${chId}/messages`)
          .set('Authorization', `Bearer ${token}`)
          .send({ content: `Crud ${i}` });
        expectCreated(res, i);
        ids.push(res.body.id);
      }
      expect(new Set(ids).size).toBe(10);

      const list = await request(app)
        .get(`/channels/${chId}/messages?limit=10`)
        .set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.body.messages).toHaveLength(10);

      const edit = await request(app)
        .patch(`/messages/${ids[0]}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Crud edited' });
      expect(edit.status).toBe(200);
      expect(edit.body.content).toBe('Crud edited');

      const del = await request(app)
        .delete(`/messages/${ids[1]}`)
        .set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(200);

      const after = await request(app)
        .get(`/channels/${chId}/messages?limit=10`)
        .set('Authorization', `Bearer ${token}`);
      expect(after.body.messages).toHaveLength(9);
      expect(after.body.messages.some((m: any) => m.id === ids[1])).toBe(false);
      const edited = after.body.messages.find((m: any) => m.id === ids[0]);
      expect(edited).toBeDefined();
      expect(edited.content).toBe('Crud edited');
    });
  });

  describe('API Response Time', () => {
    let channelId: number;
    let authToken: string;

    beforeEach(async () => {
      const userRes = await request(app).post('/auth/register').send({
        email: 'perf-test@test.com',
        password: TEST_PASSWORD,
        name: 'Perf Tester',
      });
      authToken = userRes.body.token;

      const channelRes = await request(app)
        .post('/channels')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'perf-channel' });
      channelId = channelRes.body.id;

      // Create some messages
      for (let i = 1; i <= 50; i++) {
        const res = await request(app)
          .post(`/channels/${channelId}/messages`)
          .set('Authorization', `Bearer ${authToken}`)
          .send({ content: `Message ${i}` });
        expectCreated(res, i);
      }
      // 메시지마다 도는 활동 후처리가 끝나야 아래 응답 시간 측정이 DB 풀 경쟁에 흔들리지 않는다.
      await settleBackgroundWork();
    });

    it('should fetch messages in reasonable time', async () => {
      const startTime = Date.now();

      const res = await request(app)
        .get(`/channels/${channelId}/messages?limit=10`)
        .set('Authorization', `Bearer ${authToken}`);

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(res.status).toBe(200);
      // Response should be under 500ms (generous limit for test environment)
      expect(duration).toBeLessThan(500);
    });

    it('should search messages in reasonable time', async () => {
      const startTime = Date.now();

      const res = await request(app)
        .get('/search?q=Message')
        .set('Authorization', `Bearer ${authToken}`);

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(res.status).toBe(200);
      expect(duration).toBeLessThan(500);
    });
  });
});
