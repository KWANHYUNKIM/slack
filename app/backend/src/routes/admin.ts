import { Router, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import prisma from '../db.js';
import { authMiddleware, invalidateTokenCache } from '../middleware/auth.js';
import { requireAccountAdmin, requireCurrentWorkspaceAdmin, requireDefaultWorkspaceAdmin } from '../middleware/adminAuth.js';
import { AuthRequest } from '../types.js';
import { getIO, kickUser, kickSession, MFA_KICK_MESSAGE } from '../websocket/index.js';
import { parseIntParam } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { updateChannel, channelAudience, emitToChannelAudience } from '../services/channelService.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { listActiveSessions, revokeSession, revokeUserSessions } from '../services/sessionService.js';
import { sessionView } from './sessions.js';
import { ERR } from '../utils/errorCodes.js';
import { clearMfa, getRequireMfa, setRequireMfa, isMfaAvailable } from '../services/mfaService.js';
import { getAllowOAuthApps, setAllowOAuthApps } from '../services/oauthService.js';
import { DEFAULT_WORKSPACE_ID, setUserRole } from '../services/workspaceService.js';
import {
  channelInWorkspaceWhere, memberOfWorkspaceWhere, targetRoleInChannelWorkspaces, channelWorkspaceIds,
} from '../services/workspaceScopeService.js';

const router = Router();

// All admin routes require authentication; 권한과 범위는 경로 묶음마다 다르다(E1c, 스펙 5.3·5.5).
// - 사용자 목록·역할 변경·소유권 이전: 기본 워크스페이스(역할이 User.role = 기본 워크스페이스 역할이다). requireDefaultWorkspaceAdmin
// - 계정 단위(비활성화·재활성화·세션·2FA 초기화·보안 설정): 조직 단위. 조직 관리자 또는 기본 워크스페이스 관리자가 같은 조직의
//   모든 사용자에게 한다(기본 워크스페이스 멤버십 불필요). requireAccountAdmin
// - 채널·초대: 현재 워크스페이스(req.workspace). 그 워크스페이스의 관리자 또는 조직 관리자. requireCurrentWorkspaceAdmin.
//   다른 워크스페이스의 대상은 존재를 숨겨 404다. req.user.role은 어디서도 헤더로 바꾸지 않는다(E1b 결정).
router.use(authMiddleware);

/** 기본 워크스페이스 범위 대상 사용자(계정 비활성 사용자 포함) */
const defaultWorkspaceUserWhere = (id: number) => memberOfWorkspaceWhere(DEFAULT_WORKSPACE_ID, { id });

/** 조직 범위 대상 사용자(계정 단위 작업) */
const orgUserWhere = (req: AuthRequest, id: number) => ({ id, organizationId: req.workspaceState!.organizationId });

/** 현재 워크스페이스에 보이는 채널(공유 채널 포함) */
const workspaceChannelWhere = (req: AuthRequest, id: number) => channelInWorkspaceWhere(req.workspace!.id, { id });

const ADMIN_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  avatar: true,
  role: true,
  status: true,
  deactivatedAt: true,
  createdAt: true,
  // 2FA 사용 여부(E7b). 비밀 값은 고르지 않는다.
  mfaEnabledAt: true,
} as const;

