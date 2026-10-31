import { ServiceError } from '../services/messageService.js';
import { parseSearchParams, runSearch } from '../services/searchService.js';
import { ToolAccessError, type ToolContext } from './readTools.js';

// MCP search 도구(mcp-3). REST GET /search와 같은 services/searchService.ts를 쓴다(연산자, 탭, 권한 규칙 공유).
// MCP 쪽에서 더하는 규칙은 둘뿐이다.
// 1. DM 결과(탭 dms, 파일 탭의 DM 첨부)는 토큰에 im:history 범위가 있을 때만 포함한다.
// 2. 파일 결과의 url(다운로드 경로)은 응답에서 뺀다. 파일 내용은 read_file로만 읽는다.

export const DM_SEARCH_SCOPE = 'im:history';

export async function search(ctx: ToolContext, args: Record<string, unknown>) {
  const includeDms = ctx.scopes.includes(DM_SEARCH_SCOPE);
  try {
    const params = parseSearchParams(args);
    // 범위 없이 DM 탭을 달라는 요청은 조용히 빈 결과로 답하지 않고 이유를 알려 준다
    if (params.type === 'dms' && !includeDms) {
      throw new ToolAccessError(`Searching direct messages requires the ${DM_SEARCH_SCOPE} scope`);
    }
    const body = await runSearch({ userId: ctx.userId, isGuest: ctx.role === 'GUEST' }, params, { includeDms });
    return {
      ...body,
      results: body.results.map((r) => {
        const { url: _url, ...rest } = r as Record<string, unknown>;
        return rest;
      }),
      dmsIncluded: includeDms,
    };
  } catch (error) {
    // 잘못된 질의(400)는 도구 오류 문구로 바꿔 돌려준다
    if (error instanceof ServiceError) throw new ToolAccessError(error.message);
    throw error;
  }
}
