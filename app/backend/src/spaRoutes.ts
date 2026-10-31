// 프로덕션에서 화면 경로를 index.html로 돌리는 목록.
// 같은 경로에 API 라우터가 있어서 브라우저 화면 이동만 골라야 하는 경로만 넣는다.
// API와 겹치지 않는 화면 경로(/login, /later 등)는 app.ts의 catch-all이 이미 처리한다.
// tests/spa-routes.test.ts가 프런트 라우트와 API 마운트를 대조해 빠짐을 잡는다.
import type { NextFunction, Request, Response } from 'express';
import path from 'path';

export const SPA_ROUTES = [
  '/files',
  '/unreads',
  '/threads',
  '/search',
  '/activity',
  '/admin',
  // 화면 경로는 아니지만 기존 목록에 있던 항목이라 그대로 둔다
  '/dms',
];

/** index.html을 내보낸다. 화면 경로 새로고침과 catch-all이 같이 쓴다. */
export function sendIndex(res: Response, frontendDist: string): void {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(frontendDist, 'index.html'));
}

/**
 * 브라우저 화면 이동(Accept에 text/html, 인증 헤더 없음, GET)이고 최상위 경로일 때만 index.html을 준다.
 * app.use(SPA_ROUTES, ...)로 마운트하므로 req.path가 '/'이면 최상위 경로다(쿼리스트링은 제외).
 * /files/:id/download 같은 하위 경로는 API가 그대로 처리해야 해서 제외한다.
 */
export function createSpaNavigationMiddleware(frontendDist: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const isApiCall = Boolean(req.headers.authorization) || req.headers.accept === 'application/json';
    const wantsHtml = /text\/html/.test(req.headers.accept ?? '');
    if (!isApiCall && req.method === 'GET' && wantsHtml && req.path === '/') {
      sendIndex(res, frontendDist);
      return;
    }
    next();
  };
}
