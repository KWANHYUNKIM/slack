import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types.js';
import { looksLikeAccessToken, verifyAccessToken } from '../services/accessTokenService.js';

function reject(res: Response): void {
  // RFC 6750: Bearer 인증 실패에는 WWW-Authenticate를 붙인다. 실패 이유는 구분하지 않는다.
  res.setHeader('WWW-Authenticate', 'Bearer realm="mcp", error="invalid_token"');
  res.status(401).json({ error: 'Invalid token' });
}

/**
 * /mcp 전용 인증. 개인 액세스 토큰(`scpat_...`)만 받는다.
 * 로그인 JWT는 여기서 거부한다(브라우저 세션 토큰이 새어도 MCP로 쓸 수 없게). 반대로 PAT는
 * JWT가 아니라서 일반 API의 authMiddleware를 통과하지 못한다.
 * 성공하면 req.user에 토큰 소유자를, req.accessToken에 토큰 id와 범위를 붙인다.
 */
export async function accessTokenAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reject(res);
    return;
  }
  const token = authHeader.slice(7).trim();
  if (!looksLikeAccessToken(token)) {
    reject(res);
    return;
  }

  try {
    const verified = await verifyAccessToken(token);
    if (!verified) {
      reject(res);
      return;
    }
    req.user = { userId: verified.userId, role: verified.role };
    req.accessToken = { tokenId: verified.tokenId, scopes: verified.scopes };
    next();
  } catch (error) {
    next(error);
  }
}
