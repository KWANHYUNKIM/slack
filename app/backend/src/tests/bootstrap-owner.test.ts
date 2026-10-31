import { TEST_PASSWORD } from './test-constants.js';
import { PassThrough, Readable } from 'stream';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { BootstrapRejectedError, createInitialOwner } from '../services/bootstrapService.js';
import {
  EXIT_INVALID, EXIT_OK, EXIT_REJECTED, runCreateOwner,
} from '../scripts/create-owner.js';

const OWNER_EMAIL = 'bootstrap-owner@example.com';

async function resetDb() {
  await prisma.auditLog.deleteMany();
  await prisma.inviteLink.deleteMany();
  await prisma.channelRead.deleteMany();
  await prisma.channelMember.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.user.deleteMany();
}

// CLI를 프로세스 없이 돌린다. stdin은 파이프(TTY 아님)로 비밀번호 한 줄을 넘긴다.
async function runCli(args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (c) => { out += c.toString(); });
  stderr.on('data', (c) => { err += c.toString(); });
  const code = await runCreateOwner({
    argv: args,
    env: opts.env ?? {},
    stdin: Readable.from(opts.stdin !== undefined ? [opts.stdin] : []),
    stdout,
    stderr,
  });
  return { code, out, err };
}

function login(email: string, password: string) {
  return request(app).post('/auth/login').send({ email, password });
}

