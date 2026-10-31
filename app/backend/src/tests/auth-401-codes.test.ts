import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import prisma from '../db.js';
import { JWT_SECRET } from '../config.js';

// 프런트(lib/authErrors.ts isSessionEndingError)는 401 중 아래 code만 로그아웃으로 본다.
// 서버가 내는 401의 code가 이 구분을 지키는지 반복해서 확인한다: 토큰 문제는 AUTH_*_TOKEN, 입력 문제는 그 밖의 code.
const SESSION_ENDING = ['AUTH_NO_TOKEN', 'AUTH_INVALID_TOKEN'];

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sidOf = (token: string): string => (jwt.decode(token) as { sid: string }).sid;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/auth/login').send({ email, password: TEST_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token;
}

describe('401 응답의 code (세션 종료 구분)', () => {
  let adminToken: string;
  let memberId: number;

  beforeAll(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    const reg = async (email: string, name: string) => {
      const r = await request(app).post('/auth/register').send({ email, password: TEST_PASSWORD, name });
      expect(r.status).toBe(201);
      return r.body.user.id as number;
    };
    const adminId = await reg('admin-401@example.com', 'Admin');
    memberId = await reg('member-401@example.com', 'Member');
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });
    adminToken = await login('admin-401@example.com');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('토큰 문제는 세션 종료 code', () => {
    it('토큰이 없으면 AUTH_NO_TOKEN', async () => {
      const res = await request(app).get('/channels').expect(401);
      expect(res.body.code).toBe('AUTH_NO_TOKEN');
    });

    it('쓰레기 토큰과 다른 키로 서명한 토큰은 AUTH_INVALID_TOKEN', async () => {
      const junk = await request(app).get('/channels').set(auth('not-a-jwt')).expect(401);
      expect(junk.body.code).toBe('AUTH_INVALID_TOKEN');
      const forged = jwt.sign({ userId: memberId, tokenVersion: 0 }, 'wrong-secret', { expiresIn: '1h' });
      const res = await request(app).get('/channels').set(auth(forged)).expect(401);
      expect(res.body.code).toBe('AUTH_INVALID_TOKEN');
    });

    it('만료된 토큰은 AUTH_INVALID_TOKEN', async () => {
      const token = await login('member-401@example.com');
      const claims = jwt.decode(token) as { userId: number; tokenVersion: number; sid: string };
      const expired = jwt.sign({ userId: claims.userId, tokenVersion: claims.tokenVersion, sid: claims.sid }, JWT_SECRET, { expiresIn: -10 });
      const res = await request(app).get('/channels').set(auth(expired)).expect(401);
      expect(res.body.code).toBe('AUTH_INVALID_TOKEN');
    });

    it('폐기된 세션의 토큰은 AUTH_INVALID_TOKEN (로그인 -> 사용 -> 폐기 -> 거부 반복)', async () => {
      for (let i = 0; i < 2; i++) {
        const t1 = await login('member-401@example.com');
        const t2 = await login('member-401@example.com');
        await request(app).get('/channels').set(auth(t1)).expect(200);
        await request(app).delete(`/users/me/sessions/${sidOf(t1)}`).set(auth(t2)).expect(200);
        const res = await request(app).get('/channels').set(auth(t1)).expect(401);
        expect(res.body.code).toBe('AUTH_INVALID_TOKEN');
        // 다른 세션은 그대로 유효하다
        await request(app).get('/channels').set(auth(t2)).expect(200);
      }
    });

    it('로그아웃한 토큰은 AUTH_INVALID_TOKEN', async () => {
      const t = await login('member-401@example.com');
      await request(app).post('/auth/logout').set(auth(t)).expect(200);
      const res = await request(app).get('/channels').set(auth(t)).expect(401);
      expect(res.body.code).toBe('AUTH_INVALID_TOKEN');
    });

    it('비활성화된 계정의 토큰은 AUTH_INVALID_TOKEN', async () => {
      const t = await login('member-401@example.com');
      await request(app).post(`/admin/users/${memberId}/deactivate`).set(auth(adminToken)).expect(200);
      const res = await request(app).get('/channels').set(auth(t)).expect(401);
      expect(res.body.code).toBe('AUTH_INVALID_TOKEN');
      await request(app).post(`/admin/users/${memberId}/reactivate`).set(auth(adminToken));
    });
  });

  describe('입력 문제는 세션 종료 code가 아니다', () => {
    it('틀린 비밀번호로 로그인하면 AUTH_INVALID_CREDENTIALS이고 가지고 있던 토큰은 계속 유효하다', async () => {
      const token = await login('admin-401@example.com');
      for (let i = 0; i < 2; i++) {
        const bad = await request(app).post('/auth/login').set(auth(token)).send({ email: 'admin-401@example.com', password: 'wrong-password-1' });
        expect(bad.status).toBe(401);
        expect(bad.body.code).toBe('AUTH_INVALID_CREDENTIALS');
        expect(SESSION_ENDING).not.toContain(bad.body.code);
        await request(app).get('/channels').set(auth(token)).expect(200);
      }
    });

    it('없는 계정도 같은 code다', async () => {
      const res = await request(app).post('/auth/login').send({ email: 'nobody-401@example.com', password: 'wrong-password-1' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('로그인 2단계에서 모르는 mfaToken은 MFA_TOKEN_INVALID', async () => {
      const res = await request(app).post('/auth/login/2fa').send({ mfaToken: 'no-such-challenge', code: '123456' });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('MFA_TOKEN_INVALID');
      expect(SESSION_ENDING).not.toContain(res.body.code);
    });

    it('현재 비밀번호가 틀린 변경은 401이 아니라 400이고 토큰은 그대로 유효하다 (호환)', async () => {
      const token = await login('admin-401@example.com');
      const res = await request(app).post('/auth/change-password').set(auth(token)).send({ currentPassword: 'wrong-password-1', newPassword: 'another-password-1' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AUTH_CURRENT_PASSWORD_INCORRECT');
      await request(app).get('/channels').set(auth(token)).expect(200);
    });

    it('다운로드 링크 토큰이 틀리면 FILE_TOKEN_INVALID (세션 종료 아님)', async () => {
      const bad = await request(app).get('/files/1/download?token=bad');
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('FILE_TOKEN_INVALID');
      expect(SESSION_ENDING).not.toContain(bad.body.code);
    });
  });

  it('토큰 필요 경로의 401은 항상 code가 있다 (code 없는 401 없음)', async () => {
    const paths = ['/channels', '/users/me/sessions', '/users/me/2fa', '/files/1/download'];
    for (const p of paths) {
      const res = await request(app).get(p);
      expect(res.status).toBe(401);
      expect(typeof res.body.code).toBe('string');
    }
  });
});
