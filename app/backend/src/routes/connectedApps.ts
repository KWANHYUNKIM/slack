import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { ERR } from '../utils/errorCodes.js';
import { disconnectApp, listConnectedApps } from '../services/oauthService.js';

// 설정의 "연결된 앱"(mcp-4): 내가 OAuth로 허용한 앱 목록과 연결 해제. 로그인 JWT로만 다룬다.
const router = Router();

// GET /users/me/connected-apps - 살아 있는 연결을 앱(클라이언트)별로 묶어 돌려준다
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    res.json({ items: await listConnectedApps(req.user!.userId), nextCursor: null });
  } catch (error) {
    logError('List connected apps error', error);
    res.status(500).json({ error: 'Failed to list connected apps', code: ERR.INTERNAL_ERROR });
  }
});

// DELETE /users/me/connected-apps/:id - 이 앱에 준 모든 토큰을 폐기한다. 바로 /mcp에서 401, 리프레시도 실패한다.
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const clientId = parseIntParam(req.params.id);
    if (!clientId) {
      res.status(400).json({ error: 'Invalid app ID', code: ERR.VALIDATION_FAILED });
      return;
    }
    const userId = req.user!.userId;
    const revoked = await disconnectApp(userId, clientId);
    // 남의 앱이나 없는 앱, 이미 끊은 앱은 같은 404
    if (revoked === 0) {
      res.status(404).json({ error: 'Connected app not found', code: ERR.OAUTH_CONNECTION_NOT_FOUND });
      return;
    }
    void writeAuditLog({
      action: 'oauth.token_revoked', actorId: userId, targetType: 'oauth_client', targetId: clientId,
      details: JSON.stringify({ via: 'user', revoked }),
    });
    res.json({ disconnected: true });
  } catch (error) {
    logError('Disconnect app error', error);
    res.status(500).json({ error: 'Failed to disconnect the app', code: ERR.INTERNAL_ERROR });
  }
});

export default router;