describe('Bootstrap first OWNER (scripts/create-owner)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates the first OWNER on an empty DB, who can then log in and read their profile', async () => {
    const res = await runCli(['--email', 'Bootstrap-Owner@Example.com', '--name', 'First Owner'], {
      stdin: `${TEST_PASSWORD}\n`,
    });
    expect(res.code).toBe(EXIT_OK);
    expect(res.out).toMatch(/Created OWNER account \(id=\d+\)/);
    // 비밀번호와 이메일은 출력하지 않는다
    expect(res.out + res.err).not.toContain(TEST_PASSWORD);
    expect((res.out + res.err).toLowerCase()).not.toContain(OWNER_EMAIL);

    const loginRes = await login(OWNER_EMAIL, TEST_PASSWORD);
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.role).toBe('OWNER');

    const me = await request(app).get('/users/me').set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(OWNER_EMAIL);
    expect(me.body.name).toBe('First Owner');

    // 기본 채널 멤버십과 감사 로그가 함께 생긴다
    const channels = await prisma.channelMember.findMany({
      where: { userId: loginRes.body.user.id },
      include: { channel: { select: { name: true } } },
    });
    expect(channels.map((c) => c.channel.name).sort()).toEqual(['general', 'random']);

    const audit = await prisma.auditLog.findMany({ where: { action: 'owner.bootstrapped' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].actorId).toBe(loginRes.body.user.id);
    expect(audit[0].targetId).toBe(loginRes.body.user.id);
    expect(audit[0].details ?? '').not.toContain(TEST_PASSWORD);
    expect(audit[0].details ?? '').not.toContain(OWNER_EMAIL);
  });

  it('reads the password from BOOTSTRAP_OWNER_PASSWORD when stdin is not a terminal', async () => {
    const res = await runCli([], {
      env: {
        BOOTSTRAP_OWNER_EMAIL: OWNER_EMAIL,
        BOOTSTRAP_OWNER_NAME: 'Env Owner',
        BOOTSTRAP_OWNER_PASSWORD: TEST_PASSWORD,
      },
    });
    expect(res.code).toBe(EXIT_OK);
    expect((await login(OWNER_EMAIL, TEST_PASSWORD)).status).toBe(200);
  });

  it('refuses a second bootstrap once an OWNER exists', async () => {
    const first = await runCli(['--email', OWNER_EMAIL, '--name', 'Owner'], { stdin: `${TEST_PASSWORD}\n` });
    expect(first.code).toBe(EXIT_OK);

    const second = await runCli(['--email', 'attacker@example.com', '--name', 'Attacker'], { stdin: `${TEST_PASSWORD}\n` });
    expect(second.code).toBe(EXIT_REJECTED);
    expect(second.err).toMatch(/already has users/);

    await expect(createInitialOwner({ email: 'attacker@example.com', name: 'Attacker', password: TEST_PASSWORD }))
      .rejects.toBeInstanceOf(BootstrapRejectedError);

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.user.findUnique({ where: { email: 'attacker@example.com' } })).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'owner.bootstrapped' } })).toBe(1);
  });

  it('lets only one of two concurrent bootstraps succeed', async () => {
    const results = await Promise.allSettled([
      createInitialOwner({ email: 'race-a@example.com', name: 'Race A', password: TEST_PASSWORD }),
      createInitialOwner({ email: 'race-b@example.com', name: 'Race B', password: TEST_PASSWORD }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(BootstrapRejectedError);

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.user.count({ where: { role: 'OWNER' } })).toBe(1);
  });

  it('lets only one of two concurrent CLI runs succeed (both pass the early check)', async () => {
    const [a, b] = await Promise.all([
      runCli(['--email', 'cli-a@example.com', '--name', 'A'], { stdin: `${TEST_PASSWORD}\n` }),
      runCli(['--email', 'cli-b@example.com', '--name', 'B'], { stdin: `${TEST_PASSWORD}\n` }),
    ]);
    expect([a.code, b.code].sort()).toEqual([EXIT_OK, EXIT_REJECTED].sort());
    expect(await prisma.user.count({ where: { role: 'OWNER' } })).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it('refuses when the DB already has a (non-owner) user', async () => {
    const existing = await request(app).post('/auth/register').send({
      email: 'existing@example.com', password: TEST_PASSWORD, name: 'Existing',
    });
    expect(existing.status).toBe(201);

    const res = await runCli(['--email', OWNER_EMAIL, '--name', 'Owner'], { stdin: `${TEST_PASSWORD}\n` });
    expect(res.code).toBe(EXIT_REJECTED);
    await expect(createInitialOwner({ email: OWNER_EMAIL, name: 'Owner', password: TEST_PASSWORD }))
      .rejects.toBeInstanceOf(BootstrapRejectedError);

    expect(await prisma.user.count({ where: { role: 'OWNER' } })).toBe(0);
    expect(await prisma.user.findUnique({ where: { email: OWNER_EMAIL } })).toBeNull();
  });

  it('refuses even when the only user is deactivated', async () => {
    await prisma.user.create({
      data: { email: 'gone@example.com', password: 'x', name: 'Gone', deactivatedAt: new Date() },
    });
    const res = await runCli(['--email', OWNER_EMAIL, '--name', 'Owner'], { stdin: `${TEST_PASSWORD}\n` });
    expect(res.code).toBe(EXIT_REJECTED);
  });

  // (b) 방식에는 일회용 토큰이 없다. 대신 잘못된 입력(약한 비밀번호, 잘못된 이메일, 인자 누락)을 거부하는지 본다.
  it('rejects invalid input with the same password policy as registration', async () => {
    const weak = await runCli(['--email', OWNER_EMAIL, '--name', 'Owner'], { stdin: '12345\n' });
    expect(weak.code).toBe(EXIT_INVALID);
    expect(weak.err).toMatch(/Invalid password/);
    expect(weak.err).not.toContain('12345');

    const tooLong = await runCli(['--email', OWNER_EMAIL, '--name', 'Owner'], { stdin: `${'a'.repeat(73)}\n` });
    expect(tooLong.code).toBe(EXIT_INVALID);

    const badEmail = await runCli(['--email', 'not-an-email', '--name', 'Owner'], { stdin: `${TEST_PASSWORD}\n` });
    expect(badEmail.code).toBe(EXIT_INVALID);
    expect(badEmail.err).toMatch(/Invalid email/);

    const missing = await runCli(['--email', OWNER_EMAIL], { stdin: `${TEST_PASSWORD}\n` });
    expect(missing.code).toBe(EXIT_INVALID);

    const unknownFlag = await runCli(['--email', OWNER_EMAIL, '--name', 'Owner', '--role', 'ADMIN'], { stdin: `${TEST_PASSWORD}\n` });
    expect(unknownFlag.code).toBe(EXIT_INVALID);

    // 가입 API도 같은 정책으로 거부한다
    const reg = await request(app).post('/auth/register').send({ email: 'weak@example.com', password: '12345', name: 'W' });
    expect(reg.status).toBe(400);

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('OWNER can create, list, use and delete an invite; registration via invite works', async () => {
    const created = await runCli(['--email', OWNER_EMAIL, '--name', 'Owner'], { stdin: `${TEST_PASSWORD}\n` });
    expect(created.code).toBe(EXIT_OK);
    const ownerToken = (await login(OWNER_EMAIL, TEST_PASSWORD)).body.token;

    // Create
    const invite = await request(app)
      .post('/admin/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ maxUses: 1 });
    expect(invite.status).toBe(201);

    // Read
    const list = await request(app).get('/admin/invites').set('Authorization', `Bearer ${ownerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.map((i: { id: number }) => i.id)).toContain(invite.body.id);

    // 초대로 일반 가입
    const member = await request(app).post('/auth/register').send({
      email: 'member@example.com', password: TEST_PASSWORD, name: 'Member', inviteCode: invite.body.code,
    });
    expect(member.status).toBe(201);
    expect(member.body.user.role).toBe('MEMBER');
    expect((await login('member@example.com', TEST_PASSWORD)).status).toBe(200);

    // 사용자가 생겼으므로 부트스트랩은 계속 거부된다
    const again = await runCli(['--email', 'late@example.com', '--name', 'Late'], { stdin: `${TEST_PASSWORD}\n` });
    expect(again.code).toBe(EXIT_REJECTED);

    // Update: OWNER 비밀번호 변경 후 새 비밀번호로 로그인
    const newPassword = `${TEST_PASSWORD}-new`;
    const changed = await request(app)
      .post('/auth/change-password')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword });
    expect(changed.status).toBe(200);
    expect((await login(OWNER_EMAIL, newPassword)).status).toBe(200);
    const freshToken = changed.body.token;

    // Delete: 초대 삭제 뒤에는 그 코드로 가입할 수 없다
    const second = await request(app)
      .post('/admin/invites')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({});
    expect(second.status).toBe(201);
    const del = await request(app)
      .delete(`/admin/invites/${second.body.id}`)
      .set('Authorization', `Bearer ${freshToken}`);
    expect(del.status).toBe(200);
    const afterDelete = await request(app).post('/auth/register').send({
      email: 'late2@example.com', password: TEST_PASSWORD, name: 'Late', inviteCode: second.body.code,
    });
    expect(afterDelete.status).toBe(400);

    expect(await prisma.user.count({ where: { role: 'OWNER' } })).toBe(1);
  });
});
