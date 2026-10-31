// 기본값(PUBLIC_URL 없음)은 https 전제: HSTS와 upgrade-insecure-requests가 켜져 있다.
import request from 'supertest';
import app from '../app.js';

describe('PUBLIC_URL 기본값', () => {
  it('TRUST_PROXY가 없으면 프록시를 신뢰하지 않는다(기본 0)', () => {
    expect(app.get('trust proxy')).toBe(0);
  });

  it('HSTS와 upgrade-insecure-requests를 보낸다', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
  });
});
