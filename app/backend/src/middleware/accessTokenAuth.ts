import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types.js';
import { looksLikeAccessToken, verifyAccessToken } from '../services/accessTokenService.js';
import {
  looksLikeOAuthAccessToken, mcpResourceUrl, protectedResourceMetadataUrl, publicOrigin, verifyOAuthAccessToken,
} from '../services/oauthService.js';
import { ERR } from '../utils/errorCodes.js';
import { isMfaPolicyEnforced } from '../services/mfaService.js';

function reject(req: AuthRequest, res: Response, hasToken: boolean): void {
  // RFC 6750·RFC 9728: 401에는 보호 리소스 메타데이터 주소를 붙여 OAuth 클라이언트가 인가 서버를 찾게 한다.
  // 토큰이 왔는데 틀렸으면 error="invalid_token". 실패 이유는 구분하지 않는다.
  const metadata = protectedResourceMetadataUrl(publicOrigin(req));
  res.setHeader('WWW-Authenticate', `Bearer realm="mcp", resource_metadata="${metadata}"${hasToken ? ', error="invalid_token"' : ''}`);
  res.status(401).json({ error: 'Invalid token', code: ERR.AUTH_INVALID_TOKEN });
}

/**
 * /mcp 전용 인증. 개인 액세스 토큰(`scpat_...`)과 OAuth 액세스 토큰(`scoat_...`, mcp-4)만 받는다.
 * 로그인 JWT는 여기서 거부한다(브라우저 세션 토큰이 새어도 MCP로 쓸 수 없게). 반대로 PAT·OAuth 토큰은
 * JWT가 아니라서 일반 API의 authMiddleware를 통과하지 못한다.
 * 성공하면 req.user에 토큰 소유자를, req.accessToken에 토큰 종류·id·범위를 붙인다.
 */
export async function accessTokenAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reject(req, res, false);
    return;
  }
  const token = authHeader.slice(7).trim();
  const isPat = looksLikeAccessToken(token);
  if (!isPat && !looksLikeOAuthAccessToken(token)) {
    reject(req, res, true);
    return;
  }

  try {
    let verified: { userId: number; role: string; scopes: string[]; mfaEnabled: boolean; tokenId: number } | null;
    let rateKey: string;
    let oauthClientId: number | undefined;
    if (isPat) {
      verified = await verifyAccessToken(token);
      rateKey = `pat:${verified?.tokenId}`;
    } else {
      // audience: 이 서버의 /mcp용으로 발급한 토큰만 받는다
      const oauth = await verifyOAuthAccessToken(token, mcpResourceUrl(publicOrigin(req)));
      verified = oauth;
      // 리프레시로 토큰 행이 바뀌어도 한 연결(계열)을 같은 버킷으로 센다
      rateKey = `oauth:${oauth?.familyId}`;
      oauthClientId = oauth?.clientId;
    }
    if (!verified) {
      reject(req, res, true);
      return;
    }
    // 조직이 2FA를 필수로 했는데 소유자가 아직 등록하지 않았으면 PAT·OAuth 토큰도 막는다(E7b). /mcp는 JSON-RPC라 그 형식으로 답한다.
    if (!verified.mfaEnabled && (await isMfaPolicyEnforced())) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Two-factor authentication enrollment required', data: { code: ERR.MFA_ENROLLMENT_REQUIRED } },
        id: null,
      });
      return;
    }
    req.user = { userId: verified.userId, role: verified.role };
    req.accessToken = {
      tokenId: verified.tokenId, scopes: verified.scopes, kind: isPat ? 'pat' : 'oauth', rateKey,
      ...(oauthClientId !== undefined ? { oauthClientId } : {}),
    };
    next();
  } catch (error) {
    next(error);
  }
}