// GET /admin/users - List all users
router.get('/users', requireDefaultWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: memberOfWorkspaceWhere(DEFAULT_WORKSPACE_ID),
      select: ADMIN_USER_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    res.json(users);
  } catch (error) {
    logError('Admin list users error', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// Role hierarchy: OWNER > ADMIN > MEMBER > GUEST
const ROLE_RANK: Record<string, number> = { OWNER: 3, ADMIN: 2, MEMBER: 1, GUEST: 0 };

// 계정 단위 작업의 등급: 조직 역할과 기본 워크스페이스 역할 중 높은 것(행위자는 기본 워크스페이스 멤버일 때만 그 역할을 센다)
function accountActorRank(req: AuthRequest): number {
  const defaultRole = req.workspaceState?.memberships.find((m) => m.workspaceId === DEFAULT_WORKSPACE_ID)?.role;
  return Math.max(ROLE_RANK[req.user!.orgRole ?? 'MEMBER'] ?? 0, defaultRole ? ROLE_RANK[defaultRole] : 0);
}

function accountTargetRank(target: { role: string; orgRole: string }): number {
  return Math.max(ROLE_RANK[target.role] ?? 0, ROLE_RANK[target.orgRole] ?? 0);
}

// PATCH /admin/users/:id - Change user role
const updateRoleSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER', 'GUEST']),
});

