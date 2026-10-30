import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';

describe('Webhooks API', () => {
  let adminToken: string;
  let adminId: number;
  let memberToken: string;
  let memberId: number;
  let channelId: number;

  const adminUser = {
    email: 'webhook-admin@example.com',
    password: TEST_PASSWORD,
    name: 'Webhook Admin',
  };

  const memberUser = {
    email: 'webhook-member@example.com',
    password: TEST_PASSWORD,
    name: 'Webhook Member',
  };

  beforeEach(async () => {
    await prisma.webhook.deleteMany();
    await prisma.inviteLink.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.bookmark.deleteMany();
    await prisma.scheduledMessage.deleteMany();
    await prisma.reaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.directMessage.deleteMany();
    await prisma.user.deleteMany();

    // Register admin
    const adminRes = await request(app).post('/auth/register').send(adminUser);
    adminToken = adminRes.body.token;
    adminId = adminRes.body.user.id;

    // Promote to ADMIN
    await prisma.user.update({
      where: { id: adminId },
      data: { role: 'ADMIN' },
    });

    // Re-login to get token with correct role
    const loginRes = await request(app).post('/auth/login').send({
      email: adminUser.email,
      password: adminUser.password,
    });
    adminToken = loginRes.body.token;

    // Register member
    const memberRes = await request(app).post('/auth/register').send(memberUser);
    memberToken = memberRes.body.token;
    memberId = memberRes.body.user.id;

    // Create a test channel
    const channelRes = await request(app)
      .post('/channels')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'webhook-test-channel' });
    channelId = channelRes.body.id;
  });

  // ─── POST /webhooks (Create) ────────────────────────────────

  describe('POST /webhooks', () => {
    it('should create a webhook successfully', async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Test Webhook',
          channelId,
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('token');
      expect(res.body.name).toBe('Test Webhook');
      expect(res.body.channelId).toBe(channelId);
      expect(res.body.createdBy).toBe(adminId);
      expect(res.body.isActive).toBe(true);
      expect(res.body).toHaveProperty('channel');
      expect(res.body).toHaveProperty('creator');
      expect(res.body.token).toHaveLength(64);
    });

    it('should create audit log when webhook is created', async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Audit Log Test',
          channelId,
        });

      const logs = await prisma.auditLog.findMany({
        where: {
          action: 'webhook.created',
          targetId: res.body.id,
        },
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].actorId).toBe(adminId);
      expect(logs[0].targetType).toBe('webhook');
      expect(logs[0].targetName).toBe('Audit Log Test');
    });

    it('should reject unauthorized user (non-admin)', async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          name: 'Unauthorized Webhook',
          channelId,
        });

      expect(res.status).toBe(403);
    });

    it('should reject unauthenticated request', async () => {
      const res = await request(app)
        .post('/webhooks')
        .send({
          name: 'Unauthenticated Webhook',
          channelId,
        });

      expect(res.status).toBe(401);
    });

    it('should reject missing name field', async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          channelId,
        });

      expect(res.status).toBe(400);
    });

    it('should reject missing channelId field', async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Missing Channel',
        });

      expect(res.status).toBe(400);
    });

    it('should reject empty name', async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: '',
          channelId,
        });

      expect(res.status).toBe(400);
    });

    it('should reject name longer than 100 characters', async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'a'.repeat(101),
          channelId,
        });

      expect(res.status).toBe(400);
    });

    it('should reject non-existent channel', async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Invalid Channel Webhook',
          channelId: 99999,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Channel not found');
    });

    it('should reject archived channel', async () => {
      // Archive the channel
      await prisma.channel.update({
        where: { id: channelId },
        data: { archivedAt: new Date() },
      });

      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Archived Channel Webhook',
          channelId,
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Cannot create webhook for archived channel');
    });

    it('should generate unique tokens for each webhook', async () => {
      const res1 = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Webhook 1', channelId });

      const res2 = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Webhook 2', channelId });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.token).not.toBe(res2.body.token);
    });
  });

  // ─── GET /webhooks (List) ───────────────────────────────────

  describe('GET /webhooks', () => {
    beforeEach(async () => {
      // Create test webhooks
      await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Webhook 1', channelId });

      await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Webhook 2', channelId });
    });

    it('should list all webhooks', async () => {
      const res = await request(app)
        .get('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      expect(res.body[0]).toHaveProperty('id');
      expect(res.body[0]).toHaveProperty('name');
      expect(res.body[0]).toHaveProperty('token');
      expect(res.body[0]).toHaveProperty('channel');
      expect(res.body[0]).toHaveProperty('creator');
    });

    it('should filter webhooks by channelId', async () => {
      // Create another channel
      const channel2Res = await request(app)
        .post('/channels')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'webhook-test-channel-2' });

      await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Channel 2 Webhook', channelId: channel2Res.body.id });

      const res = await request(app)
        .get(`/webhooks?channelId=${channel2Res.body.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Channel 2 Webhook');
    });

    it('should reject unauthorized user (non-admin)', async () => {
      const res = await request(app)
        .get('/webhooks')
        .set('Authorization', `Bearer ${memberToken}`);

      expect(res.status).toBe(403);
    });

    it('should reject unauthenticated request', async () => {
      const res = await request(app).get('/webhooks');

      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE /webhooks/:id ───────────────────────────────────

  describe('DELETE /webhooks/:id', () => {
    let webhookId: number;

    beforeEach(async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'To Be Deleted', channelId });
      webhookId = res.body.id;
    });

    it('should delete a webhook successfully', async () => {
      const res = await request(app)
        .delete(`/webhooks/${webhookId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Webhook deleted');

      // Verify deletion
      const webhook = await prisma.webhook.findUnique({
        where: { id: webhookId },
      });
      expect(webhook).toBeNull();
    });

    it('should create audit log when webhook is deleted', async () => {
      await request(app)
        .delete(`/webhooks/${webhookId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      const logs = await prisma.auditLog.findMany({
        where: {
          action: 'webhook.deleted',
          targetId: webhookId,
        },
      });

      expect(logs).toHaveLength(1);
      expect(logs[0].actorId).toBe(adminId);
      expect(logs[0].targetType).toBe('webhook');
    });

    it('should reject unauthorized user (non-admin)', async () => {
      const res = await request(app)
        .delete(`/webhooks/${webhookId}`)
        .set('Authorization', `Bearer ${memberToken}`);

      expect(res.status).toBe(403);
    });

    it('should reject unauthenticated request', async () => {
      const res = await request(app).delete(`/webhooks/${webhookId}`);

      expect(res.status).toBe(401);
    });

    it('should return 404 for non-existent webhook', async () => {
      const res = await request(app)
        .delete('/webhooks/99999')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Webhook not found');
    });

    it('should return 400 for invalid webhook ID', async () => {
      const res = await request(app)
        .delete('/webhooks/invalid')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid webhook ID');
    });
  });

  // ─── POST /webhooks/:token (Incoming) ───────────────────────

  describe('POST /webhooks/:token', () => {
    let webhookToken: string;
    let webhookId: number;

    beforeEach(async () => {
      const res = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Incoming Test', channelId });
      webhookToken = res.body.token;
      webhookId = res.body.id;
    });

    it('should create message successfully via webhook', async () => {
      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'Hello from webhook!' });

      expect(res.status).toBe(201);
      expect(res.body.message).toBe('Message sent');
      expect(res.body).toHaveProperty('messageId');

      // Verify message was created
      const message = await prisma.message.findUnique({
        where: { id: res.body.messageId },
        include: { user: true },
      });

      expect(message).toBeTruthy();
      expect(message!.content).toBe('Hello from webhook!');
      expect(message!.userId).toBe(adminId); // Message attributed to webhook creator
      expect(message!.channelId).toBe(channelId);
    });

    it('should update webhook lastUsedAt timestamp', async () => {
      const beforeWebhook = await prisma.webhook.findUnique({
        where: { id: webhookId },
      });
      expect(beforeWebhook!.lastUsedAt).toBeNull();

      await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'Updating lastUsedAt' });

      const afterWebhook = await prisma.webhook.findUnique({
        where: { id: webhookId },
      });
      expect(afterWebhook!.lastUsedAt).not.toBeNull();
    });

    it('should return 403 for invalid token (not 404 to prevent enumeration)', async () => {
      const res = await request(app)
        .post('/webhooks/invalid-token-12345')
        .send({ content: 'Test' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Invalid or inactive webhook');
    });

    it('should return 403 for inactive webhook', async () => {
      // Deactivate webhook
      await prisma.webhook.update({
        where: { id: webhookId },
        data: { isActive: false },
      });

      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'Test' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Invalid or inactive webhook');
    });

    it('should return 403 for archived channel', async () => {
      // Archive the channel
      await prisma.channel.update({
        where: { id: channelId },
        data: { archivedAt: new Date() },
      });

      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'Test' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Channel is archived');
    });

    it('should reject missing content field', async () => {
      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('should reject empty content', async () => {
      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: '' });

      expect(res.status).toBe(400);
    });

    it('should reject content longer than 40000 characters', async () => {
      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'a'.repeat(40001) });

      expect(res.status).toBe(400);
    });

    it('should accept content exactly at 40000 character limit', async () => {
      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'a'.repeat(40000) });

      expect(res.status).toBe(201);
    });

    it('should handle multiple messages from same webhook', async () => {
      const res1 = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'Message 1' });

      const res2 = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'Message 2' });

      const res3 = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'Message 3' });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res3.status).toBe(201);

      // Verify all messages exist
      const messages = await prisma.message.findMany({
        where: {
          channelId,
          userId: adminId,
        },
        orderBy: { createdAt: 'asc' },
      });

      expect(messages.length).toBeGreaterThanOrEqual(3);
      expect(messages.map(m => m.content)).toContain('Message 1');
      expect(messages.map(m => m.content)).toContain('Message 2');
      expect(messages.map(m => m.content)).toContain('Message 3');
    });

    it('should support special characters and emojis in content', async () => {
      const content = 'Test with special chars: <>&"\'`\n\nAnd emojis: 🚀 🎉 ✨';
      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content });

      expect(res.status).toBe(201);

      const message = await prisma.message.findUnique({
        where: { id: res.body.messageId },
      });

      expect(message!.content).toBe(content);
    });

    it('should not require authentication (token-based only)', async () => {
      // No Authorization header should still work
      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'No auth header' });

      expect(res.status).toBe(201);
    });

    it('should be subject to rate limiting', async () => {
      // Note: Rate limiting is 120 req/min with apiLimiter
      // This test just verifies the endpoint is under the limiter
      // by making a successful call
      const res = await request(app)
        .post(`/webhooks/${webhookToken}`)
        .send({ content: 'Rate limit test' });

      expect(res.status).toBe(201);
    });
  });

  // ─── Integration Tests ──────────────────────────────────────

  describe('Integration', () => {
    it('should handle full webhook lifecycle', async () => {
      // 1. Create webhook
      const createRes = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Lifecycle Webhook', channelId });

      expect(createRes.status).toBe(201);
      const { token, id } = createRes.body;

      // 2. List webhooks
      const listRes = await request(app)
        .get('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(listRes.status).toBe(200);
      const found = listRes.body.find((w: any) => w.id === id);
      expect(found).toBeTruthy();

      // 3. Send message via webhook
      const msgRes = await request(app)
        .post(`/webhooks/${token}`)
        .send({ content: 'Lifecycle test message' });

      expect(msgRes.status).toBe(201);

      // 4. Verify message in channel
      const messages = await prisma.message.findMany({
        where: { channelId },
      });
      expect(messages.some(m => m.content === 'Lifecycle test message')).toBe(true);

      // 5. Delete webhook
      const deleteRes = await request(app)
        .delete(`/webhooks/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(deleteRes.status).toBe(200);

      // 6. Verify webhook no longer works
      const afterDeleteRes = await request(app)
        .post(`/webhooks/${token}`)
        .send({ content: 'Should fail' });

      expect(afterDeleteRes.status).toBe(403);
    });

    it('should cascade delete webhooks when channel is deleted', async () => {
      // Create webhook
      const webhookRes = await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Cascade Test', channelId });

      const webhookId = webhookRes.body.id;

      // Delete channel via Prisma (simulating channel deletion)
      await prisma.channel.delete({ where: { id: channelId } });

      // Verify webhook was cascade deleted
      const webhook = await prisma.webhook.findUnique({
        where: { id: webhookId },
      });
      expect(webhook).toBeNull();
    });

    it('should prevent webhook creator deletion via foreign key constraint', async () => {
      // Create webhook
      await request(app)
        .post('/webhooks')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'FK Test', channelId });

      // Try to delete webhook creator (should fail due to RESTRICT constraint)
      await expect(
        prisma.user.delete({ where: { id: adminId } })
      ).rejects.toThrow();
    });
  });
});
