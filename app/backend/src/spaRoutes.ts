// 프로덕션에서 화면 경로 새로고침(직접 주소 입력, 새로고침)을 index.html로 돌리는 목록.
// 프런트 라우트(app/frontend/src/App.tsx)의 최상위 화면 경로를 모두 넣어야 한다.
// tests/spa-routes.test.ts가 두 목록이 어긋나면 실패시킨다.
import type { NextFunction, Request, Response } from 'express';
import path from 'path';

export const SPA_ROUTES = [
  '/login',
  '/register',
  '/oauth-consent',
  '/message-not-found',
  '/files',
  '/unreads',
  '/later',
  '/threads',
  '/search',
  '/activity',
  '/admin',
  // 화면 경로는 아니지만 기존 목록에 있던 항목이라 그대로 둔다
  '/dms',
];

/**
 * 같은 경로에 API 라우터가 있으므로, 브라우저 화면 이동(Accept: text/html, 인증 헤더 없음)일 때만
 * index.html을 준다. `*\/*`만 보내는 클라이언트나 API 호출은 API 응답을 그대로 받는다.
 * app.use(SPA_ROUTES, ...)로 마운트해서 req.path가 '/'인 경우가 최상위 경로다(쿼리스트링은 제외).
 */
export function createSpaNavigationMiddleware(frontendDist: string) {
  const indexFile = path.join(frontendDist, 'index.html');
  return (req: Request, res: Response, next: NextFunction) => {
    const isApiCall = Boolean(req.headers.authorization) || req.headers.accept === 'application/json';
    const wantsHtml = /text\/html/.test(req.headers.accept ?? '');
    if (!isApiCall && req.method === 'GET' && wantsHtml && req.path === '/') {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexFile);
      return;
    }
    next();
  };
}