router.patch('/users/:id', requireDefaultWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseIntParam(req.params.id);
    if (!userId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    if (userId === req.user!.userId) {
      res.status(400).json({ error: 'Cannot modify your own role' });
      return;
    }

    const { role } = updateRoleSchema.parse(req.body);
    const actorRole = req.user!.role || 'MEMBER';

    const target = await prisma.user.findFirst({
      where: defaultWorkspaceUserWhere(userId),
      select: { id: true, role: true },
    });

    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Cannot modify someone at or above your rank (unless you're OWNER)
    if (actorRole !== 'OWNER' && ROLE_RANK[target.role] >= ROLE_RANK[actorRole]) {
      res.status(403).json({ error: 'Cannot modify a user with equal or higher role' });
      return;
    }

    // Only OWNER can promote to ADMIN
    if (role === 'ADMIN' && actorRole !== 'OWNER') {
      res.status(403).json({ error: 'Only the workspace owner can promote to admin' });
      return;
    }

    // 역할 쓰기는 setUserRole 하나로: 조직 역할·기본 워크스페이스 역할·주 소유자까지 같은 트랜잭션에서 맞춘다(E1a)
    const updated = await prisma.$transaction(async (tx) => {
      await setUserRole(tx, userId, role);
      return tx.user.findUniqueOrThrow({ where: { id: userId }, select: ADMIN_USER_SELECT });
    });

    // Invalidate cached auth so the new role takes effect immediately
    invalidateTokenCache(userId);

    // Force-disconnect WebSocket sessions so the user reconnects with
    // the new role.  Without this, the cached socket.user.role stays
    // stale until the 5-minute periodic revalidation, letting a user
    // demoted to GUEST bypass GUEST restrictions (DM/huddle checks).
    kickUser(userId);

    writeAuditLog({
      action: 'user.role_changed',
      actorId: req.user!.userId,
      targetType: 'user',
      targetId: userId,
      targetName: updated.name,
      details: `Role changed from ${target.role} to ${role}`,
    });

    res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Admin update role error', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// POST /admin/users/:id/deactivate - Deactivate user
router.post('/users/:id/deactivate', requireAccountAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseIntParam(req.params.id);
    if (!userId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    if (userId === req.user!.userId) {
      res.status(400).json({ error: 'Cannot deactivate yourself' });
      return;
    }

    const target = await prisma.user.findFirst({
      where: orgUserWhere(req, userId),
      select: { id: true, role: true, orgRole: true },
    });

    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const actorRank = accountActorRank(req);
    if (target.role === 'OWNER' || target.orgRole === 'OWNER') {
      res.status(403).json({ error: 'Cannot deactivate the workspace owner' });
      return;
    }
    if (actorRank < ROLE_RANK.OWNER && accountTargetRank(target) >= actorRank) {
      res.status(403).json({ error: 'Cannot deactivate a user with equal or higher role' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        deactivatedAt: new Date(),
        tokenVersion: { increment: 1 },
      },
      select: ADMIN_USER_SELECT,
    });

    invalidateTokenCache(userId);
    kickUser(userId);

    writeAuditLog({
      action: 'user.deactivated',
      actorId: req.user!.userId,
      targetType: 'user',
      targetId: userId,
      targetName: updated.name,
    });

    res.json(updated);
  } catch (error) {
    logError('Admin deactivate user error', error);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// 대상 사용자 조회와 역할 비교. 문제가 있으면 응답을 보내고 null을 돌려준다(force-logout과 같은 규칙).
async function loadSessionTarget(req: AuthRequest, res: Response): Promise<{ id: number; name: string } | null> {
  const userId = parseIntParam(req.params.id);
  if (!userId) {
    res.status(400).json({ error: 'Invalid user ID' });
    return null;
  }
  const target = await prisma.user.findFirst({ where: orgUserWhere(req, userId), select: { id: true, name: true, role: true, orgRole: true } });
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return null;
  }
  const actorRank = accountActorRank(req);
  if (userId !== req.user!.userId && actorRank < ROLE_RANK.OWNER && accountTargetRank(target) >= actorRank) {
    res.status(403).json({ error: 'Cannot manage sessions of a user with equal or higher role' });
    return null;
  }
  return { id: target.id, name: target.name };
}

// GET /admin/users/:id/sessions - 사용자의 로그인된 기기 목록
router.get('/users/:id/sessions', requireAccountAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const target = await loadSessionTarget(req, res);
    if (!target) return;
    const rows = await listActiveSessions(target.id);
    res.json(rows.map((s) => sessionView(s)));
  } catch (error) {
    logError('Admin list sessions error', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// DELETE /admin/users/:id/sessions/:sid - 기기 하나 로그아웃
router.delete('/users/:id/sessions/:sid', requireAccountAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const target = await loadSessionTarget(req, res);
    if (!target) return;
    const sid = String(req.params.sid);
    const revoked = /^[0-9a-f]{32}$/.test(sid) ? await revokeSession(target.id, sid) : null;
    if (!revoked) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    kickSession(target.id, sid);
    await writeAuditLog({
      action: 'session.revoked', actorId: req.user!.userId, targetType: 'user', targetId: target.id,
      targetName: target.name, details: `scope=admin; sid=${sid.slice(0, 8)}`,
    });
    res.json({ message: 'Session revoked' });
  } catch (error) {
    logError('Admin revoke session error', error);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

// DELETE /admin/users/:id/sessions - 사용자의 모든 기기 로그아웃. sid 없는 옛 토큰까지 막도록 tokenVersion도 올린다(force-logout과 같은 효과).
router.delete('/users/:id/sessions', requireAccountAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const target = await loadSessionTarget(req, res);
    if (!target) return;
    await prisma.user.update({ where: { id: target.id }, data: { tokenVersion: { increment: 1 } } });
    const ids = await revokeUserSessions(target.id);
    invalidateTokenCache(target.id);
    kickUser(target.id);
    // tokenVersion을 항상 올리므로(레거시 토큰 무효화) 폐기 세션이 0건이어도 감사 로그를 남긴다
    await writeAuditLog({
      action: 'session.revoked_all', actorId: req.user!.userId, targetType: 'user', targetId: target.id,
      targetName: target.name, details: `scope=admin; count=${ids.length}; tokenVersion=bumped`,
    });
    res.json({ revoked: ids.length, tokenVersionBumped: true });
  } catch (error) {
    logError('Admin revoke sessions error', error);
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

// POST /admin/users/:id/force-logout - 사용자의 모든 세션을 끊는다(토큰 버전 증가 + 세션 폐기 + 소켓 종료). 계정은 그대로 둔다.
router.post('/users/:id/force-logout', requireAccountAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const target = await loadSessionTarget(req, res);
    if (!target) return;
    const userId = target.id;

    // 두 방식을 함께 쓴다: tokenVersion은 sid 없는 옛 토큰까지 막고, 세션 폐기는 목록과 감사 기록을 정리한다.
    await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    const revokedSids = await revokeUserSessions(userId);
    invalidateTokenCache(userId);
    kickUser(userId);

    writeAuditLog({
      action: 'user.force_logout',
      actorId: req.user!.userId,
      targetType: 'user',
      targetId: userId,
      targetName: target.name,
      details: `sessions=${revokedSids.length}`,
    });

    res.json({ message: 'User logged out' });
  } catch (error) {
    logError('Admin force logout error', error);
    res.status(500).json({ error: 'Failed to force logout' });
  }
});

// POST /admin/users/:id/2fa/reset - 휴대폰을 잃은 사용자의 2FA를 지운다(E7b). 그 사용자의 세션도 모두 끊는다.
// 자기 자신은 초기화할 수 없다(본인은 비밀번호와 코드로 해제한다. 관리자 권한으로 본인 확인을 건너뛰지 않게).
router.post('/users/:id/2fa/reset', requireAccountAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const target = await loadSessionTarget(req, res);
    if (!target) return;
    if (target.id === req.user!.userId) {
      res.status(400).json({ error: 'Use your own security settings to turn off two-factor authentication', code: ERR.BAD_REQUEST });
      return;
    }
    const row = await prisma.user.findUnique({ where: { id: target.id }, select: { mfaEnabledAt: true, mfaPendingSecret: true } });
    if (!row?.mfaEnabledAt && !row?.mfaPendingSecret) {
      res.status(400).json({ error: 'Two-factor authentication is not enabled', code: ERR.MFA_NOT_ENABLED });
      return;
    }
    await clearMfa(target.id);
    // 강제 로그아웃과 같은 방식: tokenVersion으로 옛 토큰까지 막고 세션 행을 폐기하고 소켓을 끊는다
    await prisma.user.update({ where: { id: target.id }, data: { tokenVersion: { increment: 1 } } });
    const revoked = await revokeUserSessions(target.id);
    invalidateTokenCache(target.id);
    // 계정 비활성화가 아니라 세션 폐기이므로 세션 폐기와 같은 사유로 끊는다
    kickUser(target.id, 'Session revoked');
    await writeAuditLog({
      action: 'mfa.reset_by_admin', actorId: req.user!.userId, targetType: 'user', targetId: target.id,
      targetName: target.name, details: `sessions=${revoked.length}`,
    });
    res.json({ reset: true, sessionsRevoked: revoked.length });
  } catch (error) {
    logError('Admin reset 2FA error', error);
    res.status(500).json({ error: 'Failed to reset 2FA', code: ERR.INTERNAL_ERROR });
  }
});

// GET /admin/settings/security - 조직 보안 정책. mfaAvailable이 false면(암호화 키 없음) 필수 정책을 켤 수 없고 걸리지도 않는다.
router.get('/settings/security', requireAccountAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    res.json({ requireMfa: await getRequireMfa(), mfaAvailable: isMfaAvailable(), allowOAuthApps: await getAllowOAuthApps() });
  } catch (error) {
    logError('Admin get security settings error', error);
    res.status(500).json({ error: 'Failed to get settings', code: ERR.INTERNAL_ERROR });
  }
});

// PATCH /admin/settings/security - "모든 사용자 2FA 필수", "OAuth 앱 연결 허용"(mcp-4) 켜고 끄기. 바꿀 값만 보낸다.
router.patch('/settings/security', requireAccountAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = z.object({ requireMfa: z.boolean().optional(), allowOAuthApps: z.boolean().optional() }).strict()
      .refine((v) => v.requireMfa !== undefined || v.allowOAuthApps !== undefined, { message: 'Nothing to update' })
      .parse(req.body);
    const { requireMfa, allowOAuthApps } = parsed;
    // 조건 확인을 먼저 다 하고 나서 바꾼다(둘을 함께 보냈을 때 한쪽만 바뀌지 않게)
    if (requireMfa && !isMfaAvailable()) {
      res.status(503).json({ error: 'Two-factor authentication is not available on this server', code: ERR.MFA_UNAVAILABLE });
      return;
    }
    // 켜는 관리자부터 2FA가 있어야 한다(없이 켜면 그 자리에서 자기 화면이 등록 화면으로 막힌다)
    if (requireMfa) {
      const actor = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { mfaEnabledAt: true } });
      if (!actor?.mfaEnabledAt) {
        res.status(400).json({ error: 'Turn on two-factor authentication for your own account first', code: ERR.MFA_NOT_ENABLED });
        return;
      }
    }
    if (allowOAuthApps !== undefined) {
      const beforeOAuth = await getAllowOAuthApps();
      // 끄면 살아 있는 OAuth 토큰을 모두 폐기한다(다시 켜도 예전 연결이 되살아나지 않게)
      const revoked = await setAllowOAuthApps(allowOAuthApps);
      if (beforeOAuth !== allowOAuthApps) {
        await writeAuditLog({
          action: 'workspace.oauth_policy_changed', actorId: req.user!.userId, targetType: 'workspace',
          details: `allowOAuthApps=${allowOAuthApps}; revoked=${revoked}`,
        });
      }
    }
    if (requireMfa !== undefined) {
      const before = await getRequireMfa();
      await setRequireMfa(requireMfa);
      if (before !== requireMfa) {
        await writeAuditLog({
          action: 'workspace.mfa_policy_changed', actorId: req.user!.userId, targetType: 'workspace',
          details: `requireMfa=${requireMfa}`,
        });
      }
      // 켜면 2FA가 없는 사용자의 실시간 연결을 바로 끊는다(다시 붙으려 해도 핸드셰이크가 거부한다). HTTP는 다음 요청부터 막힌다.
      if (requireMfa) {
        const unenrolled = await prisma.user.findMany({ where: { mfaEnabledAt: null, deactivatedAt: null }, select: { id: true } });
        for (const u of unenrolled) {
          invalidateTokenCache(u.id);
          kickUser(u.id, MFA_KICK_MESSAGE);
        }
      }
    }
    res.json({ requireMfa: await getRequireMfa(), mfaAvailable: isMfaAvailable(), allowOAuthApps: await getAllowOAuthApps() });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('Admin update security settings error', error);
    res.status(500).json({ error: 'Failed to update settings', code: ERR.INTERNAL_ERROR });
  }
});

