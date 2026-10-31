import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';
import { parseSearchParams, runSearch } from '../services/searchService.js';
import { ServiceError } from '../services/messageService.js';

const router = Router();

// GET /search - 메시지, DM, 파일, 사람, 채널 검색. 로직은 services/searchService.ts(MCP search 도구와 공용)
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const params = parseSearchParams(req.query);
    res.json(await runSearch({ userId: req.user!.userId, isGuest: req.user!.role === 'GUEST' }, params));
  } catch (error) {
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logError('Search error', error);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

export default router;
