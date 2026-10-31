import { TEST_PASSWORD } from './test-constants.js';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';

// POST /channels의 실패 경로를 만들고(Create) 조회하고(Read) 고치고(Update) 지우며(Delete) 반복해도
// 400/401/403/413 응답에 항상 code가 붙는지 확인한다. 경로마다 구체 code 또는 안전망 기본 code가 와야 한다.
describe('POST /channels failure paths always carry a code', () => {
  let token: string;
  let guestToken: string;

  beforeAll(async () => {
    await prisma.channelMember.deleteMany();
    await prisma.channel.deleteMany();
    await prisma.user.deleteMany();
    const a = await request(app).post('/auth/register').send({ email: 'cce-a@example.com', password: TEST_PASSWORD, name: 'CCE A' });
    token = a.body.token;
    const g = await request(app).post('/auth/register').send({ email: 'cce-g@example.com', password: TEST_PASSWORD, name: 'CCE G' });
    await prisma.user.update({ where: { id: g.body.user.id }, data: { role: 'GUEST' } });
    const login = await request(app).post('/auth/login').send({ email: 'cce-g@example.com', password: TEST_PASSWORD });
    guestToken = login.body.token;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  const expectCoded = (res: { status: number; body: { code?: unknown; error?: unknown } }, status: number, code?: string) => {
    expect(res.status).toBe(status);
    expect(typeof res.body.code).toBe('string');
    expect(typeof res.body.error === 'string' || Array.isArray(res.body.error)).toBe(true);
    if (code) expect(res.body.code).toBe(code);
  };

  it('repeats create / read / update / delete and every failure keeps its code', async () => {
    for (let round = 0; round < 15; round++) {
      const name = `round-${round}`;
      const created = await request(app).post('/channels').set(auth()).send({ name });
      expect(created.status).toBe(201);

      // 같은 이름 다시 만들기, 대소문자만 다른 이름
      expectCoded(await request(app).post('/channels').set(auth()).send({ name }), 400, 'CHANNEL_NAME_TAKEN');
      expectCoded(await request(app).post('/channels').set(auth()).send({ name: name.toUpperCase() }), 400, 'CHANNEL_NAME_TAKEN');

      // 이름 규칙 위반(보이지 않는 문자, 공백, 비문자열, 너무 긺, 다른 문자 체계 혼용)
      for (const bad of ['dev᠋', 'dev᠎', '   ', 'two words', 'gеneral', 'x'.repeat(81), 123, null, ['a']]) {
        expectCoded(await request(app).post('/channels').set(auth()).send({ name: bad }), 400, 'CHANNEL_NAME_INVALID');
      }

      // 조회: 실패한 요청이 채널을 남기지 않았다
      const list = await request(app).get('/channels').set(auth());
      const items: Array<{ name: string }> = Array.isArray(list.body) ? list.body : list.body.items;
      expect(items.filter((c) => c.name === name)).toHaveLength(1);

      // 수정: 같은 이름 충돌, 없는 채널
      const id = created.body.id as number;
      const other = await request(app).post('/channels').set(auth()).send({ name: `${name}-b` });
      expectCoded(await request(app).patch(`/channels/${other.body.id}`).set(auth()).send({ name }), 409);

      // 삭제 후 같은 이름 재사용
      await prisma.channelMember.deleteMany({ where: { channelId: { in: [id, other.body.id] } } });
      await prisma.channel.deleteMany({ where: { id: { in: [id, other.body.id] } } });
      expectCoded(await request(app).get(`/channels/${id}`).set(auth()), 404);
      expect((await request(app).post('/channels').set(auth()).send({ name })).status).toBe(201); // 지운 이름은 다시 쓸 수 있다
      await prisma.channelMember.deleteMany();
      await prisma.channel.deleteMany();
    }
  }, 120000);

  it('auth, role, body-parser and schema failures carry a code', async () => {
    expectCoded(await request(app).post('/channels').send({ name: 'x' }), 401);
    expectCoded(await request(app).post('/channels').set({ Authorization: 'Bearer nope' }).send({ name: 'x' }), 401);
    expectCoded(await request(app).post('/channels').set({ Authorization: `Bearer ${guestToken}` }).send({ name: 'x' }), 403);
    // 깨진 JSON, 너무 큰 본문, JSON이 아닌 형식
    expectCoded(await request(app).post('/channels').set(auth()).set('Content-Type', 'application/json').send('{"name":'), 400, 'INVALID_JSON');
    expectCoded(await request(app).post('/channels').set(auth()).send({ name: 'x'.repeat(200 * 1024) }), 413, 'PAYLOAD_TOO_LARGE');
    expectCoded(await request(app).post('/channels').set(auth()).send({ name: 'ok-name', isPrivate: 'yes' }), 400);
  });
});
