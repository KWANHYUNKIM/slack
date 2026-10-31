import { Router, Request, Response } from 'express';
import {
  authorizationServerMetadata, configuredOrigin, protectedResourceMetadata, publicOrigin,
} from '../services/oauthService.js';
import { ERR } from '../utils/errorCodes.js';

// OAuth 메타데이터(mcp-4). MCP 클라이언트는 /mcp의 401 응답 WWW-Authenticate(resource_metadata)로
// 보호 리소스 메타데이터(RFC 9728)를 찾고, 거기 적힌 인가 서버의 메타데이터(RFC 8414)를 읽는다.
// 리소스가 <origin>/mcp라 경로를 붙인 주소(/oauth-protected-resource/mcp)가 정식이고, 루트 주소도 같은 값을 준다.
// 출처는 PUBLIC_URL로만 정한다. 운영에서 없으면 503, 개발에서는 Host로 만들되 캐시하지 않는다(요청마다 값이 다를 수 있다).
const router = Router();

function send(req: Request, res: Response, build: (origin: string) => object): void {
  const origin = publicOrigin(req);
  if (!origin) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({
      error: 'server_error', error_description: 'OAuth is not configured on this server (PUBLIC_URL)', code: ERR.OAUTH_NOT_CONFIGURED,
    });
    return;
  }
  res.setHeader('Cache-Control', configuredOrigin() ? 'public, max-age=300' : 'no-store');
  res.json(build(origin));
}

router.get('/oauth-authorization-server', (req, res) => send(req, res, authorizationServerMetadata));
router.get('/oauth-protected-resource', (req, res) => send(req, res, protectedResourceMetadata));
router.get('/oauth-protected-resource/mcp', (req, res) => send(req, res, protectedResourceMetadata));

export default router;
