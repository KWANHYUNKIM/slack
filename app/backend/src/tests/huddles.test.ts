import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';

describe('GET /huddles/config', () => {
  let token: string;
  const envKeys = ['STUN_ENABLED', 'STUN_PORT', 'TURN_URLS', 'TURN_USERNAME', 'TURN_CREDENTIAL'];

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

  it('is disabled by default in test env: empty list', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ iceServers: [] });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns built-in STUN based on request host and STUN_PORT', async () => {
    process.env.STUN_ENABLED = 'true';
    let res = await get();
    expect(res.body.iceServers).toEqual([{ urls: 'stun:chat.example.com:3478' }]);
    process.env.STUN_PORT = '4000';
    res = await get();
    expect(res.body.iceServers).toEqual([{ urls: 'stun:chat.example.com:4000' }]);
  });

  it('adds and removes TURN as env changes (repeatable)', async () => {
    process.env.STUN_ENABLED = 'true';
    for (let i = 0; i < 2; i++) {
      process.env.TURN_URLS = 'turn:turn.example.com:3478, turns:turn.example.com:5349, http://evil';
      process.env.TURN_USERNAME = 'u';
      process.env.TURN_CREDENTIAL = 'p';
      let res = await get();
      expect(res.body.iceServers).toEqual([
        { urls: 'stun:chat.example.com:3478' },
        { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'u', credential: 'p' },
      ]);

      for (const k of ['TURN_URLS', 'TURN_USERNAME', 'TURN_CREDENTIAL']) delete process.env[k];
      res = await get();
      expect(res.body.iceServers).toEqual([{ urls: 'stun:chat.example.com:3478' }]);
    }
  });

  it('omits STUN but keeps TURN when STUN is disabled', async () => {
    process.env.STUN_ENABLED = 'false';
    process.env.TURN_URLS = 'turn:t.example.com:3478';
    const res = await get();
    expect(res.body.iceServers).toEqual([{ urls: ['turn:t.example.com:3478'] }]);
  });
});
