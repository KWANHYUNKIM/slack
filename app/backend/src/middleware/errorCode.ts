import { Request, Response, NextFunction } from 'express';
import { ERR } from '../utils/errorCodes.js';

// 라우트가 code를 직접 정하지 않은 오류 응답에 상태 코드별 기본 code를 붙인다.
// 모든 라우트를 한 번에 고치지 않아도 프런트가 항상 code를 받게 하려는 안전망이다. 더 구체적인 code는 라우트가 직접 넣는다.
function defaultCode(status: number, body: { error?: unknown; details?: unknown }): string {
  if (status === 400) return Array.isArray(body.error) || body.details ? ERR.VALIDATION_FAILED : ERR.BAD_REQUEST;
  if (status === 401) return ERR.UNAUTHORIZED;
  if (status === 403) return ERR.FORBIDDEN;
  if (status === 404) return ERR.NOT_FOUND;
  if (status === 409) return ERR.CONFLICT;
  if (status === 429) return ERR.RATE_LIMITED;
  return ERR.INTERNAL_ERROR;
}

export function errorCodeDefaults(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && 'error' in body && !('code' in body)) {
      return json({ ...(body as object), code: defaultCode(res.statusCode, body as { error?: unknown; details?: unknown }) });
    }
    return json(body);
  };
  next();
}