// POST /admin/users/:id/reactivate - Reactivate user
router.post('/users/:id/reactivate', requireAccountAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const userId = parseIntParam(req.params.id);
    if (!userId) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    const target = await prisma.user.findFirst({
      where: orgUserWhere(req, userId),
      select: { id: true, role: true, orgRole: true },
    });
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Enforce same role hierarchy as deactivation:
    // only OWNER can reactivate ADMIN-level users; an ADMIN cannot
    // reactivate someone at or above their own rank.
    const actorRank = accountActorRank(req);
    if (actorRank < ROLE_RANK.OWNER && accountTargetRank(target) >= actorRank) {
      res.status(403).json({ error: 'Cannot reactivate a user with equal or higher role' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { deactivatedAt: null },
      select: ADMIN_USER_SELECT,
    });

    writeAuditLog({
      action: 'user.reactivated',
      actorId: req.user!.userId,
      targetType: 'user',
      targetId: userId,
      targetName: updated.name,
    });

    res.json(updated);
  } catch (error) {
    logError('Admin reactivate user error', error);
    res.status(500).json({ error: 'Failed to reactivate user' });
  }
});

// GET /admin/invites - List all invite links
router.get('/invites', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const invites = await prisma.inviteLink.findMany({
      where: { workspaceId: req.workspace!.id },
      include: {
        creator: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(invites);
  } catch (error) {
    logError('Admin list invites error', error);
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

// POST /admin/invites - Create invite link
const createInviteSchema = z.object({
  role: z.enum(['MEMBER', 'GUEST']).optional().default('MEMBER'),
  maxUses: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

router.post('/invites', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { role, maxUses, expiresAt } = createInviteSchema.parse(req.body);

    const code = crypto.randomBytes(32).toString('hex');

    const invite = await prisma.inviteLink.create({
      data: {
        code,
        workspaceId: req.workspace!.id,
        createdBy: req.user!.userId,
        role,
        maxUses: maxUses ?? null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
      include: {
        creator: { select: { id: true, name: true } },
      },
    });

    writeAuditLog({
      action: 'invite.created',
      actorId: req.user!.userId,
      targetType: 'invite',
      targetId: invite.id,
      details: `Role: ${role}, Max uses: ${maxUses ?? 'unlimited'}, Expires: ${expiresAt ?? 'never'}`,
    });

    res.status(201).json(invite);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Admin create invite error', error);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// DELETE /admin/invites/:id - Delete invite link
router.delete('/invites/:id', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid invite ID' });
      return;
    }

    // 다른 워크스페이스의 초대는 없는 것으로 답한다
    const invite = await prisma.inviteLink.findFirst({ where: { id, workspaceId: req.workspace!.id }, select: { id: true } });
    if (!invite) {
      res.status(404).json({ error: 'Invite not found', code: ERR.NOT_FOUND });
      return;
    }
    await prisma.inviteLink.delete({ where: { id } });

    writeAuditLog({
      action: 'invite.deleted',
      actorId: req.user!.userId,
      targetType: 'invite',
      targetId: id,
    });

    res.json({ message: 'Invite deleted' });
  } catch (error) {
    logError('Admin delete invite error', error);
    res.status(500).json({ error: 'Failed to delete invite' });
  }
});

// GET /admin/channels - List all channels with counts
router.get('/channels', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const channels = await prisma.channel.findMany({
      where: channelInWorkspaceWhere(req.workspace!.id),
      include: {
        _count: {
          select: { members: true, messages: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(channels);
  } catch (error) {
    logError('Admin list channels error', error);
    res.status(500).json({ error: 'Failed to list channels' });
  }
});

// DELETE /admin/channels/:id - Delete a channel (permanent)
router.delete('/channels/:id', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }

    const channel = await prisma.channel.findFirst({ where: workspaceChannelWhere(req, id), select: { id: true, name: true, isPrivate: true } });
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // 지우면 워크스페이스·멤버 행이 함께 사라지므로 알릴 대상은 먼저 계산한다
    const audience = await channelAudience(channel);
    await prisma.channel.delete({ where: { id } });

    emitToChannelAudience(audience, 'channel:deleted', { channelId: id });
    getIO()?.in(`channel:${id}`).socketsLeave(`channel:${id}`);

    writeAuditLog({
      action: 'channel.deleted',
      actorId: req.user!.userId,
      targetType: 'channel',
      targetId: id,
      targetName: channel.name,
    });

    res.json({ message: 'Channel deleted' });
  } catch (error) {
    logError('Admin delete channel error', error);
    res.status(500).json({ error: 'Failed to delete channel' });
  }
});

// POST /admin/channels/:id/archive - Archive a channel (soft delete)
router.post('/channels/:id/archive', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }

    const channel = await prisma.channel.findFirst({ where: workspaceChannelWhere(req, id) });
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    if (channel.archivedAt) {
      res.status(400).json({ error: 'Channel is already archived' });
      return;
    }

    const updated = await prisma.channel.update({
      where: { id },
      data: { archivedAt: new Date() },
      include: { _count: { select: { members: true, messages: true } } },
    });

    emitToChannelAudience(await channelAudience(channel), 'channel:archived', { channelId: id, name: channel.name });

    writeAuditLog({
      action: 'channel.archived',
      actorId: req.user!.userId,
      targetType: 'channel',
      targetId: id,
      targetName: channel.name,
    });

    res.json(updated);
  } catch (error) {
    logError('Admin archive channel error', error);
    res.status(500).json({ error: 'Failed to archive channel' });
  }
});

// POST /admin/channels/:id/unarchive - Unarchive a channel
router.post('/channels/:id/unarchive', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }

    const channel = await prisma.channel.findFirst({ where: workspaceChannelWhere(req, id) });
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    if (!channel.archivedAt) {
      res.status(400).json({ error: 'Channel is not archived' });
      return;
    }

    const updated = await prisma.channel.update({
      where: { id },
      data: { archivedAt: null },
      include: { _count: { select: { members: true, messages: true } } },
    });

    emitToChannelAudience(await channelAudience(channel), 'channel:unarchived', { channelId: id, name: channel.name });

    writeAuditLog({
      action: 'channel.unarchived',
      actorId: req.user!.userId,
      targetType: 'channel',
      targetId: id,
      targetName: channel.name,
    });

    res.json(updated);
  } catch (error) {
    logError('Admin unarchive channel error', error);
    res.status(500).json({ error: 'Failed to unarchive channel' });
  }
});

