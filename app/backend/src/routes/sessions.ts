import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';
import { ERR } from '../utils/errorCodes.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { kickSession } from '../websocket/index.js';
import { parseDevice, listActiveSessions, revokeSession, revokeUserSessions } from '../services/sessionService.js';

const router = Router();

// 이 라우터는 /users/me/sessions 아래에 /users보다 먼저 붙는다(/users/:id가 'me'를 먹지 않게).
router.use(authMiddleware);

/** 응답에는 필요한 필드만 담는다. current는 이 요청을 보낸 기기다. */
export function sessionView(
  s: { id: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; userAgent: string | null; ip: string | null },
  currentSid?: string,
) {
  return {
    id: s.id,
    current: s.id === currentSid,
    device: parseDevice(s.userAgent),
    ip: s.ip,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    expiresAt: s.expiresAt,
  };
}

// GET /users/me/sessions - 로그인된 기기 목록
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const rows = await listActiveSessions(req.user!.userId);
    res.json(rows.map((s) => sessionView(s, req.user!.sid)));
  } catch (error) {
    logError('List sessions error', error);
    res.status(500).json({ error: 'Failed to list sessions', code: ERR.INTERNAL_ERROR });
  }
});

// DELETE /users/me/sessions - 이 기기를 뺀 모든 기기 로그아웃
router.delete('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const ids = await revokeUserSessions(userId, req.user!.sid);
    ids.forEach((sid) => kickSession(userId, sid));
    if (ids.length > 0) {
      await writeAuditLog({
        action: 'session.revoked_all', actorId: userId, targetType: 'user', targetId: userId,
        details: `scope=self; count=${ids.length}`,
      });
    }
    res.json({ revoked: ids.length });
  } catch (error) {
    logError('Revoke other sessions error', error);
    res.status(500).json({ error: 'Failed to revoke sessions', code: ERR.INTERNAL_ERROR });
  }
});

// DELETE /users/me/sessions/:id - 기기 하나 로그아웃. 남의 세션이거나 없으면 404(존재 여부를 알려 주지 않는다)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const sid = String(req.params.id);
    const revoked = /^[0-9a-f]{32}$/.test(sid) ? await revokeSession(userId, sid) : null;
    if (!revoked) {
      res.status(404).json({ error: 'Session not found', code: ERR.NOT_FOUND });
      return;
    }
    kickSession(userId, sid);
    await writeAuditLog({
      action: 'session.revoked', actorId: userId, targetType: 'user', targetId: userId,
      details: `scope=self; sid=${sid.slice(0, 8)}`,
    });
    res.json({ message: 'Session revoked', current: sid === req.user!.sid });
  } catch (error) {
    logError('Revoke session error', error);
    res.status(500).json({ error: 'Failed to revoke session', code: ERR.INTERNAL_ERROR });
  }
});

export default router;
