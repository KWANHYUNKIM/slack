import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { getStunConfig, getTurnConfig } from '../config.js';
import { getStunListeningPort } from '../stun/stunServer.js';

const router = Router();

const HOSTNAME_RE = /^(?:[a-zA-Z0-9.-]{1,253}|\[[0-9a-fA-F:.]{2,45}\])$/;

let warnedNoPublicHost = false;

// STUN 광고 호스트: STUN_PUBLIC_HOST > (개발 환경에서만) 요청 Host. production에서 둘 다 없으면 null.
function resolveStunHost(req: AuthRequest, publicHost: string): string | null {
  if (publicHost) {
    if (HOSTNAME_RE.test(publicHost)) return publicHost;
    console.warn('STUN_PUBLIC_HOST is not a valid hostname; STUN is not advertised');
    return null;
  }
  if (process.env.NODE_ENV === 'production') {
    if (!warnedNoPublicHost) {
      warnedNoPublicHost = true;
      console.warn('STUN_PUBLIC_HOST is not set in production; STUN is not advertised (set it, or use TURN_URLS)');
    }
    return null;
  }
  // Host 헤더는 클라이언트가 정하므로 호스트 이름 형태일 때만 쓴다
  return HOSTNAME_RE.test(req.hostname) ? req.hostname : 'localhost';
}

// GET /huddles/config - WebRTC ICE 서버 목록 (내장 STUN + 선택적 TURN)
router.get('/config', authMiddleware, (req: AuthRequest, res: Response) => {
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [];

  const stun = getStunConfig();
  // 서버가 실제로 listening 중일 때만 광고한다(바인드 실패 시 광고하지 않음)
  const stunPort = stun.enabled ? getStunListeningPort() : null;
  if (stunPort !== null) {
    const host = resolveStunHost(req, stun.publicHost);
    // 공개 포트(포트 매핑 뒤의 바깥 포트)가 있으면 그 포트를, 없으면 실제 바인드 포트를 광고한다
    if (host) iceServers.push({ urls: `stun:${host}:${stun.publicPort ?? stunPort}` });
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