// PATCH /admin/channels/:id - Edit channel name
const editChannelSchema = z.object({
  name: z.string().optional(),
  isPrivate: z.boolean().optional(),
}).refine(data => data.name !== undefined || data.isPrivate !== undefined, {
  message: 'At least one field must be provided',
});

router.patch('/channels/:id', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const id = parseIntParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }

    const parsed = editChannelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
      return;
    }
    const channel = await prisma.channel.findFirst({ where: workspaceChannelWhere(req, id) });
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // 이름 검증·중복·감사 로그·알림은 채널 수정 경로와 같은 서비스 함수가 맡는다.
    // 이름은 생성 경로와 같은 검증(같은 CHANNEL_NAME_MAX 상한)을 쓴다.
    const result = await updateChannel({
      channel,
      actorId: req.user!.userId,
      input: { name: parsed.data.name, isPrivate: parsed.data.isPrivate },
    });
    if (!result.ok) {
      res.status(result.status).json(result.body);
      return;
    }
    const updated = result.channel;

    res.json(updated);
  } catch (error) {
    logError('Admin edit channel error', error);
    res.status(500).json({ error: 'Failed to edit channel' });
  }
});

// GET /admin/channels/:id/members - List members of any channel
router.get('/channels/:id/members', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = parseIntParam(req.params.id);
    if (!channelId) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }

    if (!(await prisma.channel.findFirst({ where: workspaceChannelWhere(req, channelId), select: { id: true } }))) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const members = await prisma.channelMember.findMany({
      where: { channelId },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    res.json(members);
  } catch (error) {
    logError('Admin list channel members error', error);
    res.status(500).json({ error: 'Failed to list channel members' });
  }
});

