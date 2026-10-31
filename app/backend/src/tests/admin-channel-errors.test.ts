import { jest } from '@jest/globals';
import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';

// 관리자 채널 삭제·보관·보관 해제의 실패 경로. DB 오류를 흉내 내 응답 코드와 문구를 확인한다.
// 서버 오류 응답에는 내부 메시지(예: DB 연결 문구)가 나가면 안 된다.

describe('관리자 채널 삭제·보관 실패 경로', () => {
  let adminToken: string;
  let channelId: number;

  beforeEach(async () => {
    await prisma.activity.deleteMany();
    await prisma.webhook.deleteMany();
    await prisma.inviteLink.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'admin-chan-err@example.com', password: TEST_PASSWORD, name: 'Admin Chan Err' });
    await prisma.user.update({ where: { id: reg.body.user.id }, data: { role: 'ADMIN' } });
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'admin-chan-err@example.com', password: TEST_PASSWORD });
    adminToken = login.body.token;

    const channelRes = await request(app)
      .post('/channels')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'admin-err-channel' });
    channelId = channelRes.body.id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('DELETE /admin/invites/:id', () => {
    it('초대 2개를 연속 삭제하다가 한쪽이 실패하면 실패한 쪽만 남고, 재시도하면 지워진다', async () => {
      const make = () => request(app)
        .post('/admin/invites')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'MEMBER' });
      const inviteA = (await make()).body.id as number;
      const inviteB = (await make()).body.id as number;

      const delA = await request(app).delete(`/admin/invites/${inviteA}`).set('Authorization', `Bearer ${adminToken}`);
      expect(delA.status).toBe(200);

      jest.spyOn(prisma.inviteLink, 'delete').mockRejectedValueOnce(new Error('lock timeout: internal'));
      const delB = await request(app).delete(`/admin/invites/${inviteB}`).set('Authorization', `Bearer ${adminToken}`);
      expect(delB.status).toBe(500);
      expect(delB.body).toEqual({ error: 'Failed to delete invite', code: 'INTERNAL_ERROR' });
      expect(JSON.stringify(delB.body)).not.toContain('lock timeout');

      // 실패한 초대만 남는다
      const remaining = await prisma.inviteLink.findMany({ select: { id: true } });
      expect(remaining.map((r) => r.id)).toEqual([inviteB]);

      jest.restoreAllMocks();
      const retry = await request(app).delete(`/admin/invites/${inviteB}`).set('Authorization', `Bearer ${adminToken}`);
      expect(retry.status).toBe(200);
      expect(await prisma.inviteLink.count()).toBe(0);
    });
  });

  describe('DELETE /admin/channels/:id', () => {
    it('DB 오류면 500과 일반 문구를 주고, 채널은 그대로 남는다. 다시 시도하면 삭제된다', async () => {
      jest.spyOn(prisma.channel, 'delete').mockRejectedValueOnce(new Error('connection terminated: secret-host'));

      const failRes = await request(app)
        .delete(`/admin/channels/${channelId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(failRes.status).toBe(500);
      expect(failRes.body).toEqual({ error: 'Failed to delete channel', code: 'INTERNAL_ERROR' });
      expect(JSON.stringify(failRes.body)).not.toContain('secret-host');
      expect(await prisma.channel.findUnique({ where: { id: channelId } })).not.toBeNull();

      jest.restoreAllMocks();
      const okRes = await request(app)
        .delete(`/admin/channels/${channelId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(okRes.status).toBe(200);
      expect(await prisma.channel.findUnique({ where: { id: channelId } })).toBeNull();

      // 삭제 후 다시 지우면 404
      const again = await request(app)
        .delete(`/admin/channels/${channelId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(again.status).toBe(404);
    });

    it('없는 채널은 404, 잘못된 id는 400', async () => {
      const missing = await request(app).delete('/admin/channels/999999').set('Authorization', `Bearer ${adminToken}`);
      expect(missing.status).toBe(404);
      const invalid = await request(app).delete('/admin/channels/abc').set('Authorization', `Bearer ${adminToken}`);
      expect(invalid.status).toBe(400);
    });
  });

  describe('POST /admin/channels/:id/archive', () => {
    it('DB 오류면 500과 일반 문구를 주고, 채널은 보관되지 않는다. 다시 시도하면 보관된다', async () => {
      jest.spyOn(prisma.channel, 'update').mockRejectedValueOnce(new Error('deadlock detected: internal'));

      const failRes = await request(app)
        .post(`/admin/channels/${channelId}/archive`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(failRes.status).toBe(500);
      expect(failRes.body).toEqual({ error: 'Failed to archive channel', code: 'INTERNAL_ERROR' });
      expect(JSON.stringify(failRes.body)).not.toContain('deadlock');
      expect((await prisma.channel.findUnique({ where: { id: channelId } }))?.archivedAt).toBeNull();

      jest.restoreAllMocks();
      const okRes = await request(app)
        .post(`/admin/channels/${channelId}/archive`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(okRes.status).toBe(200);
      expect(okRes.body.archivedAt).not.toBeNull();

      // 이미 보관된 채널을 다시 보관하면 400
      const twice = await request(app)
        .post(`/admin/channels/${channelId}/archive`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(twice.status).toBe(400);
    });
  });

  describe('POST /admin/channels/:id/unarchive', () => {
    it('DB 오류면 500과 일반 문구를 주고, 보관 상태가 유지된다. 다시 시도하면 해제된다', async () => {
      await prisma.channel.update({ where: { id: channelId }, data: { archivedAt: new Date() } });
      jest.spyOn(prisma.channel, 'update').mockRejectedValueOnce(new Error('timeout: internal'));

      const failRes = await request(app)
        .post(`/admin/channels/${channelId}/unarchive`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(failRes.status).toBe(500);
      expect(failRes.body).toEqual({ error: 'Failed to unarchive channel', code: 'INTERNAL_ERROR' });
      expect((await prisma.channel.findUnique({ where: { id: channelId } }))?.archivedAt).not.toBeNull();

      jest.restoreAllMocks();
      const okRes = await request(app)
        .post(`/admin/channels/${channelId}/unarchive`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(okRes.status).toBe(200);
      expect(okRes.body.archivedAt).toBeNull();
    });
  });
});
