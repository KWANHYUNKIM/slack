import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { getStunConfig, getTurnConfig } from '../config.js';

const router = Router();

// Host 헤더는 클라이언트가 정하므로 호스트 이름 형태일 때만 STUN 주소에 쓴다
const HOSTNAME_RE = /^(?:[a-zA-Z0-9.-]{1,253}|\[[0-9a-fA-F:.]{2,45}\])$/;

// GET /huddles/config - WebRTC ICE 서버 목록 (내장 STUN + 선택적 TURN)
router.get('/config', authMiddleware, (req: AuthRequest, res: Response) => {
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [];

  const stun = getStunConfig();
  if (stun.enabled) {
    const host = HOSTNAME_RE.test(req.hostname) ? req.hostname : 'localhost';
    iceServers.push({ urls: `stun:${host}:${stun.port}` });
  }

  const turn = getTurnConfig();
  if (turn.urls.length > 0) {
    iceServers.push({
      urls: turn.urls,
      ...(turn.username && turn.credential ? { username: turn.username, credential: turn.credential } : {}),
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ iceServers });
});

export default router;
