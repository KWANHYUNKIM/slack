import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import app from '../app.js';
import prisma from '../db.js';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config.js';

describe('File Uploads', () => {
  let authToken: string;
  let channelId: number;
  let messageId: number;

  const testUser = {
    email: 'file-test@example.com',
    password: TEST_PASSWORD,
    name: 'File Test User',
  };

  // Create a test file
  const testFilePath = path.join(process.cwd(), 'test-file.txt');

  beforeAll(() => {
    fs.writeFileSync(testFilePath, 'This is a test file content');
  });

  afterAll(() => {
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    // Clean up uploads directory
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      files.forEach((file) => {
        const filePath = path.join(uploadsDir, file);
        if (fs.statSync(filePath).isFile()) {
          fs.unlinkSync(filePath);
        }
      });
    }
  });

  beforeEach(async () => {
    await prisma.dMReaction.deleteMany();
    await prisma.reaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.directMessage.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    const userRes = await request(app).post('/auth/register').send(testUser);
    authToken = userRes.body.token;

    const channelRes = await request(app)
      .post('/channels')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ name: 'test-channel' });
    channelId = channelRes.body.id;

    const messageRes = await request(app)
      .post(`/channels/${channelId}/messages`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ content: 'Test message for files' });
    messageId = messageRes.body.id;
  });

  describe('POST /files', () => {
    it('should upload a file', async () => {
      const res = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);

      expect(res.status).toBe(201);
      expect(res.body.originalName).toBe('test-file.txt');
      expect(res.body.mimetype).toBe('text/plain');
      expect(res.body).toHaveProperty('url');
      expect(res.body).toHaveProperty('size');
      expect(res.body).toHaveProperty('filename');
    });

    it('should upload file with message association', async () => {
      const res = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .field('messageId', messageId.toString())
        .attach('file', testFilePath);

      expect(res.status).toBe(201);
      expect(res.body.messageId).toBe(messageId);
    });

    it('should NOT upload file to a message in an archived channel', async () => {
      // Archive the channel
      await prisma.channel.update({
        where: { id: channelId },
        data: { archivedAt: new Date() },
      });

      const res = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .field('messageId', messageId.toString())
        .attach('file', testFilePath);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('This channel has been archived');

      // Unarchive for cleanup
      await prisma.channel.update({
        where: { id: channelId },
        data: { archivedAt: null },
      });
    });

    it('should NOT upload file to a deleted message', async () => {
      // Delete the message
      await request(app)
        .delete(`/messages/${messageId}`)
        .set('Authorization', `Bearer ${authToken}`);

      // Try to upload a file to the deleted message
      const res = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .field('messageId', messageId.toString())
        .attach('file', testFilePath);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Message not found');
    });

    it('should require authentication', async () => {
      const res = await request(app)
        .post('/files')
        .attach('file', testFilePath);

      expect(res.status).toBe(401);
    });

    it('should return error when no file is provided', async () => {
      const res = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No file uploaded');
    });
  });

  describe('GET /files/:id', () => {
    let fileId: number;

    beforeEach(async () => {
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);
      fileId = uploadRes.body.id;
    });

    it('should get file info', async () => {
      const res = await request(app)
        .get(`/files/${fileId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(fileId);
      expect(res.body.originalName).toBe('test-file.txt');
    });

    it('should return 404 for non-existent file', async () => {
      const res = await request(app)
        .get('/files/99999')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /files/:id', () => {
    let fileId: number;

    beforeEach(async () => {
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);
      fileId = uploadRes.body.id;
    });

    it('should delete own file', async () => {
      const res = await request(app)
        .delete(`/files/${fileId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('File deleted');

      // Verify file is deleted
      const getRes = await request(app)
        .get(`/files/${fileId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(getRes.status).toBe(404);
    });

    it('should NOT delete a file attached to a DM', async () => {
      // Create a second user for the DM
      const user2Res = await request(app).post('/auth/register').send({
        email: 'dm-del@example.com',
        password: 'password123',
        name: 'DM Delete Test',
      });
      const user2Id = user2Res.body.user.id;

      // Send a DM with the file attached
      const dmRes = await request(app)
        .post('/dms')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ toUserId: user2Id, content: 'File for you', fileIds: [fileId] });
      expect(dmRes.status).toBe(201);

      // Try to delete the file — should be blocked
      const res = await request(app)
        .delete(`/files/${fileId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/attached/i);

      // Verify file still exists
      const getRes = await request(app)
        .get(`/files/${fileId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(getRes.status).toBe(200);
    });

    it('should not delete another user file (returns 404 to hide existence)', async () => {
      const user2Res = await request(app).post('/auth/register').send({
        email: 'user2@example.com',
        password: TEST_PASSWORD,
        name: 'User 2',
      });

      const res = await request(app)
        .delete(`/files/${fileId}`)
        .set('Authorization', `Bearer ${user2Res.body.token}`);

      // Returns 404 (not 403) so attackers can't distinguish
      // "exists but unauthorized" from "doesn't exist"
      expect(res.status).toBe(404);
    });
  });

  describe('GET /files', () => {
    beforeEach(async () => {
      await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);
    });

    it('should list user files', async () => {
      const res = await request(app)
        .get('/files')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('File Upload - Edge Cases', () => {
    it('should reject files over 10MB', async () => {
      // Create a large file path
      const largeFilePath = path.join(process.cwd(), 'large-test-file.bin');

      // Create 11MB buffer
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024, 'x');
      fs.writeFileSync(largeFilePath, largeBuffer);

      try {
        const res = await request(app)
          .post('/files')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('file', largeFilePath);

        // Multer returns 500 for file too large errors
        expect([400, 413, 500]).toContain(res.status);
      } finally {
        // Clean up
        if (fs.existsSync(largeFilePath)) {
          fs.unlinkSync(largeFilePath);
        }
      }
    });

    it('should reject invalid file types', async () => {
      const exeFilePath = path.join(process.cwd(), 'test-malware.exe');
      fs.writeFileSync(exeFilePath, 'fake executable content');

      try {
        const res = await request(app)
          .post('/files')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('file', exeFilePath);

        // Should be rejected
        expect([400, 500]).toContain(res.status);
      } finally {
        if (fs.existsSync(exeFilePath)) {
          fs.unlinkSync(exeFilePath);
        }
      }
    });

    it('should accept valid image types', async () => {
      // Create a minimal valid PNG file (1x1 transparent pixel)
      const pngFilePath = path.join(process.cwd(), 'test-image.png');
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
      fs.writeFileSync(pngFilePath, pngBuffer);

      try {
        const res = await request(app)
          .post('/files')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('file', pngFilePath);

        expect(res.status).toBe(201);
        expect(res.body.mimetype).toBe('image/png');
      } finally {
        if (fs.existsSync(pngFilePath)) {
          fs.unlinkSync(pngFilePath);
        }
      }
    });

    it('should accept JSON files', async () => {
      const jsonFilePath = path.join(process.cwd(), 'test-data.json');
      fs.writeFileSync(jsonFilePath, JSON.stringify({ test: 'data' }));

      try {
        const res = await request(app)
          .post('/files')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('file', jsonFilePath);

        expect(res.status).toBe(201);
        expect(res.body.mimetype).toBe('application/json');
      } finally {
        if (fs.existsSync(jsonFilePath)) {
          fs.unlinkSync(jsonFilePath);
        }
      }
    });

    it('should return invalid file ID error', async () => {
      const res = await request(app)
        .get('/files/invalid')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid/i);
    });

    // 다운로드 토큰은 항상 파일 하나에 묶인다. fileId 없는 요청은 거부한다.
    it('should refuse to issue a download token without a file', async () => {
      for (const body of [{}, { fileId: 0 }, { fileIds: [] }, { fileId: 1, extra: true }]) {
        const res = await request(app)
          .post('/files/download-token')
          .set('Authorization', `Bearer ${authToken}`)
          .send(body);
        expect(res.status).toBe(400);
        expect(res.body).not.toHaveProperty('token');
      }
    });

    it('should issue file-scoped tokens in a batch and skip inaccessible files', async () => {
      const mine = await request(app).post('/files').set('Authorization', `Bearer ${authToken}`).attach('file', testFilePath);
      const other = await request(app).post('/auth/register').send({
        email: 'batch-other@example.com', password: TEST_PASSWORD, name: 'Batch Other',
      });
      const theirs = await request(app).post('/files').set('Authorization', `Bearer ${other.body.token}`).attach('file', testFilePath);

      const res = await request(app)
        .post('/files/download-token')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ fileIds: [mine.body.id, theirs.body.id, 999999] });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.tokens)).toEqual([String(mine.body.id)]);

      const decoded = jwt.decode(res.body.tokens[mine.body.id]) as any;
      expect(decoded.purpose).toBe('file-download');
      expect(decoded.fileId).toBe(mine.body.id);
      expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(300);

      const ok = await request(app).get(`/files/${mine.body.id}/download?token=${res.body.tokens[mine.body.id]}`);
      expect(ok.status).toBe(200);
      // 응답에서 Referer가 새지 않는다
      expect(ok.headers['referrer-policy']).toBe('no-referrer');
    });

    it('should reject legacy unscoped, expired, wrong-purpose and other-file tokens', async () => {
      const f1 = await request(app).post('/files').set('Authorization', `Bearer ${authToken}`).attach('file', testFilePath);
      const f2 = await request(app).post('/files').set('Authorization', `Bearer ${authToken}`).attach('file', testFilePath);
      const login = jwt.decode(authToken) as any;
      const claims = { userId: login.userId, tokenVersion: login.tokenVersion };
      const url = (id: number, tok: string) => `/files/${id}/download?token=${tok}`;

      // 범위 없는 구형 토큰
      const legacy = jwt.sign({ ...claims, purpose: 'file-download' }, JWT_SECRET, { expiresIn: '5m' });
      expect((await request(app).get(url(f1.body.id, legacy))).status).toBe(403);

      // 만료된 토큰
      const expired = jwt.sign({ ...claims, purpose: 'file-download', fileId: f1.body.id }, JWT_SECRET, { expiresIn: -10 });
      expect((await request(app).get(url(f1.body.id, expired))).status).toBe(401);

      // purpose가 다른 JWT (로그인 토큰)
      expect((await request(app).get(url(f1.body.id, authToken))).status).toBe(403);

      // 다른 파일의 토큰
      const forF2 = jwt.sign({ ...claims, purpose: 'file-download', fileId: f2.body.id }, JWT_SECRET, { expiresIn: '5m' });
      expect((await request(app).get(url(f1.body.id, forF2))).status).toBe(403);

      // 올바른 토큰은 통과
      const good = jwt.sign({ ...claims, purpose: 'file-download', fileId: f1.body.id }, JWT_SECRET, { expiresIn: '5m' });
      expect((await request(app).get(url(f1.body.id, good))).status).toBe(200);

      // 서명이 틀린 토큰, tokenVersion이 다른 토큰
      const forged = jwt.sign({ ...claims, purpose: 'file-download', fileId: f1.body.id }, 'wrong-secret', { expiresIn: '5m' });
      expect((await request(app).get(url(f1.body.id, forged))).status).toBe(401);
      const staleVersion = jwt.sign({ ...claims, tokenVersion: claims.tokenVersion + 1, purpose: 'file-download', fileId: f1.body.id }, JWT_SECRET, { expiresIn: '5m' });
      expect((await request(app).get(url(f1.body.id, staleVersion))).status).toBe(401);

      // 파일 토큰은 일반 인증으로 쓸 수 없다
      expect((await request(app).get('/channels').set('Authorization', `Bearer ${good}`)).status).toBe(401);
    });

    // 생성·조회·수정·삭제·퇴장 흐름: 접근은 항상 "지금" 권한으로 다시 확인한다.
    it('should follow message edit/delete and channel leave for scoped tokens', async () => {
      const owner = await request(app).post('/auth/register').send({ email: 'cu-owner@example.com', password: TEST_PASSWORD, name: 'CU Owner' });
      const member = await request(app).post('/auth/register').send({ email: 'cu-member@example.com', password: TEST_PASSWORD, name: 'CU Member' });
      const ownerAuth = { Authorization: `Bearer ${owner.body.token}` };
      const memberAuth = { Authorization: `Bearer ${member.body.token}` };

      const ch = await request(app).post('/channels').set(ownerAuth).send({ name: 'scoped-token-ch' });
      expect((await request(app).post(`/channels/${ch.body.id}/join`).set(memberAuth)).status).toBe(200);
      const msg = await request(app).post(`/channels/${ch.body.id}/messages`).set(ownerAuth).send({ content: 'with file' });
      const up = await request(app).post('/files').set(ownerAuth).field('messageId', String(msg.body.id)).attach('file', testFilePath);
      expect(up.status).toBe(201);
      const fileId = up.body.id;

      // Read: 멤버는 토큰을 받고 미리보기·다운로드 모두 된다
      const t1 = await request(app).post('/files/download-token').set(memberAuth).send({ fileId });
      expect(t1.status).toBe(200);
      expect((await request(app).get(`/files/${fileId}/download?token=${t1.body.token}`)).status).toBe(200);
      const dl = await request(app).get(`/files/${fileId}/download?dl=1&token=${t1.body.token}`);
      expect(dl.headers['content-disposition']).toMatch(/^attachment/);

      // Update: 메시지를 고쳐도 파일 접근은 유지된다
      const edit = await request(app).patch(`/messages/${msg.body.id}`).set(ownerAuth).send({ content: 'edited' });
      expect(edit.status).toBe(200);
      expect((await request(app).get(`/files/${fileId}/download?token=${t1.body.token}`)).status).toBe(200);

      // 채널을 나가면 이미 받은 토큰도, 새 토큰 요청도 막힌다
      expect((await request(app).post(`/channels/${ch.body.id}/leave`).set(memberAuth)).status).toBe(200);
      expect((await request(app).get(`/files/${fileId}/download?token=${t1.body.token}`)).status).toBe(404);
      expect((await request(app).post('/files/download-token').set(memberAuth).send({ fileId })).status).toBe(404);

      // Delete: 메시지를 지우면 파일은 올린 사람에게만 남고 이전 멤버는 계속 막힌다
      const t2 = await request(app).post('/files/download-token').set(ownerAuth).send({ fileId });
      expect((await request(app).delete(`/messages/${msg.body.id}`).set(ownerAuth)).status).toBe(200);
      expect((await request(app).get(`/files/${fileId}/download?token=${t2.body.token}`)).status).toBe(200);
      expect((await request(app).get(`/files/${fileId}/download?token=${t1.body.token}`)).status).toBe(404);
    });

    it('should not let another user download a private file with their own file token', async () => {
      // A (authToken) owns a private channel with a message and an attached file
      const privChannel = await request(app)
        .post('/channels')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'private-files', isPrivate: true });
      const privMessage = await request(app)
        .post(`/channels/${privChannel.body.id}/messages`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ content: 'private file here' });
      const upload = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .field('messageId', privMessage.body.id.toString())
        .attach('file', testFilePath);
      expect(upload.status).toBe(201);
      const fileId = upload.body.id;

      // B is not a member of the channel
      const userB = await request(app).post('/auth/register').send({
        email: 'file-user-b@example.com',
        password: TEST_PASSWORD,
        name: 'File User B',
      });
      // B cannot even get a token for A's file
      const deniedToken = await request(app)
        .post('/files/download-token')
        .set('Authorization', `Bearer ${userB.body.token}`)
        .send({ fileId });
      expect(deniedToken.status).toBe(404);

      // B's token for B's own file must not open A's file
      const bFile = await request(app).post('/files').set('Authorization', `Bearer ${userB.body.token}`).attach('file', testFilePath);
      const tokenB = await request(app)
        .post('/files/download-token')
        .set('Authorization', `Bearer ${userB.body.token}`)
        .send({ fileId: bFile.body.id });
      const denied = await request(app).get(`/files/${fileId}/download?token=${tokenB.body.token}`);
      expect([403, 404]).toContain(denied.status);

      // A's own token works
      const tokenA = await request(app)
        .post('/files/download-token')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ fileId });
      const allowed = await request(app).get(`/files/${fileId}/download?token=${tokenA.body.token}`);
      expect(allowed.status).toBe(200);
    });

    it('should reject download token with invalid fileId', async () => {
      const res = await request(app)
        .post('/files/download-token')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ fileId: 'abc' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid request');
    });

    it('should issue a file-scoped download token', async () => {
      // Upload a file
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);
      const fileId = uploadRes.body.id;

      // Get a scoped download token
      const tokenRes = await request(app)
        .post('/files/download-token')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ fileId });

      expect(tokenRes.status).toBe(200);
      expect(tokenRes.body).toHaveProperty('token');

      // Token should work for the correct file
      const downloadRes = await request(app)
        .get(`/files/${fileId}/download?token=${tokenRes.body.token}`);
      expect(downloadRes.status).toBe(200);
    });

    it('should reject download token used for a different file', async () => {
      // Upload two files
      const upload1 = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);
      const file1Id = upload1.body.id;

      const upload2 = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);
      const file2Id = upload2.body.id;

      // Get token scoped to file 1
      const tokenRes = await request(app)
        .post('/files/download-token')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ fileId: file1Id });

      // Try to use it for file 2 — should be rejected
      const downloadRes = await request(app)
        .get(`/files/${file2Id}/download?token=${tokenRes.body.token}`);
      expect(downloadRes.status).toBe(403);
      expect(downloadRes.body.error).toBe('Token not valid for this file');
    });

    it('should refuse download token for file user cannot access', async () => {
      // Create another user with their own file
      const user2Res = await request(app).post('/auth/register').send({
        email: 'tokentarget@example.com',
        password: 'password123',
        name: 'Token Target',
      });

      const upload2 = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${user2Res.body.token}`)
        .attach('file', testFilePath);
      expect(upload2.status).toBe(201);
      const otherFileId = upload2.body.id;

      // User 1 tries to generate a download token for user 2's file
      const tokenRes = await request(app)
        .post('/files/download-token')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ fileId: otherFileId });

      // Should be refused — user 1 has no access to the file
      expect(tokenRes.status).toBe(404);
      expect(tokenRes.body.error).toBe('File not found');
      expect(tokenRes.body).not.toHaveProperty('token');
    });

    it('should refuse download token for non-existent file', async () => {
      const tokenRes = await request(app)
        .post('/files/download-token')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ fileId: 999999 });

      expect(tokenRes.status).toBe(404);
      expect(tokenRes.body.error).toBe('File not found');
    });

    it('should reject upload to non-member channel message', async () => {
      // Create user2 with their own channel
      const user2Res = await request(app).post('/auth/register').send({
        email: 'fileuser2@example.com',
        password: TEST_PASSWORD,
        name: 'File User 2',
      });

      const channel2Res = await request(app)
        .post('/channels')
        .set('Authorization', `Bearer ${user2Res.body.token}`)
        .send({ name: 'user2-private-channel' });

      const message2Res = await request(app)
        .post(`/channels/${channel2Res.body.id}/messages`)
        .set('Authorization', `Bearer ${user2Res.body.token}`)
        .send({ content: 'User 2 message' });

      // User 1 tries to upload to user 2's message
      const res = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .field('messageId', message2Res.body.id.toString())
        .attach('file', testFilePath);

      expect(res.status).toBe(403);
    });
  });

  describe('DM file access authorization', () => {
    let aliceToken: string;
    let bobToken: string;
    let eveToken: string;
    let aliceId: number;
    let bobId: number;

    beforeEach(async () => {
      await prisma.dMReaction.deleteMany();
      await prisma.reaction.deleteMany();
      await prisma.file.deleteMany();
      await prisma.directMessage.deleteMany();
      await prisma.message.deleteMany();
      await prisma.channelRead.deleteMany();
      await prisma.channelMember.deleteMany();
      await prisma.channel.deleteMany();
      await prisma.user.deleteMany();

      const aliceRes = await request(app).post('/auth/register').send({
        email: 'alice-dmfile@example.com',
        password: 'password123',
        name: 'Alice',
      });
      aliceToken = aliceRes.body.token;
      aliceId = aliceRes.body.user.id;

      const bobRes = await request(app).post('/auth/register').send({
        email: 'bob-dmfile@example.com',
        password: 'password123',
        name: 'Bob',
      });
      bobToken = bobRes.body.token;
      bobId = bobRes.body.user.id;

      const eveRes = await request(app).post('/auth/register').send({
        email: 'eve-dmfile@example.com',
        password: 'password123',
        name: 'Eve',
      });
      eveToken = eveRes.body.token;
    });

    it('should allow the DM recipient to access the file', async () => {
      // Alice uploads a file
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${aliceToken}`)
        .attach('file', testFilePath);
      expect(uploadRes.status).toBe(201);
      const fileId = uploadRes.body.id;

      // Alice sends a DM to Bob with the file
      const dmRes = await request(app)
        .post('/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ toUserId: bobId, content: 'Check this file', fileIds: [fileId] });
      expect(dmRes.status).toBe(201);

      // Bob (recipient) should be able to access the file metadata
      const fileRes = await request(app)
        .get(`/files/${fileId}`)
        .set('Authorization', `Bearer ${bobToken}`);
      expect(fileRes.status).toBe(200);
      expect(fileRes.body.id).toBe(fileId);
    });

    it('should allow the DM sender to access their own file', async () => {
      // Alice uploads and sends
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${aliceToken}`)
        .attach('file', testFilePath);
      const fileId = uploadRes.body.id;

      await request(app)
        .post('/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ toUserId: bobId, content: 'File for Bob', fileIds: [fileId] });

      // Alice (sender) should still access the file
      const fileRes = await request(app)
        .get(`/files/${fileId}`)
        .set('Authorization', `Bearer ${aliceToken}`);
      expect(fileRes.status).toBe(200);
    });

    it('should deny a non-participant access to DM-attached files', async () => {
      // Alice uploads and sends to Bob
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${aliceToken}`)
        .attach('file', testFilePath);
      const fileId = uploadRes.body.id;

      await request(app)
        .post('/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ toUserId: bobId, content: 'Private file', fileIds: [fileId] });

      // Eve (not a DM participant) gets 404 — same as non-existent
      // to prevent file-existence enumeration
      const fileRes = await request(app)
        .get(`/files/${fileId}`)
        .set('Authorization', `Bearer ${eveToken}`);
      expect(fileRes.status).toBe(404);
    });

    it('should deny access to files in deleted DMs', async () => {
      // Alice uploads and sends to Bob
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${aliceToken}`)
        .attach('file', testFilePath);
      const fileId = uploadRes.body.id;

      const dmRes = await request(app)
        .post('/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ toUserId: bobId, content: 'Ephemeral file', fileIds: [fileId] });
      const dmId = dmRes.body.id;

      // Alice deletes the DM
      await request(app)
        .delete(`/dms/messages/${dmId}`)
        .set('Authorization', `Bearer ${aliceToken}`);

      // Bob should no longer access the file (DM is soft-deleted)
      const fileRes = await request(app)
        .get(`/files/${fileId}`)
        .set('Authorization', `Bearer ${bobToken}`);
      expect(fileRes.status).toBe(404);
    });
  });

  describe('File existence enumeration prevention', () => {
    let ownerToken: string;
    let attackerToken: string;

    beforeEach(async () => {
      await prisma.dMReaction.deleteMany();
      await prisma.reaction.deleteMany();
      await prisma.file.deleteMany();
      await prisma.directMessage.deleteMany();
      await prisma.message.deleteMany();
      await prisma.channelRead.deleteMany();
      await prisma.channelMember.deleteMany();
      await prisma.channel.deleteMany();
      await prisma.user.deleteMany();

      const ownerRes = await request(app).post('/auth/register').send({
        email: 'owner-enum@example.com',
        password: 'password123',
        name: 'Owner',
      });
      ownerToken = ownerRes.body.token;

      const attackerRes = await request(app).post('/auth/register').send({
        email: 'attacker-enum@example.com',
        password: 'password123',
        name: 'Attacker',
      });
      attackerToken = attackerRes.body.token;
    });

    it('should return identical 404 for non-existent and unauthorized files', async () => {
      // Owner uploads a file (it exists)
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', testFilePath);
      expect(uploadRes.status).toBe(201);
      const existingFileId = uploadRes.body.id;

      // Attacker probes: existing file they don't own
      const existingRes = await request(app)
        .get(`/files/${existingFileId}`)
        .set('Authorization', `Bearer ${attackerToken}`);

      // Attacker probes: non-existent file
      const nonExistentRes = await request(app)
        .get(`/files/${existingFileId + 9999}`)
        .set('Authorization', `Bearer ${attackerToken}`);

      // Both must return the same status and error to prevent enumeration
      expect(existingRes.status).toBe(404);
      expect(nonExistentRes.status).toBe(404);
      expect(existingRes.body.error).toBe(nonExistentRes.body.error);
    });

    it('should return identical 404 for delete on non-existent and unauthorized files', async () => {
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${ownerToken}`)
        .attach('file', testFilePath);
      const existingFileId = uploadRes.body.id;

      const existingRes = await request(app)
        .delete(`/files/${existingFileId}`)
        .set('Authorization', `Bearer ${attackerToken}`);

      const nonExistentRes = await request(app)
        .delete(`/files/${existingFileId + 9999}`)
        .set('Authorization', `Bearer ${attackerToken}`);

      expect(existingRes.status).toBe(404);
      expect(nonExistentRes.status).toBe(404);
      expect(existingRes.body.error).toBe(nonExistentRes.body.error);
    });
  });

  describe('Internal storage path non-disclosure', () => {
    it('should not expose gcsPath in upload response', async () => {
      const res = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);

      expect(res.status).toBe(201);
      expect(res.body).not.toHaveProperty('gcsPath');
      expect(res.body).toHaveProperty('url'); // public download URL is fine
    });

    it('should not expose gcsPath in file info response', async () => {
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);
      const fileId = uploadRes.body.id;

      const res = await request(app)
        .get(`/files/${fileId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('gcsPath');
    });

    it('should not expose gcsPath in file list response', async () => {
      await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);

      const res = await request(app)
        .get('/files')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      for (const file of res.body) {
        expect(file).not.toHaveProperty('gcsPath');
      }
    });

    it('should not expose gcsPath in channel file list', async () => {
      // Upload and attach a file to a channel message
      const uploadRes = await request(app)
        .post('/files')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', testFilePath);
      const fileId = uploadRes.body.id;

      await request(app)
        .post(`/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ content: 'File attached', fileIds: [fileId] });

      const res = await request(app)
        .get(`/channels/${channelId}/files`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      for (const file of res.body) {
        expect(file).not.toHaveProperty('gcsPath');
      }
    });
  });
});
