import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import { getStunConfig } from '../config.js';
import app from '../app.js';
import { startStunServer, StunServer } from '../stun/stunServer.js';

describe('GET /huddles/config', () => {
  let token: string;
  const envKeys = ['STUN_ENABLED', 'STUN_PORT', 'STUN_PUBLIC_HOST', 'TURN_URLS', 'TURN_USERNAME', 'TURN_CREDENTIAL'];

  beforeEach(async () => {
    const res = await request(app).post('/auth/register').send({
      email: `huddle-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, password: TEST_PASSWORD, name: 'Huddle Cfg',
    });
    if (!res.body.token) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    token = res.body.token;
  });

  afterEach(() => { for (const k of envKeys) delete process.env[k]; });

  const get = () => request(app).get('/huddles/config').set('Authorization', `Bearer ${token}`).set('Host', 'chat.example.com:3000');

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/huddles/config');
    expect(res.status).toBe(401);
  });

  it('does not advertise STUN when no server is listening (disabled, or bind failed)', async () => {
    let res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ iceServers: [] });
    expect(res.headers['cache-control']).toBe('no-store');
    process.env.STUN_ENABLED = 'true'; // 켜져 있어도 실제 listening이 아니면(바인드 실패) 광고 없음
    res = await get();
    expect(res.body).toEqual({ iceServers: [] });
  });

  describe('with a listening STUN server', () => {
    let stun: StunServer;
    beforeEach(async () => { stun = await startStunServer({ port: 0, host: '127.0.0.1' }); });
    afterEach(async () => { await stun.close(); });

    it('advertises the actually bound port and the request host in dev', async () => {
      process.env.STUN_ENABLED = 'true';
      process.env.STUN_PORT = '3478'; // 설정값이 아니라 실제 포트를 광고
      const res = await get();
      expect(res.body.iceServers).toEqual([{ urls: `stun:chat.example.com:${stun.port}` }]);
    });

    it('prefers STUN_PUBLIC_HOST over the Host header', async () => {
      process.env.STUN_ENABLED = 'true';
      process.env.STUN_PUBLIC_HOST = 'stun.public.example';
      const res = await get();
      expect(res.body.iceServers).toEqual([{ urls: `stun:stun.public.example:${stun.port}` }]);
    });

    it('ignores an invalid STUN_PUBLIC_HOST', async () => {
      process.env.STUN_ENABLED = 'true';
      process.env.STUN_PUBLIC_HOST = 'bad host/../x';
      expect((await get()).body.iceServers).toEqual([]);
    });

    it('in production does not trust the Host header: no STUN without STUN_PUBLIC_HOST', async () => {
      process.env.STUN_ENABLED = 'true';
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect((await get()).body.iceServers).toEqual([]);
        process.env.STUN_PUBLIC_HOST = 'stun.public.example';
        expect((await get()).body.iceServers).toEqual([{ urls: `stun:stun.public.example:${stun.port}` }]);
      } finally {
        process.env.NODE_ENV = prev;
      }
    });
  });

  it('adds and removes TURN as env changes (repeatable)', async () => {
    process.env.STUN_ENABLED = 'true';
    const stun = await startStunServer({ port: 0, host: '127.0.0.1' });
    const stunUrl = `stun:chat.example.com:${stun.port}`;
    try { for (let i = 0; i < 2; i++) {
      process.env.TURN_URLS = 'turn:turn.example.com:3478, turns:turn.example.com:5349, http://evil';
      process.env.TURN_USERNAME = 'u';
      process.env.TURN_CREDENTIAL = 'p';
      let res = await get();
      expect(res.body.iceServers).toEqual([
        { urls: stunUrl },
        { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'u', credential: 'p' },
      ]);

      for (const k of ['TURN_URLS', 'TURN_USERNAME', 'TURN_CREDENTIAL']) delete process.env[k];
      res = await get();
      expect(res.body.iceServers).toEqual([{ urls: stunUrl }]);
    } } finally { await stun.close(); }
  });

  it('omits STUN but keeps TURN when STUN is disabled', async () => {
    process.env.STUN_ENABLED = 'false';
    process.env.TURN_URLS = 'turn:t.example.com:3478';
    const res = await get();
    expect(res.body.iceServers).toEqual([{ urls: ['turn:t.example.com:3478'] }]);
  });

  it('accepts only valid STUN_PORT values (0-65535), else falls back to 3478', () => {
    for (const [v, want] of [['4000', 4000], ['0', 0], ['65535', 65535], ['65536', 3478], ['-1', 3478], ['abc', 3478], ['', 3478]] as const) {
      process.env.STUN_PORT = v;
      expect(getStunConfig().port).toBe(want);
    }
  });
});
