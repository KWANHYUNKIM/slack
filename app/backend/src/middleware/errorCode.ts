import { Request, Response, NextFunction } from 'express';
import { ERR } from '../utils/errorCodes.js';

// 라우트가 code를 직접 정하지 않은 오류 응답에 상태 코드별 기본 code를 붙인다.
// 모든 라우트를 한 번에 고치지 않아도 프런트가 항상 code를 받게 하려는 안전망이다. 더 구체적인 code는 라우트가 직접 넣는다.
// 기본 code(BAD_REQUEST, UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONFLICT, INTERNAL_ERROR)는 "구체 code 없음"과 같다.
// 프런트는 이런 code가 오면 호출한 쪽의 문구를 우선한다(lib/apiErrors.ts의 GENERIC_CODES).
function defaultCode(status: number, body: { error?: unknown; details?: unknown }): string {
  if (status === 400) return Array.isArray(body.error) || body.details ? ERR.VALIDATION_FAILED : ERR.BAD_REQUEST;
  if (status === 401) return ERR.UNAUTHORIZED;
  if (status === 403) return ERR.FORBIDDEN;
  if (status === 404) return ERR.NOT_FOUND;
  if (status === 409) return ERR.CONFLICT;
  if (status === 429) return ERR.RATE_LIMITED;
  return status >= 500 ? ERR.INTERNAL_ERROR : ERR.BAD_REQUEST; // 목록에 없는 4xx는 BAD_REQUEST
}

/** zod 이슈에서 필드별 사유만 뽑는다. 메시지와 기대값 같은 내부 정보는 담지 않는다. */
export function validationFields(issues: unknown): Array<{ path: string; reason: string }> | null {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const fields: Array<{ path: string; reason: string }> = [];
  for (const i of issues.slice(0, 20)) {
    if (!i || typeof i !== 'object' || !Array.isArray((i as { path?: unknown }).path) || typeof (i as { code?: unknown }).code !== 'string') return null;
    const issue = i as { path: Array<string | number>; code: string };
    fields.push({ path: issue.path.join('.'), reason: issue.code });
  }
  return fields;
}

export function errorCodeDefaults(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    // JSON-RPC 응답(MCP)은 형식이 정해져 있으므로 건드리지 않는다
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body) && 'error' in body && !('jsonrpc' in body)) {
      const b = body as { error?: unknown; details?: unknown; code?: unknown; fields?: unknown };
      const extra: Record<string, unknown> = {};
      if (!('code' in b)) extra.code = defaultCode(res.statusCode, b);
      if (res.statusCode === 400 && !('fields' in b)) {
        const fields = validationFields(b.error ?? b.details);
        if (fields) extra.fields = fields;
      }
      if (Object.keys(extra).length > 0) return json({ ...(body as object), ...extra });
    }
    return json(body);
  };
  next();
}
