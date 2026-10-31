import { Router, Request, Response } from 'express';
import { authorizationServerMetadata, protectedResourceMetadata, publicOrigin } from '../services/oauthService.js';

// OAuth 메타데이터(mcp-4). MCP 클라이언트는 /mcp의 401 응답 WWW-Authenticate(resource_metadata)로
// 보호 리소스 메타데이터(RFC 9728)를 찾고, 거기 적힌 인가 서버의 메타데이터(RFC 8414)를 읽는다.
// 리소스가 <origin>/mcp라 경로를 붙인 주소(/oauth-protected-resource/mcp)가 정식이고, 루트 주소도 같은 값을 준다.
const router = Router();

router.get('/oauth-authorization-server', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(authorizationServerMetadata(publicOrigin(req)));
});

const resourceMetadata = (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(protectedResourceMetadata(publicOrigin(req)));
};
router.get('/oauth-protected-resource', resourceMetadata);
router.get('/oauth-protected-resource/mcp', resourceMetadata);

export default router;
