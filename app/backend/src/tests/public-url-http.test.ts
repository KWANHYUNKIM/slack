// PUBLIC_URL이 http이면 helmet의 HSTS와 CSP upgrade-insecure-requests가 꺼진다.
// app.ts는 import 시점에 env를 읽으므로 env를 먼저 설정하고 동적으로 불러온다.
import request from 'supertest';

describe('PUBLIC_URL=http (LAN 시험용)', () => {
  let app: any;

  beforeAll(async () => {
    process.env.PUBLIC_URL = 'http://192.168.0.5:8080';
    app = (await import('../app.js')).default;
  });

  afterAll(() => {
    delete process.env.PUBLIC_URL;
  });

  it('HSTS 헤더를 보내지 않는다', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('CSP에 upgrade-insecure-requests가 없고 나머지 지시문은 유지된다', async () => {
    const res = await request(app).get('/health');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toBeDefined();
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(csp).toContain("connect-src 'self'");
  });
});
