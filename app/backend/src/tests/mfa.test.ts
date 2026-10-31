import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { base32Decode, base32Encode, hotp, totp, totpStep, verifyTotp, buildOtpauthUri } from '../utils/totp.js';
import { sealSecret, openSecret } from '../utils/secretBox.js';
import { normalizeRecoveryCode, generateRecoveryCode, setRequireMfa, getRequireMfa } from '../services/mfaService.js';
import { setWorkspaceRetentionDays, getWorkspaceRetentionDays } from '../services/retentionService.js';

const KEY_HEX = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(16) + 'd'.repeat(16);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const savedKey = process.env.TOTP_ENCRYPTION_KEY;

// ---------------------------------------------------------------------------
// 순수 함수: RFC 6238 부록 B 테스트 벡터, base32, 시간 창, 암호화
// ---------------------------------------------------------------------------
describe('TOTP (RFC 6238)', () => {
  const seeds = {
    sha1: Buffer.from('12345678901234567890'),
    sha256: Buffer.from('12345678901234567890123456789012'),
    sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
  };
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];

  it.each(vectors)('T=%i matches the RFC vectors (SHA1/SHA256/SHA512, 8 digits)', (t, s1, s256, s512) => {
    expect(totp(seeds.sha1, t * 1000, { digits: 8, algorithm: 'sha1' })).toBe(s1);
    expect(totp(seeds.sha256, t * 1000, { digits: 8, algorithm: 'sha256' })).toBe(s256);
    expect(totp(seeds.sha512, t * 1000, { digits: 8, algorithm: 'sha512' })).toBe(s512);
  });

  it('HOTP matches RFC 4226 appendix D', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, i) => expect(hotp(seeds.sha1, i)).toBe(code));
  });

  it('base32 round-trips and matches RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi======')!.toString()).toBe('foobar');
    expect(base32Decode('MZ1W')).toBeNull();
    const raw = Buffer.from('0123456789abcdefghij');
    expect(base32Decode(base32Encode(raw))!.equals(raw)).toBe(true);
  });

  it('accepts ±1 window and rejects ±2 (window boundaries)', () => {
    const secret = seeds.sha1;
    const base = 1_700_000_010_000; // 창 안의 임의 시각
    const step = totpStep(base);
    const codeAt = (s: number) => hotp(secret, s);
    expect(verifyTotp(secret, codeAt(step), base)).toBe(step);
    expect(verifyTotp(secret, codeAt(step - 1), base)).toBe(step - 1);
    expect(verifyTotp(secret, codeAt(step + 1), base)).toBe(step + 1);
    expect(verifyTotp(secret, codeAt(step - 2), base)).toBeNull();
    expect(verifyTotp(secret, codeAt(step + 2), base)).toBeNull();
    // 창의 마지막 밀리초와 다음 창의 첫 밀리초
    const lastMs = (step + 1) * 30_000 - 1;
    expect(totpStep(lastMs)).toBe(step);
    expect(totpStep(lastMs + 1)).toBe(step + 1);
    expect(verifyTotp(secret, codeAt(step - 1), lastMs)).toBe(step - 1);
    expect(verifyTotp(secret, codeAt(step - 1), lastMs + 1)).toBeNull();
    // 형식이 틀린 입력
    expect(verifyTotp(secret, '12345', base)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', base)).toBeNull();
  });

  it('builds an otpauth URI with encoded label', () => {
    const uri = buildOtpauthUri('JBSWY3DPEHPK3PXP', 'a+b@example.com', 'slawk');
    expect(uri).toBe('otpauth://totp/slawk:a%2Bb%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=slawk&algorithm=SHA1&digits=6&period=30');
  });

  it('AES-256-GCM seal/open binds key and context', () => {
    const key = Buffer.from(KEY_HEX, 'hex');
    const sealed = sealSecret(Buffer.from('seed'), key, 'mfa:user:1');
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(openSecret(sealed, key, 'mfa:user:1')!.toString()).toBe('seed');
    expect(openSecret(sealed, key, 'mfa:user:2')).toBeNull();
    expect(openSecret(sealed, Buffer.alloc(32, 1), 'mfa:user:1')).toBeNull();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('xxxx').toString('base64url');
    expect(openSecret(parts.join('.'), key, 'mfa:user:1')).toBeNull();
  });

  it('recovery code format and normalization', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(normalizeRecoveryCode(code.toUpperCase().replace(/-/g, ' '))).toBe(code.replace(/-/g, ''));
    expect(normalizeRecoveryCode('123456')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API 흐름
// ---------------------------------------------------------------------------
describe('2단계 인증 API (E7b)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let port: number;
  const sockets: ClientSocket[] = [];
  let adminToken: string;
  let adminId: number;
  // 테스트에서 쓴 비밀 값(감사 로그에 남지 않았는지 마지막에 확인한다)
  const secretsSeen: string[] = [];

  async function register(email: string, name = 'User'): Promise<{ id: number; token: string }> {
    const r = await request(app).post('/auth/register').send({ email, password: TEST_PASSWORD, name });
    expect(r.status).toBe(201);
    return { id: r.body.user.id, token: r.body.token };
  }

  async function passwordStep(email: string) {
    const r = await request(app).post('/auth/login').send({ email, password: TEST_PASSWORD });
    expect(r.status).toBe(200);
    return r.body;
  }

  /** 등록하고 켠다. 비밀(raw)과 복구 코드를 돌려준다. */
  async function enroll(token: string): Promise<{ secret: Buffer; recoveryCodes: string[] }> {
    const setup = await request(app).post('/users/me/2fa/setup').set(auth(token));
    expect(setup.status).toBe(200);
    const secret = base32Decode(setup.body.secret)!;
    secretsSeen.push(setup.body.secret);
    const enable = await request(app).post('/users/me/2fa/enable').set(auth(token)).send({ password: TEST_PASSWORD, code: totp(secret, Date.now()) });
    expect(enable.status).toBe(200);
    secretsSeen.push(...enable.body.recoveryCodes);
    return { secret, recoveryCodes: enable.body.recoveryCodes };
  }

  /** 마지막으로 받은 창을 지워 다음 로그인에서 현재 코드를 다시 쓸 수 있게 한다(테스트 편의). */
  const forgetLastStep = (userId: number) => prisma.user.update({ where: { id: userId }, data: { mfaLastUsedStep: null } });

  function connect(token: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const s = Client(`http://localhost:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(s);
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  beforeAll(async () => {
    process.env.TOTP_ENCRYPTION_KEY = KEY_HEX;
    await prisma.workspaceSetting.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    const admin = await register('admin-mfa@example.com', 'Admin');
    adminId = admin.id;
    await prisma.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });
    adminToken = (await passwordStep('admin-mfa@example.com')).token;

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(() => {
        const a = httpServer.address();
        port = typeof a === 'object' && a ? a.port : 3001;
        resolve();
      });
    });
  });

  afterEach(async () => {
    process.env.TOTP_ENCRYPTION_KEY = KEY_HEX;
    await setRequireMfa(false);
  });

  afterAll(async () => {
    sockets.forEach((s) => s.disconnect());
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.workspaceSetting.deleteMany();
    if (savedKey === undefined) delete process.env.TOTP_ENCRYPTION_KEY;
    else process.env.TOTP_ENCRYPTION_KEY = savedKey;
  });

  it('등록 → 로그인 2단계 → 해제 → 재등록 (CRUD)', async () => {
    const email = 'crud-mfa@example.com';
    const { id, token } = await register(email);

    // Read: 처음에는 꺼져 있다
    let status = await request(app).get('/users/me/2fa').set(auth(token));
    expect(status.body).toMatchObject({ enabled: false, available: true, required: false, recoveryCodesRemaining: 0 });

    // Create: setup은 otpauth URI와 수동 입력 키를 준다. DB에는 암호화된 값만 있다.
    const setup = await request(app).post('/users/me/2fa/setup').set(auth(token));
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/slawk:crud-mfa%40example\.com\?secret=[A-Z2-7]+&issuer=slawk/);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    secretsSeen.push(setup.body.secret);
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row.mfaPendingSecret).toMatch(/^v1\./);
    expect(row.mfaPendingSecret).not.toContain(setup.body.secret);
    expect(row.mfaEnabledAt).toBeNull();

    // 틀린 코드로는 켜지지 않는다
    const secret = base32Decode(setup.body.secret)!;
    const wrong = String((Number(totp(secret, Date.now())) + 1) % 1_000_000).padStart(6, '0');
    const bad = await request(app).post('/users/me/2fa/enable').set(auth(token)).send({ password: TEST_PASSWORD, code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('MFA_INVALID_CODE');
    // 비밀번호가 없거나 틀리면 맞는 코드여도 켜지지 않는다
    expect((await request(app).post('/users/me/2fa/enable').set(auth(token)).send({ code: totp(secret, Date.now()) })).status).toBe(400);
    const badPw = await request(app).post('/users/me/2fa/enable').set(auth(token)).send({ password: 'wrong-password', code: totp(secret, Date.now()) });
    expect(badPw.status).toBe(403);
    expect(badPw.body.code).toBe('AUTH_CURRENT_PASSWORD_INCORRECT');
    expect((await prisma.user.findUniqueOrThrow({ where: { id } })).mfaEnabledAt).toBeNull();

    // 다른 기기 세션 두 개를 만들어 두고 켠다: 이 기기만 남고 나머지는 폐기된다
    const otherA = (await passwordStep(email)).token as string;
    const otherB = (await passwordStep(email)).token as string;
    const enable = await request(app).post('/users/me/2fa/enable').set(auth(token)).send({ password: TEST_PASSWORD, code: totp(secret, Date.now()) });
    expect(enable.status).toBe(200);
    expect(enable.body.recoveryCodes).toHaveLength(10);
    expect(enable.body.revokedSessions).toBe(2);
    expect((await request(app).get('/channels').set(auth(otherA))).status).toBe(401);
    expect((await request(app).get('/channels').set(auth(otherB))).status).toBe(401);
    expect((await request(app).get('/channels').set(auth(token))).status).toBe(200);
    const enabledLog = await prisma.auditLog.findFirst({ where: { action: 'mfa.enabled', targetId: id } });
    expect(enabledLog?.details).toBe('revokedSessions=2');
    secretsSeen.push(...enable.body.recoveryCodes);
    // 복구 코드는 해시만 저장된다
    const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId: id } });
    expect(stored).toHaveLength(10);
    for (const c of enable.body.recoveryCodes as string[]) {
      expect(stored.some((s) => s.codeHash.includes(c.replace(/-/g, '')))).toBe(false);
    }
    // 이미 켜져 있으면 setup도 enable도 거부
    expect((await request(app).post('/users/me/2fa/setup').set(auth(token))).status).toBe(409);

    status = await request(app).get('/users/me/2fa').set(auth(token));
    expect(status.body).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });

    // 로그인: 비밀번호만으로는 세션이 생기지 않는다
    const sessionsBefore = await prisma.session.count({ where: { userId: id } });
    const step1 = await passwordStep(email);
    expect(step1.mfaRequired).toBe(true);
    expect(step1.token).toBeUndefined();
    expect(step1.expiresIn).toBe(300);
    expect(await prisma.session.count({ where: { userId: id } })).toBe(sessionsBefore);
    secretsSeen.push(step1.mfaToken);

    // Update: 2단계 코드로 세션 발급. 등록 때 쓴 창보다 뒤의 창 코드(+30초, 허용 오차 안)를 쓴다.
    const step2 = await request(app).post('/auth/login/2fa').send({ mfaToken: step1.mfaToken, code: totp(secret, Date.now() + 30_000) });
    expect(step2.status).toBe(200);
    expect(step2.body.token).toBeTruthy();
    expect(step2.body.user.id).toBe(id);
    const token2 = step2.body.token as string;
    expect((await request(app).get('/channels').set(auth(token2))).status).toBe(200);
    // mfaToken은 1회용
    const again = await request(app).post('/auth/login/2fa').send({ mfaToken: step1.mfaToken, code: totp(secret, Date.now()) });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('MFA_TOKEN_INVALID');

    // Delete: 해제는 비밀번호와 코드가 둘 다 맞아야 한다
    await forgetLastStep(id);
    const noPw = await request(app).post('/users/me/2fa/disable').set(auth(token2)).send({ password: 'wrong-password', code: totp(secret, Date.now()) });
    expect(noPw.status).toBe(403);
    expect(noPw.body.code).toBe('AUTH_CURRENT_PASSWORD_INCORRECT');
    const noCode = await request(app).post('/users/me/2fa/disable').set(auth(token2)).send({ password: TEST_PASSWORD, code: '000000' === totp(secret, Date.now()) ? '111111' : '000000' });
    expect(noCode.status).toBe(403);
    expect(noCode.body.code).toBe('MFA_INVALID_CODE');
    const off = await request(app).post('/users/me/2fa/disable').set(auth(token2)).send({ password: TEST_PASSWORD, code: totp(secret, Date.now()) });
    expect(off.status).toBe(200);
    const cleared = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(cleared.mfaSecret).toBeNull();
    expect(cleared.mfaEnabledAt).toBeNull();
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: id } })).toBe(0);
    // 해제 후에는 비밀번호만으로 로그인
    const plain = await passwordStep(email);
    expect(plain.token).toBeTruthy();
    expect(plain.mfaRequired).toBeUndefined();

    // 재등록: 새 비밀로 다시 켤 수 있고 이전 비밀은 통하지 않는다
    const second = await enroll(plain.token);
    expect(second.secret.equals(secret)).toBe(false);
    const step1b = await passwordStep(email);
    const oldSecretCode = await request(app).post('/auth/login/2fa').send({ mfaToken: step1b.mfaToken, code: totp(secret, Date.now() + 30_000) });
    expect(oldSecretCode.status).toBe(401);
    const ok = await request(app).post('/auth/login/2fa').send({ mfaToken: step1b.mfaToken, code: totp(second.secret, Date.now() + 30_000) });
    expect(ok.status).toBe(200);

    const actions = (await prisma.auditLog.findMany({ where: { targetId: id }, orderBy: { id: 'asc' } })).map((a) => a.action);
    expect(actions.filter((a) => a === 'mfa.enabled')).toHaveLength(2);
    expect(actions).toContain('mfa.disabled');
    expect(actions).toContain('auth.login');
  });

  it('같은 30초 창 코드 재사용을 거부한다', async () => {
    const email = 'replay-mfa@example.com';
    const { id, token } = await register(email);
    const { secret } = await enroll(token);

    // 등록에 쓴 코드를 로그인에 다시 쓰면 거부(같은 창)
    const now = Date.now();
    const s1 = await passwordStep(email);
    const reuse = await request(app).post('/auth/login/2fa').send({ mfaToken: s1.mfaToken, code: totp(secret, now) });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('MFA_INVALID_CODE');
    // 다음 창 코드는 통과
    const next = totp(secret, now + 30_000);
    const ok = await request(app).post('/auth/login/2fa').send({ mfaToken: s1.mfaToken, code: next });
    expect(ok.status).toBe(200);
    // 방금 쓴 코드를 새 로그인에서 다시 쓰면 거부, 그보다 앞선 창 코드도 거부
    const s2 = await passwordStep(email);
    expect((await request(app).post('/auth/login/2fa').send({ mfaToken: s2.mfaToken, code: next })).status).toBe(401);
    expect((await request(app).post('/auth/login/2fa').send({ mfaToken: s2.mfaToken, code: totp(secret, now - 30_000) })).status).toBe(401);
    // 허용 오차 밖(+2창)도 거부
    expect((await request(app).post('/auth/login/2fa').send({ mfaToken: s2.mfaToken, code: totp(secret, now + 60_000 + 30_000) })).status).toBe(401);

    // 동시에 같은 코드 두 개를 보내도 하나만 통과한다
    await forgetLastStep(id);
    const [a, b] = [await passwordStep(email), await passwordStep(email)];
    const code = totp(secret, Date.now());
    const results = await Promise.all([
      request(app).post('/auth/login/2fa').send({ mfaToken: a.mfaToken, code }),
      request(app).post('/auth/login/2fa').send({ mfaToken: b.mfaToken, code }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);

    const failed = await prisma.auditLog.findMany({ where: { action: 'auth.login_failed', targetId: id } });
    expect(failed.length).toBeGreaterThanOrEqual(3);
    expect(failed.every((f) => f.details === 'reason=bad_totp')).toBe(true);
  });

  it('mfaToken은 5번 틀리면 닫히고, 만료되면 쓸 수 없다', async () => {
    const email = 'challenge-mfa@example.com';
    const { id, token } = await register(email);
    const { secret } = await enroll(token);
    await forgetLastStep(id);
    const s = await passwordStep(email);
    const wrong = totp(secret, Date.now()) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/auth/login/2fa').send({ mfaToken: s.mfaToken, code: wrong });
      expect({ status: r.status, code: r.body.code }).toEqual({ status: 401, code: 'MFA_INVALID_CODE' });
    }
    const closed = await request(app).post('/auth/login/2fa').send({ mfaToken: s.mfaToken, code: totp(secret, Date.now()) });
    expect(closed.body.code).toBe('MFA_TOKEN_INVALID');

    const s2 = await passwordStep(email);
    await prisma.mfaChallenge.updateMany({ where: { userId: id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await request(app).post('/auth/login/2fa').send({ mfaToken: s2.mfaToken, code: totp(secret, Date.now()) });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('MFA_TOKEN_INVALID');
    expect((await request(app).post('/auth/login/2fa').send({ mfaToken: 'not-a-real-token-xxxxxxxxxxxxx', code: '123456' })).body.code).toBe('MFA_TOKEN_INVALID');
  });

  it('2단계 실패는 로그인 잠금 카운터를 함께 쓴다', async () => {
    const email = 'lock-mfa@example.com';
    const { token } = await register(email);
    const { secret } = await enroll(token);
    const wrong = () => (totp(secret, Date.now()) === '000000' ? '111111' : '000000');
    // 대기 하나당 5번이므로 두 번 나눠 10번 틀린다
    for (let round = 0; round < 2; round++) {
      const s = await passwordStep(email);
      for (let i = 0; i < 5; i++) await request(app).post('/auth/login/2fa').send({ mfaToken: s.mfaToken, code: wrong() });
    }
    const locked = await request(app).post('/auth/login').send({ email, password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('AUTH_ACCOUNT_LOCKED');
  });

  it('복구 코드는 한 번만 쓸 수 있다', async () => {
    const email = 'recovery-mfa@example.com';
    const { id, token } = await register(email);
    const { recoveryCodes } = await enroll(token);
    const code = recoveryCodes[0];

    const s1 = await passwordStep(email);
    // 대문자·공백으로 입력해도 같은 코드로 본다
    const ok = await request(app).post('/auth/login/2fa').send({ mfaToken: s1.mfaToken, code: code.toUpperCase().replace(/-/g, ' ') });
    expect(ok.status).toBe(200);
    const used = await prisma.auditLog.findFirst({ where: { action: 'mfa.recovery_used', targetId: id } });
    expect(used?.details).toBe('remaining=9');

    const s2 = await passwordStep(email);
    const reuse = await request(app).post('/auth/login/2fa').send({ mfaToken: s2.mfaToken, code });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('MFA_INVALID_CODE');
    const failed = await prisma.auditLog.findFirst({ where: { action: 'auth.login_failed', targetId: id }, orderBy: { id: 'desc' } });
    expect(failed?.details).toBe('reason=bad_recovery_code');

    const other = await request(app).post('/auth/login/2fa').send({ mfaToken: s2.mfaToken, code: recoveryCodes[1] });
    expect(other.status).toBe(200);
    const status = await request(app).get('/users/me/2fa').set(auth(other.body.token));
    expect(status.body.recoveryCodesRemaining).toBe(8);
  });

  it('관리자 필수 정책: 등록 전에는 등록 API만 쓸 수 있다', async () => {
    const email = 'policy-mfa@example.com';
    const { token } = await register(email);

    // 2FA가 없는 관리자는 정책을 켤 수 없다
    const noSelf = await request(app).patch('/admin/settings/security').set(auth(adminToken)).send({ requireMfa: true });
    expect(noSelf.status).toBe(400);
    expect(noSelf.body.code).toBe('MFA_NOT_ENABLED');
    // 일반 사용자는 설정을 못 바꾼다
    expect((await request(app).patch('/admin/settings/security').set(auth(token)).send({ requireMfa: true })).status).toBe(403);

    await enroll(adminToken);
    await forgetLastStep(adminId);
    const on = await request(app).patch('/admin/settings/security').set(auth(adminToken)).send({ requireMfa: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual({ requireMfa: true, mfaAvailable: true });
    expect((await request(app).get('/admin/settings/security').set(auth(adminToken))).body.requireMfa).toBe(true);

    // 이미 받은 토큰도, 새 로그인도 등록 전에는 막힌다
    const blocked = await request(app).get('/channels').set(auth(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    const login = await passwordStep(email);
    expect(login.mfaEnrollmentRequired).toBe(true);
    expect((await request(app).get('/users/me').set(auth(login.token))).body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await request(app).post('/tokens').set(auth(login.token)).send({ name: 'x' })).body.code).toBe('MFA_ENROLLMENT_REQUIRED');
    await expect(connect(login.token)).rejects.toThrow('MFA enrollment required');
    // 등록 관련 API는 열려 있다
    const status = await request(app).get('/users/me/2fa').set(auth(login.token));
    expect(status.status).toBe(200);
    expect(status.body.required).toBe(true);

    // 새로 가입한 사용자도 등록부터
    const fresh = await request(app).post('/auth/register').send({ email: 'fresh-mfa@example.com', password: TEST_PASSWORD, name: 'Fresh' });
    expect(fresh.body.mfaEnrollmentRequired).toBe(true);

    // 등록을 마치면 풀린다
    await enroll(login.token);
    expect((await request(app).get('/channels').set(auth(login.token))).status).toBe(200);
    const s = await connect(login.token);
    expect(s.connected).toBe(true);

    // 정책 변경은 감사 로그에 남는다
    const changed = await prisma.auditLog.findFirst({ where: { action: 'workspace.mfa_policy_changed' } });
    expect(changed).toMatchObject({ actorId: adminId, details: 'requireMfa=true' });

    // 끄면 다시 열린다
    const off = await request(app).patch('/admin/settings/security').set(auth(adminToken)).send({ requireMfa: false });
    expect(off.status).toBe(200);
    expect((await request(app).get('/channels').set(auth(fresh.body.token))).status).toBe(200);
  });

  it('2FA 정책과 보존 정책(E5)은 같은 설정 행을 쓰고 서로의 값을 덮어쓰지 않는다', async () => {
    await prisma.workspaceSetting.deleteMany();
    await setWorkspaceRetentionDays(30);
    await setRequireMfa(true);
    expect(await prisma.workspaceSetting.findMany()).toEqual([expect.objectContaining({ id: 1, messageRetentionDays: 30, requireMfa: true })]);
    await setWorkspaceRetentionDays(null);
    expect(await getRequireMfa()).toBe(true);
    await setRequireMfa(false);
    await setWorkspaceRetentionDays(7);
    expect(await getWorkspaceRetentionDays()).toBe(7);
    expect(await getRequireMfa()).toBe(false);
    // 2FA 정책이 행을 처음 만들어도 보존 정책은 무기한(null)으로 남는다
    await prisma.workspaceSetting.deleteMany();
    await setRequireMfa(true);
    expect(await getWorkspaceRetentionDays()).toBeNull();
    await prisma.workspaceSetting.deleteMany();
  });

  it('관리자 초기화: 2FA를 지우고 세션을 폐기하며 감사 로그를 남긴다', async () => {
    const email = 'reset-mfa@example.com';
    const { id, token } = await register(email);
    await enroll(token);
    const before = await prisma.session.count({ where: { userId: id, revokedAt: null } });
    expect(before).toBeGreaterThan(0);

    // 일반 사용자는 못 한다, 관리자 자신은 초기화할 수 없다
    const member = await register('member-reset-mfa@example.com');
    expect((await request(app).post(`/admin/users/${id}/2fa/reset`).set(auth(member.token))).status).toBe(403);
    expect((await request(app).post(`/admin/users/${adminId}/2fa/reset`).set(auth(adminToken))).status).toBe(400);
    // 2FA가 없는 사용자는 초기화할 것이 없다
    expect((await request(app).post(`/admin/users/${member.id}/2fa/reset`).set(auth(adminToken))).body.code).toBe('MFA_NOT_ENABLED');

    // 관리자 목록에 2FA 상태가 보인다(비밀 값은 없다)
    const list = await request(app).get('/admin/users').set(auth(adminToken));
    const listed = list.body.find((u: { id: number }) => u.id === id);
    expect(listed.mfaEnabledAt).toBeTruthy();
    expect(listed.mfaSecret).toBeUndefined();

    const reset = await request(app).post(`/admin/users/${id}/2fa/reset`).set(auth(adminToken));
    expect(reset.status).toBe(200);
    expect(reset.body.sessionsRevoked).toBe(before);
    expect((await request(app).get('/channels').set(auth(token))).status).toBe(401);
    expect(await prisma.session.count({ where: { userId: id, revokedAt: null } })).toBe(0);
    const row = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(row.mfaSecret).toBeNull();
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: id } })).toBe(0);

    const log = await prisma.auditLog.findFirst({ where: { action: 'mfa.reset_by_admin', targetId: id } });
    expect(log).toMatchObject({ actorId: adminId, details: `sessions=${before}` });
    // 이제 비밀번호만으로 로그인된다
    expect((await passwordStep(email)).token).toBeTruthy();
  });

  it('PAT 발급: 2FA 사용자는 코드를 다시 확인한다', async () => {
    const { id, token } = await register('pat-mfa@example.com');
    // 2FA가 없으면 코드 없이 발급
    expect((await request(app).post('/tokens').set(auth(token)).send({ name: 'plain' })).status).toBe(201);
    const { secret } = await enroll(token);
    await forgetLastStep(id);
    const missing = await request(app).post('/tokens').set(auth(token)).send({ name: 'needs-code' });
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('MFA_CODE_REQUIRED');
    const wrong = totp(secret, Date.now()) === '000000' ? '111111' : '000000';
    expect((await request(app).post('/tokens').set(auth(token)).send({ name: 'bad', code: wrong })).body.code).toBe('MFA_INVALID_CODE');
    const code = totp(secret, Date.now());
    const ok = await request(app).post('/tokens').set(auth(token)).send({ name: 'with-code', code });
    expect(ok.status).toBe(201);
    secretsSeen.push(ok.body.token);
    // 같은 코드로 한 번 더는 안 된다
    expect((await request(app).post('/tokens').set(auth(token)).send({ name: 'replay', code })).body.code).toBe('MFA_INVALID_CODE');
  });

  it('암호화 키가 없으면 2FA를 켤 수 없고, 이미 켠 사용자는 복구 코드로만 로그인한다', async () => {
    const email = 'nokey-mfa@example.com';
    const { token } = await register(email);
    const { secret, recoveryCodes } = await enroll(token);
    const admin2fa = await prisma.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(admin2fa.mfaEnabledAt).toBeTruthy();
    const other = await register('nokey-other-mfa@example.com');

    delete process.env.TOTP_ENCRYPTION_KEY;
    const status = await request(app).get('/users/me/2fa').set(auth(other.token));
    expect(status.body.available).toBe(false);
    const setup = await request(app).post('/users/me/2fa/setup').set(auth(other.token));
    expect(setup.status).toBe(503);
    expect(setup.body.code).toBe('MFA_UNAVAILABLE');
    // 정책을 켤 수 없고, 이미 켜져 있어도 걸지 않는다(아무도 등록할 수 없으므로)
    expect((await request(app).patch('/admin/settings/security').set(auth(adminToken)).send({ requireMfa: true })).status).toBe(503);
    await setRequireMfa(true);
    expect((await request(app).get('/channels').set(auth(other.token))).status).toBe(200);
    expect((await request(app).get('/admin/settings/security').set(auth(adminToken))).body).toEqual({ requireMfa: true, mfaAvailable: false });

    // 2FA 사용자는 키가 없어도 비밀번호만으로 들어가지 못한다
    const s = await passwordStep(email);
    expect(s.mfaRequired).toBe(true);
    const viaTotp = await request(app).post('/auth/login/2fa').send({ mfaToken: s.mfaToken, code: totp(secret, Date.now() + 30_000) });
    expect(viaTotp.status).toBe(401);
    expect(viaTotp.body.code).toBe('MFA_UNAVAILABLE');
    const viaRecovery = await request(app).post('/auth/login/2fa').send({ mfaToken: s.mfaToken, code: recoveryCodes[0] });
    expect(viaRecovery.status).toBe(200);

    // 다른 키로 바꾸면 기존 비밀을 풀 수 없다(TOTP 실패, 위변조와 같게 처리)
    process.env.TOTP_ENCRYPTION_KEY = 'f'.repeat(64);
    const s2 = await passwordStep(email);
    expect((await request(app).post('/auth/login/2fa').send({ mfaToken: s2.mfaToken, code: totp(secret, Date.now() + 30_000) })).status).toBe(401);
    // 형식이 틀린 키는 없는 것으로 본다
    process.env.TOTP_ENCRYPTION_KEY = 'short';
    expect((await request(app).get('/users/me/2fa').set(auth(other.token))).body.available).toBe(false);
  });

  it('감사 로그에 비밀 값과 코드가 남지 않는다', async () => {
    const logs = await prisma.auditLog.findMany();
    const actions = new Set(logs.map((l) => l.action));
    for (const a of ['mfa.enabled', 'mfa.disabled', 'mfa.recovery_used', 'mfa.reset_by_admin', 'auth.login_failed']) {
      expect(actions.has(a)).toBe(true);
    }
    expect(secretsSeen.length).toBeGreaterThan(20);
    const dump = JSON.stringify(logs).toLowerCase();
    for (const s of secretsSeen) {
      expect(dump).not.toContain(s.toLowerCase());
      expect(dump).not.toContain(s.toLowerCase().replace(/-/g, ''));
    }
    // TOTP 숫자 코드도 details에 남지 않는다(details는 key=value 고정 형식)
    for (const l of logs.filter((x) => x.action.startsWith('mfa.') || x.details?.includes('bad_totp'))) {
      expect(l.details ?? '').not.toMatch(/\b\d{6}\b/);
    }
  });
});
