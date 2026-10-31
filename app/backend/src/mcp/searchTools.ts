import { ServiceError } from '../services/messageService.js';
import { parseSearchParams, runSearch } from '../services/searchService.js';
import { ToolAccessError, type ToolContext } from './readTools.js';

// MCP search 도구(mcp-3). REST GET /search와 같은 services/searchService.ts를 쓴다(연산자, 탭, 권한 규칙 공유).
// MCP 쪽에서 더하는 규칙: 결과는 토큰의 범위로 한 번 더 걸러 낸다.
//   채널 메시지 channels:history, DM(메시지와 DM 첨부 파일) im:history, 파일 탭 files:read,
//   사람 탭 users:read, 채널 탭 channels:read.
// 파일 결과의 url(다운로드 경로)은 응답에서 뺀다. 파일 내용은 read_file로만 읽는다.

export const DM_SEARCH_SCOPE = 'im:history';

const TAB_SCOPE = {
  messages: 'channels:history',
  dms: DM_SEARCH_SCOPE,
  files: 'files:read',
  people: 'users:read',
  channels: 'channels:read',
} as const;

export async function search(ctx: ToolContext, args: Record<string, unknown>) {
  const has = (scope: string) => ctx.scopes.includes(scope);
  // 이 토큰이 결과에 담을 수 있는 종류
  const included = {
    messages: has(TAB_SCOPE.messages),
    dms: has(TAB_SCOPE.dms),
    files: has(TAB_SCOPE.files),
    people: has(TAB_SCOPE.people),
    channels: has(TAB_SCOPE.channels),
  };
  try {
    const params = parseSearchParams(args);
    // 범위가 없어 아무것도 못 주는 요청은 빈 결과로 답하지 않고 필요한 범위 이름을 알려 준다
    if (params.type === 'all') {
      if (!included.messages && !included.dms) {
        throw new ToolAccessError(`Searching messages requires the ${TAB_SCOPE.messages} scope (or ${TAB_SCOPE.dms} for direct messages)`);
      }
    } else if (!included[params.type]) {
      throw new ToolAccessError(`Searching ${params.type} requires the ${TAB_SCOPE[params.type]} scope`);
    }
    const body = await runSearch(
      { userId: ctx.userId, isGuest: ctx.role === 'GUEST' },
      params,
      { includeDms: included.dms, includeMessages: included.messages },
    );
    return {
      ...body,
      results: body.results.map((r) => {
        const { url: _url, ...rest } = r as Record<string, unknown>;
        return rest;
      }),
      // 이 응답에 실제로 담긴 종류(범위가 없는 종류는 결과에서 빠져 있다). type=all은 messages와 dms만 해당한다.
      included: {
        messages: included.messages && (params.type === 'all' || params.type === 'messages'),
        dms: included.dms && (params.type === 'all' || params.type === 'dms'),
        files: included.files && params.type === 'files',
        people: included.people && params.type === 'people',
        channels: included.channels && params.type === 'channels',
      },
    };
  } catch (error) {
    // 잘못된 질의(400)는 도구 오류 문구로 바꿔 돌려준다
    if (error instanceof ServiceError) throw new ToolAccessError(error.message);
    throw error;
  }
}
