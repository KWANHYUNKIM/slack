import { Router, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';
import { createMcpServer } from '../mcp/server.js';

// /mcp: MCP Streamable HTTP 엔드포인트(mcp-1). 인증(accessTokenAuth)과 rate limit은 app.ts에서 붙인다.
// stateless 모드: 요청마다 서버와 전송을 새로 만들고 응답이 끝나면 닫는다. 세션 상태를 메모리에 두지 않아
// 인스턴스가 여러 개여도 되고, 토큰 폐기가 다음 요청에 바로 반영된다. 응답은 SSE 대신 JSON 한 번으로 준다.
const router = Router();

function methodNotAllowed(_req: AuthRequest, res: Response): void {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
}

router.post('/', async (req: AuthRequest, res: Response) => {
  const server = createMcpServer({
    userId: req.user!.userId,
    role: req.user!.role,
    tokenId: req.accessToken!.tokenId,
    scopes: req.accessToken!.scopes,
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logError('MCP request error', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
});

// 서버가 먼저 보내는 알림이 없고 세션도 없으므로 GET(SSE 스트림)과 DELETE(세션 종료)는 지원하지 않는다
router.get('/', methodNotAllowed);
router.delete('/', methodNotAllowed);

export default router;
