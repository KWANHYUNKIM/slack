import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import sharp from 'sharp';

describe('User Profiles', () => {
  let authToken: string;
  let userId: number;

  const testUser = {
    email: 'profile-test@example.com',
    password: TEST_PASSWORD,
    name: 'Profile Test User',
  };

  beforeEach(async () => {
    await prisma.reaction.deleteMany();
    await prisma.file.deleteMany();
    await prisma.message.deleteMany();
    await prisma.channelRead.deleteMany();
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();

    const userRes = await request(app).post('/auth/register').send(testUser);
    authToken = userRes.body.token;
    userId = userRes.body.user.id;
  });

  describe('GET /users/me', () => {
    it('should get current user profile', async () => {
      const res = await request(app)
        .get('/users/me')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe(testUser.email);
      expect(res.body.name).toBe(testUser.name);
      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('_count');
    });

    it('should require authentication', async () => {
      const res = await request(app).get('/users/me');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /users/me', () => {
    it('should update user name', async () => {
      const res = await request(app)
        .patch('/users/me')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: 'Updated Name' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Name');
    });

    it('should update user bio', async () => {
      const res = await request(app)
        .patch('/users/me')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ bio: 'This is my bio' });

      expect(res.status).toBe(200);
      expect(res.body.bio).toBe('This is my bio');
    });

    it('should reject external avatar URLs (self-contained rule)', async () => {
      for (const avatar of ['https://example.com/avatar.png', 'http://example.com/a.png', '//example.com/a.png', 'not-a-url', '/users/me/avatar/../../x']) {
        const res = await request(app)
          .patch('/users/me')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ avatar });
        expect(res.status).toBe(400);
      }
    });

    it('should set, read, change, and clear a local avatar path', async () => {
      const set = async (avatar: string | null) => request(app)
        .patch('/users/me')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ avatar });
      const read = async () => (await request(app).get('/users/me').set('Authorization', `Bearer ${authToken}`)).body.avatar;

      for (let i = 0; i < 2; i++) {
        // Create
        const created = await set('/users/me/avatar/first.png');
        expect(created.status).toBe(200);
        expect(created.body.avatar).toBe('/users/me/avatar/first.png');
        // Read
        expect(await read()).toBe('/users/me/avatar/first.png');
        // Update
        expect((await set('/users/me/avatar/second.png')).status).toBe(200);
        expect(await read()).toBe('/users/me/avatar/second.png');
        // Delete
        const cleared = await set(null);
        expect(cleared.status).toBe(200);
        expect(await read()).toBeNull();
      }
    });

    it('should validate status values', async () => {
      const res = await request(app)
        .patch('/users/me')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'invalid-status' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /users/me/avatar', () => {
    const makeImage = (format: 'png' | 'jpeg', width: number, height: number) =>
      sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })
        [format]()
        .toBuffer();

    it.each([['png', 'image/png'], ['jpeg', 'image/jpeg']] as const)(
      'should accept %s, resize to 512x512 PNG, then read, replace and keep serving',
      async (format, contentType) => {
        const buf = await makeImage(format, 300, 200);
        const res = await request(app)
          .post('/users/me/avatar')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('avatar', buf, { filename: `a.${format}`, contentType });
        expect(res.status).toBe(200);
        expect(res.body.avatar).toMatch(/^\/users\/me\/avatar\/.+\.png$/);

        // Read: served file is a 512x512 PNG
        const served = await request(app).get(res.body.avatar).buffer(true).parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        expect(served.status).toBe(200);
        const meta = await sharp(served.body as Buffer).metadata();
        expect(meta.format).toBe('png');
        expect(meta.width).toBe(512);
        expect(meta.height).toBe(512);

        // Update: a new upload replaces the old file
        const second = await request(app)
          .post('/users/me/avatar')
          .set('Authorization', `Bearer ${authToken}`)
          .attach('avatar', buf, { filename: `b.${format}`, contentType });
        expect(second.status).toBe(200);
        expect(second.body.avatar).not.toBe(res.body.avatar);
        const old = await request(app).get(res.body.avatar);
        expect(old.status).toBe(404);
      }
    );

    it('should reject an image over the pixel limit', async () => {
      // 4097 x 4097 > 4096 * 4096; a flat image compresses to a tiny file
      const big = await makeImage('png', 4097, 4097);
      const res = await request(app)
        .post('/users/me/avatar')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('avatar', big, { filename: 'big.png', contentType: 'image/png' });
      expect(res.status).toBe(400);

      const me = await request(app).get('/users/me').set('Authorization', `Bearer ${authToken}`);
      expect(me.body.avatar).toBeNull();
    });

    it('should reject a non-image file claiming to be an image', async () => {
      const res = await request(app)
        .post('/users/me/avatar')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('avatar', Buffer.from('not an image at all'), { filename: 'x.png', contentType: 'image/png' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('File is not a valid image');
    });

    it('should require authentication', async () => {
      const buf = await makeImage('png', 10, 10);
      const res = await request(app).post('/users/me/avatar').attach('avatar', buf, { filename: 'a.png', contentType: 'image/png' });
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /users/me/status', () => {
    it('should update user status', async () => {
      const res = await request(app)
        .put('/users/me/status')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ status: 'away' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('away');
    });

    it('should accept valid status values', async () => {
      const statuses = ['online', 'away', 'busy', 'offline'];

      for (const status of statuses) {
        const res = await request(app)
          .put('/users/me/status')
          .set('Authorization', `Bearer ${authToken}`)
          .send({ status });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe(status);
      }
    });
  });

  describe('GET /users/:id', () => {
    it('should get user by ID', async () => {
      const res = await request(app)
        .get(`/users/${userId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(userId);
      expect(res.body.name).toBe(testUser.name);
    });

    it('should NOT expose email when viewing another user profile', async () => {
      // Create a second user
      const otherRes = await request(app).post('/auth/register').send({
        email: 'other-user@example.com',
        password: 'password123',
        name: 'Other User',
      });
      const otherUserId = otherRes.body.user.id;

      // View the other user's profile
      const res = await request(app)
        .get(`/users/${otherUserId}`)
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(otherUserId);
      expect(res.body.name).toBe('Other User');
      expect(res.body).not.toHaveProperty('email');
    });

    it('should return 404 for non-existent user', async () => {
      const res = await request(app)
        .get('/users/99999')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe('GET /users', () => {
    beforeEach(async () => {
      await request(app).post('/auth/register').send({
        email: 'alice@example.com',
        password: TEST_PASSWORD,
        name: 'Alice',
      });
      await request(app).post('/auth/register').send({
        email: 'bob@example.com',
        password: TEST_PASSWORD,
        name: 'Bob',
      });
    });

    it('should list all users', async () => {
      const res = await request(app)
        .get('/users')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(3);
    });

    it('should search users by name', async () => {
      const res = await request(app)
        .get('/users?search=Alice')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Alice');
    });

    it('should not search users by email (privacy)', async () => {
      const res = await request(app)
        .get('/users?search=bob@')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('@mention search should not match user by email prefix (privacy leak)', async () => {
      // "alice" appears in alice@example.com but should NOT return that user
      // unless their name also contains "alice"
      const res = await request(app)
        .get('/users?search=alice')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      // Only the user whose NAME contains "alice" should be returned
      expect(res.body.every((u: { name: string }) => u.name.toLowerCase().includes('alice'))).toBe(true);
      // The "Profile Test User" whose email is profile-test@example.com should not appear
      const profileTestUser = res.body.find((u: { name: string }) => u.name === 'Profile Test User');
      expect(profileTestUser).toBeUndefined();
    });

    it('should NOT return deactivated users in search results', async () => {
      // Deactivate Alice
      const alice = await prisma.user.findFirst({ where: { name: 'Alice' } });
      await prisma.user.update({
        where: { id: alice!.id },
        data: { deactivatedAt: new Date() },
      });

      // Search for Alice — should not appear
      const res = await request(app)
        .get('/users?search=Alice')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(200);
      expect(res.body.find((u: { name: string }) => u.name === 'Alice')).toBeUndefined();
    });

    it('should NOT return deactivated users in full listing', async () => {
      // Get count before deactivation
      const beforeRes = await request(app)
        .get('/users')
        .set('Authorization', `Bearer ${authToken}`);
      const countBefore = beforeRes.body.length;

      // Deactivate Bob
      const bob = await prisma.user.findFirst({ where: { name: 'Bob' } });
      await prisma.user.update({
        where: { id: bob!.id },
        data: { deactivatedAt: new Date() },
      });

      const afterRes = await request(app)
        .get('/users')
        .set('Authorization', `Bearer ${authToken}`);

      expect(afterRes.body.length).toBe(countBefore - 1);
      expect(afterRes.body.find((u: { name: string }) => u.name === 'Bob')).toBeUndefined();
    });
  });
});