// POST /admin/channels/:id/members - Add user to any channel
const addMemberSchema = z.object({
  userId: z.number().int().positive(),
});

router.post('/channels/:id/members', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = parseIntParam(req.params.id);
    if (!channelId) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }

    const { userId } = addMemberSchema.parse(req.body);

    const channel = await prisma.channel.findFirst({ where: workspaceChannelWhere(req, channelId), select: { name: true } });
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    // Verify user exists and is active
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deactivatedAt: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (user.deactivatedAt) {
      res.status(400).json({ error: 'Cannot add a deactivated user to a channel' });
      return;
    }
    // 대상은 채널이 보이는 워크스페이스 중 하나의 활성 멤버여야 한다(E1c, 5.3)
    if ((await targetRoleInChannelWorkspaces(userId, await channelWorkspaceIds(channelId))) === null) {
      res.status(400).json({ error: 'User is not a member of this channel\'s workspace', code: ERR.USER_NOT_IN_WORKSPACE });
      return;
    }

    await prisma.channelMember.create({
      data: { userId, channelId },
    });

    await writeAuditLog({
      action: 'channel.member_added',
      actorId: req.user!.userId,
      targetType: 'channel',
      targetId: channelId,
      targetName: channel.name,
      details: `Added user ${userId} to channel`,
    });

    res.json({ message: 'Member added' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Admin add channel member error', error);
    res.status(500).json({ error: 'Failed to add member' });
  }
});

