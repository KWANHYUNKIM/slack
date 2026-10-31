import { TEST_PASSWORD } from './test-constants.js';
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app from '../app.js';
import prisma from '../db.js';
import { mcpWriteLimiter } from '../mcp/rateLimit.js';
import { MAX_READ_FILE_BYTES } from '../mcp/fileTools.js';

interface TestUser { id: number; token: string; name: string }

async function register(name: string): Promise<TestUser> {
  const res = await request(app)
    .post('/auth/register')
    .send({ email: `${name.toLowerCase()}-mcpsf@example.com`, password: TEST_PASSWORD, name });
  return { id: res.body.user.id, token: res.body.token, name };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const BASE = ['channels:read', 'channels:history', 'users:read'];
const SEARCH = [...BASE, 'search:read'];
const FILES = [...BASE, 'files:read'];
const ALL = [...BASE, 'search:read', 'files:read'];
const ALL_DM = [...ALL, 'im:history'];

async function createToken(u: TestUser, scopes?: string[]) {
  const res = await request(app).post('/tokens').set(auth(u)).send({ name: 'claude', ...(scopes && { scopes }) });
  expect(res.status).toBe(201);
  return res.body as { id: number; token: string; scopes: string[] };
}

describe('MCP search, files, resources and prompts (mcp-3)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let baseUrl: string;
  let alice: TestUser, bob: TestUser, carol: TestUser, gina: TestUser;
  let pubId: number;     // alice, bob, gina(guest)
  let privId: number;    // bob only
  const clients: Client[] = [];
  const uploadedIds: number[] = [];

  async function connectClient(token: string): Promise<Client> {
    const client = new Client({ name: 'jest', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: bearer(token) } }));
    clients.push(client);
    return client;
  }
  const clientFor = async (u: TestUser, scopes: string[] = ALL) => connectClient((await createToken(u, scopes)).token);

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) };
  }

  async function postMessage(u: TestUser, channelId: number, content: string): Promise<number> {
    const res = await request(app).post(`/channels/${channelId}/messages`).set(auth(u)).send({ content });
    expect(res.status).toBe(201);
    return res.body.id;
  }

  async function upload(u: TestUser, name: string, body: Buffer, contentType: string, messageId?: number): Promise<number> {
    let req = request(app).post('/files').set(auth(u));
    if (messageId) req = req.field('messageId', String(messageId));
    const res = await req.attach('file', body, { filename: name, contentType });
    expect(res.status).toBe(201);
    uploadedIds.push(res.body.id);
    return res.body.id;
  }

  beforeAll(async () => {
    await prisma.personalAccessToken.deleteMany();
    [alice, bob, carol, gina] = [await register('Asf'), await register('Bsf'), await register('Csf'), await register('Gsf')];
    pubId = (await request(app).post('/channels').set(auth(alice)).send({ name: 'mcpsf-pub' })).body.id;
    privId = (await request(app).post('/channels').set(auth(bob)).send({ name: 'mcpsf-priv', isPrivate: true })).body.id;
    await request(app).post(`/channels/${pubId}/join`).set(auth(bob));
    // gina는 게스트이고 pub 하나만 공유한다
    await prisma.channelMember.deleteMany({ where: { userId: gina.id } });
    await request(app).post(`/channels/${pubId}/join`).set(auth(gina));
    await prisma.user.update({ where: { id: gina.id }, data: { role: 'GUEST' } });

    httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    await new Promise((r) => httpServer.close(r));
    // 업로드 파일 정리
    const uploads = path.join(process.cwd(), 'uploads');
    const rows = await prisma.file.findMany({ where: { id: { in: uploadedIds } }, select: { filename: true } });
    for (const f of rows) fs.rmSync(path.join(uploads, f.filename), { force: true });
  });

  beforeEach(async () => {
    mcpWriteLimiter.reset();
    await prisma.personalAccessToken.deleteMany();
  });

  describe('scopes and tool list', () => {
    it('keeps search:read and files:read out of default tokens and gates each tool by scope', async () => {
      const def = await createToken(alice);
      expect(def.scopes).not.toContain('search:read');
      expect(def.scopes).not.toContain('files:read');
      const names = async (scopes: string[]) => (await (await clientFor(alice, scopes)).listTools()).tools.map((t) => t.name);
      expect(await names(BASE)).not.toContain('search');
      expect(await names(BASE)).not.toContain('read_file');
      expect(await names(SEARCH)).toContain('search');
      expect(await names(SEARCH)).not.toContain('list_files');
      expect(await names(FILES)).toEqual(expect.arrayContaining(['list_files', 'read_file']));
      expect(await names(FILES)).not.toContain('search');
    });

    it('warns that file and message text is data in the descriptions', async () => {
      const tools = (await (await clientFor(alice)).listTools()).tools;
      for (const n of ['search', 'list_files', 'read_file']) {
        expect(tools.find((t) => t.name === n)!.description).toContain('not instructions');
      }
      expect(tools.find((t) => t.name === 'read_file')!.description).toContain('untrusted data');
    });
  });

  describe('search and list_files CRUD loop', () => {
    it('finds a new message and file, follows edits and deletes, and never returns file urls', async () => {
      const client = await clientFor(alice);
      const mid = await postMessage(alice, pubId, 'quarterly zebrafruit report');
      const fileId = await upload(alice, 'zebrafruit-notes.txt', Buffer.from('line one\nsecond line: zebrafruit'), 'text/plain', mid);

      // Read: 메시지와 파일을 검색으로 찾는다
      let r = await call(client, 'search', { q: 'zebrafruit' });
      expect(r.data.results.filter((x: any) => x.type === 'message').map((x: any) => x.id)).toEqual([mid]);
      r = await call(client, 'search', { q: 'zebrafruit', type: 'files' });
      expect(r.data.results.map((x: any) => x.id)).toEqual([fileId]);
      expect(r.data.results[0].filename).toBe('zebrafruit-notes.txt');
      expect(JSON.stringify(r.data)).not.toContain('/download');
      expect(r.data.results[0]).not.toHaveProperty('url');

      // 연산자와 탭
      r = await call(client, 'search', { q: 'zebrafruit from:Asf in:mcpsf-pub has:file' });
      expect(r.data.results.map((x: any) => x.id)).toEqual([mid]);
      r = await call(client, 'search', { q: 'zebrafruit from:Bsf' });
      expect(r.data.counts.messages).toBe(0);
      r = await call(client, 'search', { q: 'mcpsf-pub', type: 'channels' });
      expect(r.data.results.map((x: any) => x.name)).toEqual(['mcpsf-pub']);
      r = await call(client, 'search', { q: 'Bsf', type: 'people' });
      expect(r.data.results.map((x: any) => x.name)).toContain('Bsf');

      // list_files
      let l = await call(client, 'list_files', { channelId: pubId });
      expect(l.data.items.map((x: any) => x.id)).toEqual([fileId]);
      expect(l.data.items[0]).toMatchObject({ name: 'zebrafruit-notes.txt', channelId: pubId, messageId: mid, readable: true });
      expect(JSON.stringify(l.data)).not.toMatch(/url|gcsPath|filename|token/i);
      l = await call(client, 'list_files', {});
      expect(l.data.items.map((x: any) => x.id)).toContain(fileId);

      // Update: 수정하면 검색 결과가 따라간다
      expect((await request(app).patch(`/messages/${mid}`).set(auth(alice)).send({ content: 'quarterly kiwifruit report' })).status).toBe(200);
      r = await call(client, 'search', { q: 'zebrafruit', type: 'messages' });
      expect(r.data.results).toHaveLength(0);
      r = await call(client, 'search', { q: 'kiwifruit', type: 'messages' });
      expect(r.data.results.map((x: any) => x.id)).toEqual([mid]);

      // Delete: 지우면 메시지도, 메시지에 붙은 파일도 사라진다
      expect((await request(app).delete(`/messages/${mid}`).set(auth(alice))).status).toBe(200);
      r = await call(client, 'search', { q: 'kiwifruit' });
      expect(r.data.results).toHaveLength(0);
      r = await call(client, 'search', { q: 'zebrafruit', type: 'files' });
      expect(r.data.results).toHaveLength(0);
      l = await call(client, 'list_files', { channelId: pubId });
      expect(l.data.items).toHaveLength(0);
      // 다른 멤버는 더 이상 읽지 못한다(올린 사람 본인의 미첨부 파일 규칙은 PR #52 그대로다)
      expect((await call(await clientFor(bob), 'read_file', { fileId })).isError).toBe(true);

      // Create again: 같은 흐름이 반복해서 된다
      const mid2 = await postMessage(alice, pubId, 'second kiwifruit note');
      r = await call(client, 'search', { q: 'kiwifruit' });
      expect(r.data.results.map((x: any) => x.id)).toEqual([mid2]);
    });

    it('rejects bad queries with a tool error and pages with nextCursor', async () => {
      const client = await clientFor(alice);
      expect((await call(client, 'search', { q: 'a' })).text).toMatch(/at least 2 characters/);
      expect((await call(client, 'search', { q: 'x'.repeat(201) })).isError).toBe(true);
      for (let i = 0; i < 3; i++) await postMessage(alice, pubId, `pagerword entry ${i}`);
      const p1 = await call(client, 'search', { q: 'pagerword', limit: 2, sort: 'recent' });
      expect(p1.data.results).toHaveLength(2);
      expect(p1.data.nextCursor).toBeTruthy();
      const p2 = await call(client, 'search', { q: 'pagerword', limit: 2, sort: 'recent', cursor: p1.data.nextCursor });
      expect(p2.data.results).toHaveLength(1);
      expect(p2.data.nextCursor).toBeNull();
    });
  });

  describe('REST and MCP agree', () => {
    it('returns the same results as GET /search for the same queries (without file urls)', async () => {
      await postMessage(alice, pubId, 'parity rhubarb from alice');
      await postMessage(bob, pubId, 'parity rhubarb from bob');
      const fid = await upload(bob, 'rhubarb.txt', Buffer.from('rhubarb'), 'text/plain');
      expect(fid).toBeGreaterThan(0);
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'parity rhubarb in dm' });
      const client = await clientFor(alice, ALL_DM);

      const strip = (body: any) => ({
        ...body,
        results: body.results.map(({ url, ...rest }: any) => rest),
      });
      const queries: Array<Record<string, string | number>> = [
        { q: 'rhubarb' },
        { q: 'rhubarb', sort: 'recent' },
        { q: 'rhubarb from:Bsf' },
        { q: 'rhubarb', type: 'dms' },
        { q: 'rhubarb', type: 'files' },
        { q: 'mcpsf', type: 'channels' },
        { q: 'sf', type: 'people' },
        { q: 'rhubarb', channelId: pubId },
        { q: 'rhubarb after:2000-01-01 before:2100-01-01' },
      ];
      for (const q of queries) {
        const rest = await request(app).get('/search').set(auth(alice)).query(q);
        expect(rest.status).toBe(200);
        const mcp = await call(client, 'search', q);
        const { dmsIncluded, ...mcpBody } = mcp.data;
        expect(dmsIncluded).toBe(true);
        // snapshot 시각이 커서에 들어 있어 nextCursor는 요청마다 다를 수 있다
        const { nextCursor: _a, ...a } = strip(rest.body);
        const { nextCursor: _b, ...b } = mcpBody;
        expect(b).toEqual(JSON.parse(JSON.stringify(a)));
      }
    });
  });

  describe('permissions', () => {
    it('hides private channels from non-members in search, list_files and read_file', async () => {
      const mid = await postMessage(bob, privId, 'privatepear secret plans');
      const fileId = await upload(bob, 'privatepear.txt', Buffer.from('privatepear body'), 'text/plain', mid);
      const asAlice = await clientFor(alice);
      const asBob = await clientFor(bob);

      expect((await call(asBob, 'search', { q: 'privatepear' })).data.results.map((x: any) => x.id)).toContain(mid);
      expect((await call(asBob, 'read_file', { fileId })).data.content).toBe('privatepear body');

      const a = await call(asAlice, 'search', { q: 'privatepear' });
      expect(a.data.results).toHaveLength(0);
      expect((await call(asAlice, 'search', { q: 'privatepear', type: 'files' })).data.results).toHaveLength(0);
      expect((await call(asAlice, 'search', { q: 'privatepear', channelId: privId })).data.results).toHaveLength(0);
      expect((await call(asAlice, 'search', { q: 'mcpsf-priv', type: 'channels' })).data.results).toHaveLength(0);
      const same = 'Channel not found or not accessible';
      expect((await call(asAlice, 'list_files', { channelId: privId })).text).toBe(same);
      expect((await call(asAlice, 'list_files', { channelId: 999999 })).text).toBe(same);
      expect((await call(asAlice, 'list_files', {})).data.items.map((x: any) => x.id)).not.toContain(fileId);
      const denied = await call(asAlice, 'read_file', { fileId });
      const missing = await call(asAlice, 'read_file', { fileId: 999999 });
      expect(denied.isError).toBe(true);
      expect(denied.text).toBe(missing.text);
    });

    it('keeps guests inside the channels they share', async () => {
      await postMessage(alice, pubId, 'guestvisible grape');
      const aliceOnly = (await request(app).post('/channels').set(auth(alice)).send({ name: 'mcpsf-alice-only' })).body.id;
      await postMessage(alice, aliceOnly, 'guesthidden grape');
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: gina.id, content: 'dm guestdm grape' });
      // carol과 gina는 공유 채널이 없다: 예전 DM이 있어도 게스트에게는 보이면 안 된다
      await prisma.directMessage.create({ data: { content: 'old carol grape', fromUserId: carol.id, toUserId: gina.id } });
      const asGina = await clientFor(gina, ALL_DM);
      const r = await call(asGina, 'search', { q: 'grape' });
      expect(r.data.results.map((x: any) => x.content).sort()).toEqual(['dm guestdm grape', 'guestvisible grape']);
      // 게스트는 공유 채널이 없는 사람과의 DM이나 자기가 속하지 않은 채널을 볼 수 없다
      expect((await call(asGina, 'search', { q: 'mcpsf-alice-only', type: 'channels' })).data.results).toHaveLength(0);
      expect((await call(asGina, 'list_files', { userId: carol.id })).isError).toBe(true);
      expect((await call(asGina, 'list_files', { channelId: aliceOnly })).isError).toBe(true);
    });

    it('includes DM results and DM files only with the im:history scope', async () => {
      await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'dmsecret mango' });
      const dmFile = await upload(alice, 'dmsecret.txt', Buffer.from('dmsecret contents'), 'text/plain');
      const sent = await request(app).post('/dms').set(auth(alice)).send({ toUserId: bob.id, content: 'with file', fileIds: [dmFile] });
      expect(sent.status).toBe(201);

      const noDm = await clientFor(alice, ALL);
      const withDm = await clientFor(alice, ALL_DM);

      let r = await call(noDm, 'search', { q: 'dmsecret mango' });
      expect(r.data.results).toHaveLength(0);
      expect(r.data.dmsIncluded).toBe(false);
      expect((await call(noDm, 'search', { q: 'dmsecret mango', type: 'dms' })).text).toMatch(/im:history/);
      expect((await call(noDm, 'search', { q: 'dmsecret', type: 'files' })).data.results).toHaveLength(0);
      expect((await call(noDm, 'list_files', { userId: bob.id })).text).toMatch(/im:history/);
      expect((await call(noDm, 'read_file', { fileId: dmFile })).text).toBe('File not found or not accessible');

      r = await call(withDm, 'search', { q: 'dmsecret mango' });
      expect(r.data.results.map((x: any) => x.type)).toEqual(['dm']);
      expect((await call(withDm, 'search', { q: 'dmsecret', type: 'files' })).data.results.map((x: any) => x.id)).toEqual([dmFile]);
      expect((await call(withDm, 'list_files', { userId: bob.id })).data.items.map((x: any) => x.id)).toEqual([dmFile]);
      expect((await call(withDm, 'read_file', { fileId: dmFile })).data.content).toBe('dmsecret contents');

      // 참여자가 아닌 carol은 같은 id를 알아도 찾지도 읽지도 못한다
      const asCarol = await clientFor(carol, ALL_DM);
      expect((await call(asCarol, 'search', { q: 'dmsecret' })).data.results).toHaveLength(0);
      expect((await call(asCarol, 'read_file', { fileId: dmFile })).isError).toBe(true);
      expect((await call(asCarol, 'list_files', { userId: alice.id })).data.items).toHaveLength(0);

      // DM 메시지를 지우면 파일도 목록에서 빠진다
      const dmId = sent.body.id;
      expect((await request(app).delete(`/dms/messages/${dmId}`).set(auth(alice))).status).toBeLessThan(300);
      expect((await call(withDm, 'list_files', { userId: bob.id })).data.items).toHaveLength(0);
      expect((await call(withDm, 'read_file', { fileId: dmFile })).isError).toBe(true);
    });
  });

  describe('read_file', () => {
    it('returns text content, and metadata only for oversized, binary and non-text files', async () => {
      const client = await clientFor(alice);
      const mid = await postMessage(alice, pubId, 'files for read_file');
      const small = await upload(alice, 'small.json', Buffer.from('{"hello":"세계"}'), 'application/json', mid);
      const edge = await upload(alice, 'edge.txt', Buffer.alloc(MAX_READ_FILE_BYTES, 'a'), 'text/plain', mid);
      const big = await upload(alice, 'big.txt', Buffer.alloc(MAX_READ_FILE_BYTES + 1, 'b'), 'text/plain', mid);
      const nul = await upload(alice, 'nul.txt', Buffer.from([0x68, 0x69, 0x00, 0x01, 0x02]), 'text/plain', mid);
      const png = await upload(
        alice, 'pic.png',
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
        'image/png', mid,
      );

      let r = await call(client, 'read_file', { fileId: small });
      expect(r.data).toMatchObject({ name: 'small.json', content: '{"hello":"세계"}', reason: null });
      expect(JSON.stringify(r.data)).not.toMatch(/url|gcsPath|token/i);

      r = await call(client, 'read_file', { fileId: edge });
      expect(r.data.content).toHaveLength(MAX_READ_FILE_BYTES);

      r = await call(client, 'read_file', { fileId: big });
      expect(r.data).toMatchObject({ name: 'big.txt', content: null, reason: 'too_large', maxBytes: MAX_READ_FILE_BYTES, size: MAX_READ_FILE_BYTES + 1 });

      r = await call(client, 'read_file', { fileId: nul });
      expect(r.data).toMatchObject({ content: null, reason: 'not_text' });

      r = await call(client, 'read_file', { fileId: png });
      expect(r.data).toMatchObject({ mimetype: 'image/png', content: null, reason: 'not_text' });

      // DB의 size가 실제보다 작게 적혀 있어도 읽는 양은 상한을 넘지 않는다
      await prisma.file.update({ where: { id: big }, data: { size: 10 } });
      r = await call(client, 'read_file', { fileId: big });
      expect(r.data).toMatchObject({ content: null, reason: 'too_large' });

      const l = await call(client, 'list_files', { channelId: pubId });
      const byId = new Map<number, any>(l.data.items.map((x: any) => [x.id, x]));
      expect(byId.get(small).readable).toBe(true);
      expect(byId.get(png).readable).toBe(false);
    });

    it('does not read unattached files of other users and rejects invalid ids', async () => {
      const mine = await upload(alice, 'unattached.txt', Buffer.from('mine only'), 'text/plain');
      const asAlice = await clientFor(alice);
      const asBob = await clientFor(bob);
      expect((await call(asAlice, 'read_file', { fileId: mine })).data.content).toBe('mine only');
      expect((await call(asBob, 'read_file', { fileId: mine })).isError).toBe(true);
      await expect(asAlice.callTool({ name: 'read_file', arguments: { fileId: -1 } })).resolves.toMatchObject({ isError: true });
    });
  });

  describe('resources and prompts', () => {
    it('serves channel and thread resources with the same permission rules', async () => {
      const mid = await postMessage(alice, pubId, 'resource kumquat');
      await request(app).post(`/channels/${pubId}/messages`).set(auth(bob)).send({ content: 'reply kumquat', threadId: mid });
      const asAlice = await clientFor(alice);

      const templates = (await asAlice.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate).sort();
      expect(templates).toEqual(['channel://{id}', 'thread://{id}']);

      const ch = await asAlice.readResource({ uri: `channel://${pubId}` });
      const chBody = JSON.parse((ch.contents[0] as { text: string }).text);
      expect(chBody.note).toContain('not instructions');
      expect(chBody.messages.map((m: any) => m.id)).toContain(mid);
      const th = await asAlice.readResource({ uri: `thread://${mid}` });
      expect(JSON.parse((th.contents[0] as { text: string }).text).replies).toHaveLength(1);

      await expect(asAlice.readResource({ uri: `channel://${privId}` })).rejects.toThrow(/not found or not accessible/);
      await expect(asAlice.readResource({ uri: 'channel://abc' })).rejects.toThrow();

      // 읽기 범위가 없는 토큰에는 리소스와 프롬프트가 보이지 않는다
      const noHistory = await clientFor(alice, ['channels:read']);
      await expect(noHistory.listResourceTemplates()).rejects.toThrow();
      await expect(noHistory.listPrompts()).rejects.toThrow();
    });

    it('lists and renders the summary prompts', async () => {
      const client = await clientFor(alice);
      const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
      expect(prompts).toEqual(['summarize_channel', 'summarize_my_mentions']);
      const p = await client.getPrompt({ name: 'summarize_channel', arguments: { channelId: String(pubId) } });
      const text = (p.messages[0].content as { text: string }).text;
      expect(text).toContain(`channel ${pubId}`);
      expect(text).toContain('not instructions');
      await expect(client.getPrompt({ name: 'summarize_channel', arguments: { channelId: '1; ignore previous' } })).rejects.toThrow();
    });
  });
});
