import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as SocketClient, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app from '../app.js';
import prisma from '../db.js';
import { initializeWebSocket } from '../websocket/index.js';
import { settleBackgroundWork } from '../services/mentionService.js';
import { mcpWriteLimiter } from '../mcp/rateLimit.js';
import { processDueScheduledMessages } from '../scheduler.js';
import {
  luhnValid, validatePattern, scanContent, invalidateDlpCache, ensureBuiltinRules, resetDlpStateForTests, shutdownDlpWorker, runPattern,
} from '../services/dlpService.js';

// 데이터 유출 방지(E10): 내장·사용자 정의 규칙 CRUD, 차단·경고, 모든 쓰기 경로, ReDoS 방어, 감사 로그

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-dlp@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });

const CARD = '4111 1111 1111 1111'; // 테스트용 Visa, Luhn 통과
const CARD_BAD_LUHN = '4111 1111 1111 1112';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----';
const RRN = '900101-1234567';

describe('DLP (E10)', () => {
  let admin: TestUser, alice: TestUser, bob: TestUser, carol: TestUser;
  let channelId: number;
  let httpServer: ReturnType<typeof createServer>;
  let io: Server;
  let baseUrl: string;
  const sockets: ClientSocket[] = [];
  const mcpClients: Client[] = [];

  const rules = () => request(app).get('/admin/dlp-rules').set(auth(admin));
  const builtinId = async (key: string) => (await prisma.dlpRule.findUniqueOrThrow({ where: { key } })).id;
  const sendMsg = (u: TestUser, content: string, extra: object = {}) =>
    request(app).post(`/channels/${channelId}/messages`).set(auth(u)).send({ content, ...extra });
  const createRule = (body: object) => request(app).post('/admin/dlp-rules').set(auth(admin)).send(body);
  const auditRows = (action: string) => prisma.auditLog.findMany({ where: { action }, orderBy: { id: 'asc' } });

  async function resetRules() {
    await prisma.dlpRule.deleteMany({ where: { builtin: false } });
    await prisma.dlpRule.updateMany({ where: { builtin: true }, data: { enabled: true } });
    invalidateDlpCache();
  }

  beforeAll(async () => {
    await ensureBuiltinRules();
    await resetRules();
    await prisma.personalAccessToken.deleteMany();
    [admin, alice, bob, carol] = [await register('Dadmin'), await register('Dalice'), await register('Dbob'), await register('Dcarol')];
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    admin.token = (await request(app).post('/auth/login').send({ email: 'dadmin-dlp@example.com', password: TEST_PASSWORD })).body.token;

    channelId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'dlp-chan' })).body.id;
    await request(app).post(`/channels/${channelId}/join`).set(auth(bob));

    httpServer = createServer(app);
    io = initializeWebSocket(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await settleBackgroundWork();
    await resetRules();
    await shutdownDlpWorker();
    sockets.forEach((s) => s.disconnect());
    await Promise.all(mcpClients.map((c) => c.close().catch(() => {})));
    io.close();
    await new Promise((r) => httpServer.close(r));
  });

  beforeEach(() => mcpWriteLimiter.reset());

  describe('detectors', () => {
    it('validates card numbers with Luhn', () => {
      expect(luhnValid('4111111111111111')).toBe(true);
      expect(luhnValid('4111111111111112')).toBe(false);
      expect(luhnValid('')).toBe(false);
    });

    it('flags real-looking numbers but not Luhn failures, timestamps or ordinary digits', async () => {
      const names = async (c: string) => (await scanContent(c)).map((h) => h.name);
      expect(await names(`card ${CARD}`)).toEqual(['Credit card number']);
      expect(await names('card 4111-1111-1111-1111.')).toEqual(['Credit card number']);
      expect(await names('4111111111111111')).toEqual(['Credit card number']);
      expect(await names(`card ${CARD_BAD_LUHN}`)).toEqual([]);
      expect(await names('ts 1700000000000 and order 123456')).toEqual([]);
      expect(await names(`key ${AWS_KEY}`)).toEqual(['AWS access key']);
      expect(await names(PRIVATE_KEY)).toEqual(['Private key']);
      expect(await names('-----BEGIN PRIVATE KEY-----')).toEqual(['Private key']);
      expect(await names(`rrn ${RRN}`)).toEqual(['Korean resident registration number']);
      expect(await names('rrn 901301-1234567')).toEqual([]); // 13월은 날짜가 아니다
      expect(await names('hello world')).toEqual([]);
    });

    it('scans the whole content in one pass', async () => {
      const padded = `${'x'.repeat(39000)} ${AWS_KEY}`;
      expect((await scanContent(padded)).map((h) => h.name)).toEqual(['AWS access key']);
    });

    it('finds a card number hidden inside a longer digit run (Luhn of the whole run fails)', async () => {
      const names = async (c: string) => (await scanContent(c)).map((h) => h.name);
      expect(await names(`${CARD} 1`)).toEqual(['Credit card number']);
      expect(await names(`9 ${CARD}`)).toEqual(['Credit card number']);
      expect(await names('94111111111111111')).toEqual(['Credit card number']);
      expect(await names('4111-1111-1111-1111-1234')).toEqual(['Credit card number']);
      // 같은 길이라도 카드 번호가 아닌 긴 숫자열은 통과
      expect(await names('1700000000000 1700000000001')).toEqual([]);
    });
  });

  describe('pattern validation (ReDoS guard)', () => {
    it.each([
      ['PROJECT-\\d{4}'],
      ['\\b(?:foo|bar)\\b'],
      ['secret[_-]?key'],
      ['(?:ab){2,5}'],
      ['(\\d{3}-)?\\d{4}'],
      ['\\w+\\s*=\\s*\\w+'],
      ['^SECRET.*$'],
    ])('accepts %s', (p) => {
      expect(validatePattern(p)).toBeNull();
    });

    it.each([
      ['(a+)+$', 'nestedQuantifier'],
      ['(a*)*b', 'nestedQuantifier'],
      ['(a|aa)+', 'nestedQuantifier'],
      ['(\\w+\\s?)*$', 'nestedQuantifier'],
      ['((a{1,5}){1,5})', 'nestedQuantifier'],
      ['(a+){2,}', 'nestedQuantifier'],
      ['(.*a){10}', 'nestedQuantifier'],
      ['(a?){30}a{30}', 'nestedQuantifier'],
      ['(a|aa){1,200}x', 'nestedQuantifier'],
      ['\\w*\\w*\\w*\\w*!', 'nestedQuantifier'],
      ['(a)\\1', 'backreference'],
      ['\\d{1,100000}', 'repeatTooLarge'],
      ['(unclosed', 'invalid'],
      ['[z-a]', 'invalid'],
      ['', 'empty'],
      ['a'.repeat(201), 'tooLong'],
    ])('rejects %s as %s', (p, reason) => {
      expect(validatePattern(p)).toBe(reason);
    });

    it('rejects dangerous patterns through the API with a reason and stores nothing', async () => {
      const bad = await createRule({ name: 'evil', pattern: '(a+)+$', action: 'BLOCK' });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('DLP_PATTERN_INVALID');
      expect(bad.body.reason).toBe('nestedQuantifier');
      expect(await prisma.dlpRule.count({ where: { name: 'evil' } })).toBe(0);
      // 테스트 입력란도 같은 검증을 거친다
      const t = await request(app).post('/admin/dlp-rules/test').set(auth(admin)).send({ pattern: '(a+)+$', sample: `${'a'.repeat(30)}!` });
      expect(t.status).toBe(400);
    });
  });

  describe('admin API CRUD', () => {
    afterEach(resetRules);

    it('lists the four built-in rules, admin only', async () => {
      const res = await rules();
      expect(res.status).toBe(200);
      const keys = res.body.items.filter((r: { builtin: boolean }) => r.builtin).map((r: { key: string }) => r.key).sort();
      expect(keys).toEqual(['aws_access_key', 'credit_card', 'kr_rrn', 'private_key']);
      expect((await request(app).get('/admin/dlp-rules').set(auth(alice))).status).toBe(403);
      expect((await request(app).post('/admin/dlp-rules').set(auth(alice)).send({ name: 'x', pattern: 'x', action: 'BLOCK' })).status).toBe(403);
      expect((await request(app).get('/admin/dlp-rules')).status).toBe(401);
    });

    it('creates, reads, updates and deletes a custom rule (repeated)', async () => {
      for (let round = 1; round <= 2; round++) {
        const created = await createRule({ name: `Project code ${round}`, pattern: 'PROJECT-\\d{4}', action: 'WARN' });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ builtin: false, enabled: true, action: 'WARN', key: null });
        const id = created.body.id as number;

        expect((await rules()).body.items.some((r: { id: number }) => r.id === id)).toBe(true);

        const patched = await request(app).patch(`/admin/dlp-rules/${id}`).set(auth(admin)).send({ pattern: 'PROJ-\\d{4}', action: 'BLOCK', enabled: false });
        expect(patched.status).toBe(200);
        expect(patched.body).toMatchObject({ pattern: 'PROJ-\\d{4}', action: 'BLOCK', enabled: false });

        const del = await request(app).delete(`/admin/dlp-rules/${id}`).set(auth(admin));
        expect(del.status).toBe(200);
        expect((await rules()).body.items.some((r: { id: number }) => r.id === id)).toBe(false);
        expect((await request(app).delete(`/admin/dlp-rules/${id}`).set(auth(admin))).status).toBe(404);
        expect((await request(app).patch(`/admin/dlp-rules/${id}`).set(auth(admin)).send({ enabled: true })).status).toBe(404);
      }
    });

    it('rejects duplicate names and invalid input', async () => {
      expect((await createRule({ name: 'dup', pattern: 'a1', action: 'WARN' })).status).toBe(201);
      const dup = await createRule({ name: 'dup', pattern: 'a2', action: 'WARN' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('DLP_RULE_NAME_TAKEN');
      expect((await createRule({ name: '', pattern: 'a', action: 'WARN' })).status).toBe(400);
      expect((await createRule({ name: 'n', pattern: 'a', action: 'DROP' })).status).toBe(400);
      expect((await request(app).patch('/admin/dlp-rules/abc').set(auth(admin)).send({ enabled: true })).status).toBe(400);
      expect((await request(app).patch('/admin/dlp-rules/999999').set(auth(admin)).send({})).status).toBe(400);
    });

    it('lets built-in rules be toggled only', async () => {
      const id = await builtinId('credit_card');
      expect((await request(app).delete(`/admin/dlp-rules/${id}`).set(auth(admin))).body.code).toBe('DLP_RULE_BUILTIN');
      for (const body of [{ name: 'renamed' }, { pattern: 'x' }, { action: 'WARN' }]) {
        const res = await request(app).patch(`/admin/dlp-rules/${id}`).set(auth(admin)).send(body);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('DLP_RULE_BUILTIN');
      }
      const off = await request(app).patch(`/admin/dlp-rules/${id}`).set(auth(admin)).send({ enabled: false });
      expect(off.status).toBe(200);
      expect(off.body.enabled).toBe(false);
    });

    it('tests a pattern or a saved rule against a sample without storing anything', async () => {
      const t = (body: object) => request(app).post('/admin/dlp-rules/test').set(auth(admin)).send(body);
      expect((await t({ pattern: 'PROJECT-\\d{4}', sample: 'see PROJECT-1234' })).body).toEqual({ matched: true });
      expect((await t({ pattern: 'PROJECT-\\d{4}', sample: 'see PROJECT-12' })).body).toEqual({ matched: false });
      const cardId = await builtinId('credit_card');
      expect((await t({ ruleId: cardId, sample: CARD })).body).toEqual({ matched: true });
      expect((await t({ ruleId: cardId, sample: CARD_BAD_LUHN })).body).toEqual({ matched: false });
      expect((await t({ ruleId: 999999, sample: 'x' })).status).toBe(404);
      expect((await t({ sample: 'x' })).status).toBe(400);
      expect((await t({ pattern: 'a', ruleId: cardId, sample: 'x' })).status).toBe(400);
      expect((await t({ pattern: 'a', sample: 'x'.repeat(2001) })).status).toBe(400);
      expect((await request(app).post('/admin/dlp-rules/test').set(auth(alice)).send({ pattern: 'a', sample: 'a' })).status).toBe(403);
    });
  });

  describe('blocking and warning in channels', () => {
    afterEach(resetRules);

    it('blocks a card number with DLP_BLOCKED, stores nothing and audits only the rule name', async () => {
      const before = await prisma.message.count();
      const res = await sendMsg(alice, `my card is ${CARD}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'DLP_BLOCKED', rule: 'Credit card number' });
      expect(JSON.stringify(res.body)).not.toContain('4111');
      expect(await prisma.message.count()).toBe(before);

      const rows = await auditRows('dlp.blocked');
      const row = rows[rows.length - 1];
      expect(row).toMatchObject({ actorId: alice.id, targetName: 'Credit card number', targetType: 'message' });
      expect(JSON.stringify(row)).not.toContain('4111');

      // 카드가 아닌 숫자는 통과
      expect((await sendMsg(alice, `order ${CARD_BAD_LUHN}`)).status).toBe(201);
    });

    it('blocks every built-in secret type', async () => {
      for (const [content, rule] of [
        [`k ${AWS_KEY}`, 'AWS access key'],
        [PRIVATE_KEY, 'Private key'],
        [`n ${RRN}`, 'Korean resident registration number'],
      ]) {
        const res = await sendMsg(alice, content);
        expect(res.status).toBe(400);
        expect(res.body.rule).toBe(rule);
      }
    });

    it('blocks edits that introduce a secret and keeps the old content', async () => {
      const sent = await sendMsg(alice, 'harmless');
      const edit = await request(app).patch(`/messages/${sent.body.id}`).set(auth(alice)).send({ content: `now ${AWS_KEY}` });
      expect(edit.status).toBe(400);
      expect(edit.body.code).toBe('DLP_BLOCKED');
      expect((await prisma.message.findUniqueOrThrow({ where: { id: sent.body.id } })).content).toBe('harmless');
      expect((await request(app).patch(`/messages/${sent.body.id}`).set(auth(alice)).send({ content: 'still fine' })).status).toBe(200);
    });

    it('blocks thread replies', async () => {
      const parent = await sendMsg(alice, 'parent');
      const reply = await request(app).post(`/messages/${parent.body.id}/reply`).set(auth(bob)).send({ content: `leak ${CARD}` });
      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('DLP_BLOCKED');
    });

    it('stores WARN matches and audits the message id and rule name only', async () => {
      const rule = await createRule({ name: 'Internal code', pattern: 'PROJECT-\\d{4}', action: 'WARN' });
      expect(rule.status).toBe(201);
      const res = await sendMsg(alice, 'status of PROJECT-4242 is green');
      expect(res.status).toBe(201);
      await settleBackgroundWork();
      const rows = (await auditRows('dlp.warned')).filter((r) => r.targetId === res.body.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorId: alice.id, targetName: 'Internal code', targetType: 'message' });
      expect(JSON.stringify(rows[0])).not.toContain('4242');
      // 수정으로 다시 맞아도 경고가 한 번 더 남는다
      await request(app).patch(`/messages/${res.body.id}`).set(auth(alice)).send({ content: 'PROJECT-9999 again' });
      expect((await auditRows('dlp.warned')).filter((r) => r.targetId === res.body.id)).toHaveLength(2);
    });

    it('full CRUD loop: create rule, block, change to WARN, send, disable, resend, delete', async () => {
      const created = await createRule({ name: 'Codename', pattern: 'BLUEBIRD', action: 'BLOCK' });
      const id = created.body.id as number;
      expect((await sendMsg(alice, 'about BLUEBIRD')).body).toMatchObject({ code: 'DLP_BLOCKED', rule: 'Codename' });

      await request(app).patch(`/admin/dlp-rules/${id}`).set(auth(admin)).send({ action: 'WARN' });
      const warned = await sendMsg(alice, 'about BLUEBIRD');
      expect(warned.status).toBe(201);

      await request(app).patch(`/admin/dlp-rules/${id}`).set(auth(admin)).send({ action: 'BLOCK', enabled: false });
      expect((await sendMsg(alice, 'about BLUEBIRD')).status).toBe(201);

      await request(app).patch(`/admin/dlp-rules/${id}`).set(auth(admin)).send({ enabled: true });
      expect((await sendMsg(alice, 'about BLUEBIRD')).status).toBe(400);

      await request(app).delete(`/admin/dlp-rules/${id}`).set(auth(admin));
      expect((await sendMsg(alice, 'about BLUEBIRD')).status).toBe(201);

      // 규칙 변경도 감사 로그에 남는다
      const actions = (await prisma.auditLog.findMany({ where: { targetType: 'dlp_rule', targetId: id } })).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['dlp.rule_created', 'dlp.rule_updated', 'dlp.rule_deleted']));
    });

    it('turning a built-in rule off lets the content through, and back on blocks again', async () => {
      const id = await builtinId('credit_card');
      await request(app).patch(`/admin/dlp-rules/${id}`).set(auth(admin)).send({ enabled: false });
      expect((await sendMsg(alice, CARD)).status).toBe(201);
      await request(app).patch(`/admin/dlp-rules/${id}`).set(auth(admin)).send({ enabled: true });
      expect((await sendMsg(alice, CARD)).status).toBe(400);
    });

    it('BLOCK wins over WARN when both match', async () => {
      await createRule({ name: 'Warn on card word', pattern: 'card', action: 'WARN' });
      const res = await sendMsg(alice, `card ${CARD}`);
      expect(res.status).toBe(400);
      expect(res.body.rule).toBe('Credit card number');
    });
  });

  describe('direct messages', () => {
    afterEach(resetRules);

    it('blocks and edits 1:1 DMs and DM thread replies', async () => {
      const blocked = await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: `card ${CARD}` });
      expect(blocked.status).toBe(400);
      expect(blocked.body).toMatchObject({ code: 'DLP_BLOCKED', rule: 'Credit card number' });

      const ok = await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'hello' });
      expect(ok.status).toBe(201);
      const edit = await request(app).patch(`/dms/messages/${ok.body.id}`).set(auth(alice)).send({ content: AWS_KEY });
      expect(edit.status).toBe(400);
      expect(edit.body.code).toBe('DLP_BLOCKED');
      expect((await prisma.directMessage.findUniqueOrThrow({ where: { id: ok.body.id } })).content).toBe('hello');

      const reply = await request(app).post(`/dms/messages/${ok.body.id}/reply`).set(auth(bob)).send({ content: PRIVATE_KEY });
      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('DLP_BLOCKED');
      expect((await request(app).post(`/dms/messages/${ok.body.id}/reply`).set(auth(bob)).send({ content: 'fine' })).status).toBe(201);

      const warnRule = await createRule({ name: 'DM warn', pattern: 'BLUEBIRD', action: 'WARN' });
      const warned = await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'BLUEBIRD' });
      expect(warned.status).toBe(201);
      await settleBackgroundWork();
      const rows = (await auditRows('dlp.warned')).filter((r) => r.targetType === 'direct_message' && r.targetId === warned.body.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].targetName).toBe(warnRule.body.name);
    });

    it('blocks group DM messages, replies and edits', async () => {
      const group = await request(app).post('/dms/groups').set(auth(alice)).send({ userIds: [bob.id, carol.id] });
      expect(group.status).toBe(201);
      const gid = group.body.id ?? group.body.group?.id;
      const blocked = await request(app).post(`/dms/groups/${gid}/messages`).set(auth(alice)).send({ content: `card ${CARD}` });
      expect(blocked.status).toBe(400);
      expect(blocked.body).toMatchObject({ code: 'DLP_BLOCKED', rule: 'Credit card number' });

      const ok = await request(app).post(`/dms/groups/${gid}/messages`).set(auth(alice)).send({ content: 'hi all' });
      expect(ok.status).toBe(201);
      const reply = await request(app).post(`/dms/messages/${ok.body.id}/reply`).set(auth(bob)).send({ content: AWS_KEY });
      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('DLP_BLOCKED');
      const edit = await request(app).patch(`/dms/messages/${ok.body.id}`).set(auth(alice)).send({ content: AWS_KEY });
      expect(edit.status).toBe(400);
      expect(edit.body.code).toBe('DLP_BLOCKED');
    });
  });

  describe('other write paths', () => {
    afterEach(resetRules);

    async function connect(u: TestUser): Promise<ClientSocket> {
      const socket = SocketClient(baseUrl, { auth: { token: u.token } });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      return socket;
    }

    it('blocks socket message:send through the ack with code and rule', async () => {
      const socket = await connect(alice);
      await new Promise<boolean>((resolve) => socket.emit('join:channel', channelId, resolve));
      const before = await prisma.message.count();
      const ack = await new Promise<{ error?: string; code?: string; rule?: string }>((resolve) =>
        socket.emit('message:send', { channelId, content: `card ${CARD}` }, resolve));
      expect(ack).toMatchObject({ code: 'DLP_BLOCKED', rule: 'Credit card number' });
      expect(await prisma.message.count()).toBe(before);
      const ok = await new Promise<{ error?: string }>((resolve) => socket.emit('message:send', { channelId, content: 'fine' }, resolve));
      expect(ok.error).toBeUndefined();
    });

    it('blocks socket dmgroup:send with code and rule', async () => {
      const group = await request(app).post('/dms/groups').set(auth(alice)).send({ userIds: [bob.id, carol.id] });
      const gid = group.body.id ?? group.body.group?.id;
      const socket = await connect(alice);
      const ack = await new Promise<{ code?: string; rule?: string }>((resolve) =>
        socket.emit('dmgroup:send', { groupId: gid, content: AWS_KEY }, resolve));
      expect(ack).toMatchObject({ code: 'DLP_BLOCKED', rule: 'AWS access key' });
    });

    it('blocks MCP send_message, edit_message and send_dm with the rule name', async () => {
      const token = (await request(app).post('/tokens').set(auth(alice)).send({ name: 'claude', scopes: ['channels:read', 'chat:write', 'im:write', 'users:read'] })).body.token;
      const client = new Client({ name: 'jest', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      mcpClients.push(client);
      const call = async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args });
        return { isError: res.isError === true, text: (res.content as Array<{ text: string }>)[0]?.text ?? '' };
      };

      const blocked = await call('send_message', { channelId, content: `card ${CARD}` });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain('Credit card number');
      expect(blocked.text).not.toContain('4111');

      const ok = await call('send_message', { channelId, content: 'from claude' });
      expect(ok.isError).toBe(false);
      const id = JSON.parse(ok.text).id;
      expect((await call('edit_message', { messageId: id, content: AWS_KEY })).isError).toBe(true);
      expect((await call('send_dm', { userId: bob.id, content: PRIVATE_KEY })).isError).toBe(true);
    });

    it('blocks incoming webhooks and scheduled messages (create, edit, send now)', async () => {
      await request(app).post(`/channels/${channelId}/join`).set(auth(admin));
      const hook = await request(app).post('/webhooks').set(auth(admin)).send({ name: 'ci', channelId });
      expect(hook.status).toBe(201);
      const hookToken = hook.body.token as string;
      const blocked = await request(app).post(`/webhooks/${hookToken}`).send({ content: `card ${CARD}` });
      expect(blocked.status).toBe(400);
      expect(blocked.body.code).toBe('DLP_BLOCKED');
      expect((await request(app).post(`/webhooks/${hookToken}`).send({ content: 'build ok' })).status).toBe(201);

      const when = new Date(Date.now() + 3600_000).toISOString();
      const bad = await request(app).post('/messages/schedule').set(auth(alice)).send({ content: AWS_KEY, channelId, scheduledAt: when });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('DLP_BLOCKED');
      const good = await request(app).post('/messages/schedule').set(auth(alice)).send({ content: 'later', channelId, scheduledAt: when });
      expect(good.status).toBe(201);
      const edit = await request(app).patch(`/messages/scheduled/${good.body.id}`).set(auth(alice)).send({ content: AWS_KEY });
      expect(edit.status).toBe(400);
      expect(edit.body.code).toBe('DLP_BLOCKED');

      // 예약한 뒤에 규칙이 생기면 바로 보내기도 막힌다
      await createRule({ name: 'Later', pattern: 'later', action: 'BLOCK' });
      const now = await request(app).post(`/messages/scheduled/${good.body.id}/send`).set(auth(alice));
      expect(now.status).toBe(400);
      expect(now.body.code).toBe('DLP_BLOCKED');
    });
  });

  describe('custom patterns run in a worker with a time limit', () => {
    afterEach(async () => {
      await resetRules();
      resetDlpStateForTests();
    });

    // 검증을 통과하지만 긴 입력에서는 O(n^2)로 느려지는 패턴(인접한 무한 반복 2개)
    const SLOW = '\\w*\\w*!';
    const LONG = 'a'.repeat(30000);

    it('anchors apply to the original message body', async () => {
      await createRule({ name: 'Starts with SECRET', pattern: '^SECRET', action: 'BLOCK' });
      expect((await sendMsg(alice, `${'x'.repeat(5000)}SECRET`)).status).toBe(201);
      expect((await sendMsg(alice, 'SECRET stuff')).status).toBe(400);
      // 4096자 넘는 본문에서도 끝 앵커가 원문 끝 기준
      await createRule({ name: 'Ends with END', pattern: 'END$', action: 'BLOCK' });
      expect((await sendMsg(alice, `${'x'.repeat(10000)}END`)).status).toBe(400);
      expect((await sendMsg(alice, `END${'x'.repeat(10000)}`)).status).toBe(201);
    });

    it('lets the message through on timeout, audits the rule name, and recovers the worker', async () => {
      const slow = await createRule({ name: 'Slow rule', pattern: SLOW, action: 'BLOCK' });
      expect(slow.status).toBe(201);
      const started = Date.now();
      const res = await sendMsg(alice, LONG);
      expect(res.status).toBe(201);
      expect(Date.now() - started).toBeLessThan(5000);
      const rows = await auditRows('dlp.rule_timeout');
      expect(rows[rows.length - 1]).toMatchObject({ targetName: 'Slow rule', targetType: 'dlp_rule', targetId: slow.body.id, actorId: alice.id });
      expect(JSON.stringify(rows[rows.length - 1])).not.toContain('aaaa');

      // 워커가 다시 만들어져 다른 규칙은 계속 동작한다
      await createRule({ name: 'Fast rule', pattern: 'ZEPPELIN', action: 'BLOCK' });
      expect((await sendMsg(alice, 'a ZEPPELIN!')).status).toBe(400);
      expect(await runPattern('abc', 'xxabcxx')).toEqual({ matched: true });
    });

    it('turns a rule off after three timeouts in a row and audits it', async () => {
      const slow = await createRule({ name: 'Slow rule 2', pattern: SLOW, action: 'BLOCK' });
      for (let i = 0; i < 3; i++) expect((await sendMsg(alice, LONG)).status).toBe(201);
      expect((await auditRows('dlp.rule_timeout')).filter((r) => r.targetId === slow.body.id)).toHaveLength(3);
      const disabled = (await auditRows('dlp.rule_auto_disabled')).filter((r) => r.targetId === slow.body.id);
      expect(disabled).toHaveLength(1);
      expect(disabled[0].targetName).toBe('Slow rule 2');
      expect((await prisma.dlpRule.findUniqueOrThrow({ where: { id: slow.body.id } })).enabled).toBe(false);
      // 꺼졌으니 더 이상 시간 초과가 쌓이지 않는다
      await sendMsg(alice, LONG);
      expect((await auditRows('dlp.rule_timeout')).filter((r) => r.targetId === slow.body.id)).toHaveLength(3);
    });

    it('resets the timeout streak when a check completes in time', async () => {
      const slow = await createRule({ name: 'Slow rule 3', pattern: SLOW, action: 'BLOCK' });
      await sendMsg(alice, LONG);
      await sendMsg(alice, LONG);
      expect((await sendMsg(alice, 'short message')).status).toBe(201); // 빨리 끝나면 연속 횟수가 0으로
      await sendMsg(alice, LONG);
      await sendMsg(alice, LONG);
      expect((await prisma.dlpRule.findUniqueOrThrow({ where: { id: slow.body.id } })).enabled).toBe(true);
    });

    it('uses the same worker path for the test endpoint', async () => {
      const t = await request(app).post('/admin/dlp-rules/test').set(auth(admin)).send({ pattern: SLOW, sample: 'a'.repeat(2000) });
      expect(t.status).toBe(200);
      expect(t.body.matched).toBe(false);
    });
  });

  describe('built-in rule safety', () => {
    afterEach(async () => {
      await prisma.dlpRule.deleteMany({ where: { builtin: false } });
      await ensureBuiltinRules();
      await resetRules();
      resetDlpStateForTests();
    });

    it('rejects custom rule names that collide with built-in names (case-insensitive)', async () => {
      const dup = await createRule({ name: 'credit CARD number', pattern: 'zzz', action: 'WARN' });
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe('DLP_RULE_NAME_TAKEN');
      const ok = await createRule({ name: 'mine', pattern: 'zzz', action: 'WARN' });
      const rename = await request(app).patch(`/admin/dlp-rules/${ok.body.id}`).set(auth(admin)).send({ name: ' aws ACCESS key ' });
      expect(rename.status).toBe(409);
    });

    it('still blocks (and never 500s) when a built-in row could not be created', async () => {
      // 내장 규칙 이름을 선점한 행(API가 막는 상황을 DB로 직접 만든다)
      await prisma.dlpRule.delete({ where: { key: 'aws_access_key' } });
      await prisma.dlpRule.create({ data: { name: 'AWS access key', pattern: 'zzz', action: 'WARN' } });
      resetDlpStateForTests();
      const res = await sendMsg(alice, `k ${AWS_KEY}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DLP_BLOCKED');
    });
  });

  describe('scheduled messages blocked at send time', () => {
    afterEach(resetRules);

    it('marks the schedule as failed, tells the sender and keeps it listed until deleted', async () => {
      const when = new Date(Date.now() + 3600_000).toISOString();
      const created = await request(app).post('/messages/schedule').set(auth(alice)).send({ content: 'launch BLUEBIRD tonight', channelId, scheduledAt: when });
      expect(created.status).toBe(201);
      // 예약한 뒤 규칙이 생기고 발송 시각이 지났다
      await createRule({ name: 'Codename 2', pattern: 'BLUEBIRD', action: 'BLOCK' });
      await prisma.scheduledMessage.update({ where: { id: created.body.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });

      const socket = SocketClient(baseUrl, { auth: { token: alice.token } });
      sockets.push(socket);
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      const failed = new Promise<{ id: number; rule: string; code: string }>((resolve) => socket.once('scheduled:failed', resolve));
      const before = await prisma.message.count({ where: { content: 'launch BLUEBIRD tonight' } });
      await processDueScheduledMessages();
      expect(await failed).toMatchObject({ id: created.body.id, code: 'DLP_BLOCKED', rule: 'Codename 2' });
      expect(await prisma.message.count({ where: { content: 'launch BLUEBIRD tonight' } })).toBe(before);

      const row = await prisma.scheduledMessage.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(row.sent).toBe(true);
      expect(row.failedAt).not.toBeNull();
      expect(row.failReason).toBe('Codename 2');

      const list = await request(app).get('/messages/scheduled').set(auth(alice));
      expect(list.body.find((m: { id: number }) => m.id === created.body.id)).toMatchObject({ failReason: 'Codename 2' });
      expect((await request(app).post(`/messages/scheduled/${created.body.id}/send`).set(auth(alice))).status).toBe(400);
      expect((await request(app).delete(`/messages/scheduled/${created.body.id}`).set(auth(alice))).status).toBe(200);
      expect((await request(app).get('/messages/scheduled').set(auth(alice))).body.some((m: { id: number }) => m.id === created.body.id)).toBe(false);
    });
  });

  describe('rule cache', () => {
    afterEach(resetRules);

    it('sees rule changes made through the API immediately', async () => {
      expect((await sendMsg(alice, 'zeppelin')).status).toBe(201);
      const created = await createRule({ name: 'Zeppelin', pattern: 'zeppelin', action: 'BLOCK' });
      expect((await sendMsg(alice, 'zeppelin')).status).toBe(400);
      await request(app).delete(`/admin/dlp-rules/${created.body.id}`).set(auth(admin));
      expect((await sendMsg(alice, 'zeppelin')).status).toBe(201);
    });
  });
});