// DELETE /admin/channels/:id/members/:userId - Remove user from any channel
router.delete('/channels/:id/members/:userId', requireCurrentWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const channelId = parseIntParam(req.params.id);
    const userId = parseIntParam(req.params.userId);
    if (!channelId || !userId) {
      res.status(400).json({ error: 'Invalid ID' });
      return;
    }

    const channel = await prisma.channel.findFirst({ where: workspaceChannelWhere(req, channelId), select: { name: true } });
    if (!channel) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    await prisma.channelMember.delete({
      where: { userId_channelId: { userId, channelId } },
    });

    // Evict user's sockets from the channel room so they stop receiving messages
    const io = getIO();
    if (io) {
      io.to(`channel:${channelId}`).emit('channel:member-left', {
        channelId,
        userId,
        memberCount: await prisma.channelMember.count({ where: { channelId } }),
      });
      io.in(`user:${userId}`).socketsLeave(`channel:${channelId}`);
    }

    await writeAuditLog({
      action: 'channel.member_removed',
      actorId: req.user!.userId,
      targetType: 'channel',
      targetId: channelId,
      targetName: channel.name,
      details: `Removed user ${userId} from channel`,
    });

    res.json({ message: 'Member removed' });
  } catch (error) {
    logError('Admin remove channel member error', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// POST /admin/transfer-ownership - Transfer workspace ownership (OWNER only)
const transferOwnershipSchema = z.object({
  userId: z.number().int().positive(),
});

router.post('/transfer-ownership', requireDefaultWorkspaceAdmin, async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role !== 'OWNER') {
      res.status(403).json({ error: 'Only the workspace owner can transfer ownership' });
      return;
    }

    const { userId } = transferOwnershipSchema.parse(req.body);
    const ownerId = req.user!.userId;

    if (userId === ownerId) {
      res.status(400).json({ error: 'Cannot transfer ownership to yourself' });
      return;
    }

    const target = await prisma.user.findFirst({
      where: defaultWorkspaceUserWhere(userId),
      select: { id: true, name: true, role: true, deactivatedAt: true },
    });

    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (target.deactivatedAt) {
      res.status(400).json({ error: 'Cannot transfer ownership to a deactivated user' });
      return;
    }

    if (target.role === 'GUEST') {
      res.status(400).json({ error: 'Cannot transfer ownership to a guest user' });
      return;
    }

    // Atomic: demote current owner to ADMIN, promote target to OWNER
    await prisma.$transaction(async (tx) => {
      // 이전 대상자를 조직 주 소유자로 명시 지정한다(E1a). 다른 OWNER가 있어도 주 소유자는 대상자다.
      await setUserRole(tx, userId, 'OWNER', { makePrimaryOwner: true });
      await setUserRole(tx, ownerId, 'ADMIN');
    });

    // Invalidate cached auth so the new roles take effect immediately
    invalidateTokenCache(ownerId);
    invalidateTokenCache(userId);

    // Force both users to reconnect so their WebSocket sessions pick up
    // the new roles immediately (same rationale as role-change kick).
    kickUser(ownerId);
    kickUser(userId);

    writeAuditLog({
      action: 'workspace.ownership_transferred',
      actorId: ownerId,
      targetType: 'user',
      targetId: userId,
      targetName: target.name,
      details: `Workspace ownership transferred to ${target.name}`,
    });

    res.json({ message: 'Ownership transferred successfully' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Admin transfer ownership error', error);
    res.status(500).json({ error: 'Failed to transfer ownership' });
  }
});

export default router;
