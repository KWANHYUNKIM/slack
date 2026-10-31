import { TEST_PASSWORD } from './test-constants.js';
import { jest } from '@jest/globals';
import request from 'supertest';
import { getStunConfig, parseStunPublicPort, warnIfInvalidStunPublicPort } from '../config.js';
import app from '../app.js';
import { startStunServer, StunServer } from '../stun/stunServer.js';

describe('GET /huddles/config', () => {
  let token: string;
  const envKeys = ['STUN_ENABLED', 'STUN_PORT', 'STUN_PUBLIC_HOST', 'STUN_PUBLIC_PORT', 'TURN_URLS', 'TURN_USERNAME', 'TURN_CREDENTIAL'];

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

    it('advertises STUN_PUBLIC_PORT instead of the bound port, and falls back when it is removed (repeatable)', async () => {
      process.env.STUN_ENABLED = 'true';
      for (let i = 0; i < 2; i++) {
        process.env.STUN_PUBLIC_PORT = '34780'; // 호스트 34780 → 컨테이너 내부 포트 매핑
        expect((await get()).body.iceServers).toEqual([{ urls: 'stun:chat.example.com:34780' }]);
        process.env.STUN_PUBLIC_PORT = '1'; // 경계값
        expect((await get()).body.iceServers).toEqual([{ urls: 'stun:chat.example.com:1' }]);
        process.env.STUN_PUBLIC_PORT = '65535';
        expect((await get()).body.iceServers).toEqual([{ urls: 'stun:chat.example.com:65535' }]);
        delete process.env.STUN_PUBLIC_PORT;
        expect((await get()).body.iceServers).toEqual([{ urls: `stun:chat.example.com:${stun.port}` }]);
        process.env.STUN_PUBLIC_PORT = '';
        expect((await get()).body.iceServers).toEqual([{ urls: `stun:chat.example.com:${stun.port}` }]);
      }
    });

    it('ignores an invalid STUN_PUBLIC_PORT and advertises the bound port', async () => {
      process.env.STUN_ENABLED = 'true';
      for (const v of ['0', '65536', '-1', '1.5', 'abc', '3478x', '99999']) {
        process.env.STUN_PUBLIC_PORT = v;
        expect((await get()).body.iceServers).toEqual([{ urls: `stun:chat.example.com:${stun.port}` }]);
      }
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

  it('parses STUN_PUBLIC_PORT: 1-65535 integer only, anything else is null', () => {
    for (const [v, want] of [
      ['3478', 3478], [' 34780 ', 34780], ['1', 1], ['65535', 65535],
      ['0', null], ['65536', null], ['-1', null], ['1.5', null], ['abc', null], ['3478x', null], ['', null], [undefined, null],
    ] as const) {
      expect(parseStunPublicPort(v)).toBe(want);
    }
    process.env.STUN_PUBLIC_PORT = '34780';
    expect(getStunConfig().publicPort).toBe(34780);
    delete process.env.STUN_PUBLIC_PORT;
    expect(getStunConfig().publicPort).toBeNull();
  });

  it('warns once at startup for an invalid STUN_PUBLIC_PORT and stays silent for valid or empty values', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.STUN_PUBLIC_PORT = '';
      expect(warnIfInvalidStunPublicPort()).toBe(false);
      process.env.STUN_PUBLIC_PORT = '34780';
      expect(warnIfInvalidStunPublicPort()).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      process.env.STUN_PUBLIC_PORT = '70000';
      expect(warnIfInvalidStunPublicPort()).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts only valid STUN_PORT values (0-65535), else falls back to 3478', () => {
    for (const [v, want] of [['4000', 4000], ['0', 0], ['65535', 65535], ['65536', 3478], ['-1', 3478], ['abc', 3478], ['', 3478]] as const) {
      process.env.STUN_PORT = v;
      expect(getStunConfig().port).toBe(want);
    }
  });
});
