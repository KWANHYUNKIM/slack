// 프로덕션 SPA 경로 목록(spaRoutes.ts)이 프런트 라우트, API 마운트와 어긋나지 않는지,
// 그리고 화면 이동만 index.html을 받는지 확인한다.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import request from 'supertest';
import { SPA_ROUTES, createSpaNavigationMiddleware } from '../spaRoutes.js';

// 테스트 파일 위치(app/backend/src/tests) 기준으로 경로를 잡는다
const FRONTEND_APP_FILE = fileURLToPath(new URL('../../../frontend/src/App.tsx', import.meta.url));
const OAUTH_PATH_FILE = fileURLToPath(new URL('../../../frontend/src/lib/oauthReturn.ts', import.meta.url));
const BACKEND_APP_FILE = fileURLToPath(new URL('../app.ts', import.meta.url));

/** 프런트 라우터에서 최상위 화면 경로(슬래시 없는 정적 경로)를 뽑는다. "/"와 :param 경로는 제외한다. */
function frontendScreenPaths(): string[] {
  const source = fs.readFileSync(FRONTEND_APP_FILE, 'utf-8');
  // 중첩 라우트는 "files"처럼 슬래시 없이, 공개 라우트는 "/login"처럼 쓰여 있어 앞 슬래시를 떼고 맞춘다
  const literal = [...source.matchAll(/<Route\s+path="([^"]+)"/g)]
    .map((m) => m[1].replace(/^\//, ''))
    .filter((p) => p !== '' && !p.includes('/') && !p.includes(':') && p !== '*')
    .map((p) => `/${p}`);
  // /oauth-consent는 상수로 선언돼 있어 따로 읽는다
  const oauth = /OAUTH_CONSENT_PATH\s*=\s*'([^']+)'/.exec(fs.readFileSync(OAUTH_PATH_FILE, 'utf-8'));
  if (oauth) literal.push(oauth[1]);
  return [...new Set(literal)].sort();
}

/** app.ts에 app.use('/x', ...)로 마운트된 API 최상위 경로(첫 세그먼트)를 뽑는다. */
function apiMountRoots(): string[] {
  const source = fs.readFileSync(BACKEND_APP_FILE, 'utf-8');
  return [...new Set([...source.matchAll(/app\.use\(\s*'\/([^'/]+)/g)].map((m) => `/${m[1]}`))].sort();
}

describe('SPA 경로 목록과 프런트 라우트, API 마운트 대조', () => {
  it('검사 대상이 비어 있지 않다(파일 구조가 바뀌면 여기서 실패)', () => {
    const screens = frontendScreenPaths();
    expect(screens).toEqual(expect.arrayContaining(['/search', '/unreads', '/files', '/admin', '/oauth-consent']));
    expect(apiMountRoots()).toEqual(expect.arrayContaining(['/search', '/unreads', '/files', '/admin']));
  });

  it('(a) 프런트 화면 경로는 모두 SPA_ROUTES에 있거나, API 마운트와 겹치지 않아 catch-all이 처리한다', () => {
    const apiRoots = new Set(apiMountRoots());
    const uncovered = frontendScreenPaths().filter((p) => !SPA_ROUTES.includes(p) && apiRoots.has(p));
    expect(uncovered).toEqual([]);
  });

  it('(b) API 마운트와 같은 프런트 화면 경로는 반드시 SPA_ROUTES에 있다', () => {
    const screens = new Set(frontendScreenPaths());
    const collidingApi = apiMountRoots().filter((p) => screens.has(p));
    expect(collidingApi.length).toBeGreaterThan(0);
    const missing = collidingApi.filter((p) => !SPA_ROUTES.includes(p));
    expect(missing).toEqual([]);
  });

  it('SPA_ROUTES 항목은 모두 슬래시로 시작하는 단일 경로다', () => {
    for (const p of SPA_ROUTES) {
      expect(p).toMatch(/^\/[a-z-]+$/);
    }
  });
});

describe('SPA 화면 이동 응답', () => {
  let dist: string;
  let app: express.Express;

  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-routes-'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>SPA</title>');

    app = express();
    app.use(SPA_ROUTES, createSpaNavigationMiddleware(dist));
    // 같은 경로에 있는 API 라우터 흉내: 인증이 없으면 401 JSON
    const apiStub = (req: express.Request, res: express.Response) => {
      res.status(401).json({ error: `api ${req.originalUrl}` });
    };
    app.use('/search', apiStub);
    app.use('/unreads', apiStub);
    app.use('/files', apiStub);
  });

  afterAll(() => {
    fs.rmSync(dist, { recursive: true, force: true });
  });

  it('화면 이동(text/html)은 쿼리스트링이 있어도 index.html을 준다', async () => {
    const res = await request(app).get('/search?q=hello').set('Accept', 'text/html,application/xhtml+xml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>SPA</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('/unreads 새로고침도 index.html을 준다', async () => {
    const res = await request(app).get('/unreads').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>SPA</title>');
  });

  it('Accept가 JSON이면 API 응답을 준다', async () => {
    const res = await request(app).get('/search?q=hello').set('Accept', 'application/json');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('/search');
  });

  it('인증 헤더가 있으면 화면 경로여도 API 응답을 준다', async () => {
    const res = await request(app).get('/unreads').set('Accept', 'text/html').set('Authorization', 'Bearer x');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('/unreads');
  });

  it('Accept가 */*만 있으면 API 응답을 준다(text/html이 있을 때만 화면으로 본다)', async () => {
    const res = await request(app).get('/search').set('Accept', '*/*');
    expect(res.status).toBe(401);
  });

  it('하위 경로(/files/1/download)는 화면으로 가지 않는다', async () => {
    const res = await request(app).get('/files/1/download').set('Accept', 'text/html');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('/files/1/download');
  });
});
