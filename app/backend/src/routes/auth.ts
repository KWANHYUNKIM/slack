import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { JWT_SECRET } from '../config.js';
import { authMiddleware, invalidateTokenCache } from '../middleware/auth.js';
import { AuthRequest } from '../types.js';
import { logError } from '../utils/logger.js';
import { kickUser } from '../websocket/index.js';
import { BCRYPT_ROUNDS, displayNameSchema, emailSchema, newPasswordSchema } from '../utils/authSchemas.js';
import { ERR } from '../utils/errorCodes.js';
import { joinDefaultChannels } from '../services/defaultChannelService.js';

const router = Router();
const isTest = process.env.NODE_ENV === 'test';

const registerSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
  name: displayNameSchema,
  inviteCode: z.string().max(64).optional(),
});

const loginSchema = z.object({
  email: z.string().email().transform(e => e.toLowerCase()),
  password: z.string().min(1).max(72),
});

// Account lockout: track failed login attempts per email
const loginAttempts = new Map<string, { count: number; lockedUntil: number; lastAttempt: number }>();
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOCKOUT_ENTRIES = 10_000;

// Periodic cleanup of stale lockout entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [email, entry] of loginAttempts) {
    // Remove expired lockouts and stale attempt counters (no activity within lockout window)
    if (
      (entry.lockedUntil > 0 && entry.lockedUntil < now) ||
      (entry.lockedUntil === 0 && (now - entry.lastAttempt) > LOCKOUT_DURATION_MS)
    ) {
      loginAttempts.delete(email);
    }
  }
}, 5 * 60 * 1000).unref();

// POST /auth/register
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name, inviteCode } = registerSchema.parse(req.body);

    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser) {
      // Perform dummy hash to normalize timing (prevent user-enumeration via response time)
      await bcrypt.hash(password, BCRYPT_ROUNDS);
      res.status(400).json({ error: 'Unable to complete registration', code: ERR.AUTH_REGISTRATION_FAILED });
      return;
    }

    // Require invite code — no open registration (relaxed in test env for convenience)
    if (!inviteCode && !isTest) {
      res.status(400).json({ error: 'An invite is required to register', code: ERR.INVITE_REQUIRED });
      return;
    }

    // Pre-validate invite code format (early rejection before hashing)
    if (inviteCode) {
      const invite = await prisma.inviteLink.findUnique({ where: { code: inviteCode } });
      if (!invite) {
        res.status(400).json({ error: 'Invalid invite code', code: ERR.INVITE_INVALID });
        return;
      }
      if (invite.expiresAt && invite.expiresAt < new Date()) {
        res.status(400).json({ error: 'Invite code has expired', code: ERR.INVITE_EXPIRED });
        return;
      }
      if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
        res.status(400).json({ error: 'Invite code has reached its usage limit', code: ERR.INVITE_EXHAUSTED });
        return;
      }
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Use transaction to atomically validate invite + create user + increment useCount
    const user = await prisma.$transaction(async (tx) => {
      let assignedRole: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST' = 'MEMBER';

      if (inviteCode) {
        // Atomic check-and-increment: a single UPDATE with WHERE conditions
        // eliminates the race window between findUnique and update that existed
        // under READ COMMITTED isolation (two concurrent registrations could
        // both read useCount=0 with maxUses=1, both pass the check, both increment).
        const claimed = await tx.$queryRaw<Array<{ id: number; role: string }>>`
          UPDATE "InviteLink"
          SET "useCount" = "useCount" + 1
          WHERE "code" = ${inviteCode}
            AND ("expiresAt" IS NULL OR "expiresAt" >= NOW())
            AND ("maxUses" IS NULL OR "useCount" < "maxUses")
          RETURNING id, role
        `;
        if (claimed.length === 0) {
          throw new Error('INVITE_INVALID');
        }
        // Cap self-service registration to MEMBER/GUEST — OWNER/ADMIN require admin action
        const inviteRole = claimed[0].role;
        assignedRole = (inviteRole === 'MEMBER' || inviteRole === 'GUEST') ? inviteRole as 'MEMBER' | 'GUEST' : 'MEMBER';
      }

      return tx.user.create({
        data: {
          email,
          password: hashedPassword,
          name,
          role: assignedRole,
        },
        select: {
          id: true,
          name: true,
          role: true,
          createdAt: true,
        },
      });
    });

    // Auto-join default channels — guests get NO auto-join (admin assigns channels)
    if (user.role !== 'GUEST') {
      try {
        await joinDefaultChannels(prisma, user.id);
      } catch (error) {
        // Non-critical: don't fail registration if auto-join fails
        logError('Default channel join error', error);
      }
    }

    const token = jwt.sign({ userId: user.id, tokenVersion: 0 }, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });

    res.status(201).json({ user, token });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    if (error instanceof Error && error.message === 'INVITE_INVALID') {
      res.status(400).json({ error: 'Invite code is no longer valid', code: ERR.INVITE_INVALID });
      return;
    }
    // Handle unique constraint violation (concurrent registration race).
    // Return the same status + message as the normal existing-email path
    // so concurrent requests can't differentiate "email already existed"
    // (400) from "email just now taken by a racing request" (was 500).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      res.status(400).json({ error: 'Unable to complete registration', code: ERR.AUTH_REGISTRATION_FAILED });
      return;
    }
    logError('Register error', error);
    res.status(500).json({ error: 'Failed to register user', code: ERR.INTERNAL_ERROR });
  }
});

// POST /auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    // Check account lockout
    const attempts = loginAttempts.get(email);
    if (attempts && attempts.lockedUntil > Date.now()) {
      res.status(429).json({ error: 'Account temporarily locked. Try again later.', code: ERR.AUTH_ACCOUNT_LOCKED });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true, email: true, name: true, avatar: true, role: true,
        password: true, deactivatedAt: true, tokenVersion: true, createdAt: true, locale: true, timeZone: true,
      },
    });
    if (!user) {
      // Dummy bcrypt to normalize response time (prevent timing-based email enumeration)
      await bcrypt.compare(password, '$2b$10$invalidhashfortimingpadding.padding');
      if (loginAttempts.size < MAX_LOCKOUT_ENTRIES) {
        const now = Date.now();
        const current = loginAttempts.get(email) || { count: 0, lockedUntil: 0, lastAttempt: now };
        current.count++;
        current.lastAttempt = now;
        if (current.count >= MAX_FAILED_ATTEMPTS) {
          current.lockedUntil = now + LOCKOUT_DURATION_MS;
          current.count = 0;
        }
        loginAttempts.set(email, current);
      }
      res.status(401).json({ error: 'Invalid credentials', code: ERR.AUTH_INVALID_CREDENTIALS });
      return;
    }

    // Block deactivated accounts — still run bcrypt to prevent timing enumeration
    const validPassword = await bcrypt.compare(password, user.password);
    if (user.deactivatedAt) {
      res.status(401).json({ error: 'Invalid credentials', code: ERR.AUTH_INVALID_CREDENTIALS });
      return;
    }
    if (!validPassword) {
      if (loginAttempts.size < MAX_LOCKOUT_ENTRIES) {
        const now = Date.now();
        const current = loginAttempts.get(email) || { count: 0, lockedUntil: 0, lastAttempt: now };
        current.count++;
        current.lastAttempt = now;
        if (current.count >= MAX_FAILED_ATTEMPTS) {
          current.lockedUntil = now + LOCKOUT_DURATION_MS;
          current.count = 0;
        }
        loginAttempts.set(email, current);
      }
      res.status(401).json({ error: 'Invalid credentials', code: ERR.AUTH_INVALID_CREDENTIALS });
      return;
    }

    // Clear failed attempts on successful login
    loginAttempts.delete(email);

    const token = jwt.sign({ userId: user.id, tokenVersion: user.tokenVersion }, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        role: user.role,
        createdAt: user.createdAt,
        locale: user.locale,
        timeZone: user.timeZone,
      },
      token,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('Login error', error);
    res.status(500).json({ error: 'Failed to login', code: ERR.INTERNAL_ERROR });
  }
});

// POST /auth/change-password
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(72),
  newPassword: newPasswordSchema,
});

// Brute-force protection for password change (keyed on userId, not email,
// since this endpoint is authenticated).  Without this, an attacker with
// a stolen JWT can dictionary-attack the currentPassword at 120 req/min.
const passwordChangeAttempts = new Map<number, { count: number; lockedUntil: number; lastAttempt: number }>();
const MAX_PW_CHANGE_ATTEMPTS = 5;
const PW_CHANGE_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

setInterval(() => {
  const now = Date.now();
  for (const [uid, entry] of passwordChangeAttempts) {
    if (
      (entry.lockedUntil > 0 && entry.lockedUntil < now) ||
      (entry.lockedUntil === 0 && (now - entry.lastAttempt) > PW_CHANGE_LOCKOUT_MS)
    ) {
      passwordChangeAttempts.delete(uid);
    }
  }
}, 5 * 60 * 1000).unref();

router.post('/change-password', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    // Check lockout before any DB or bcrypt work
    const pwAttempts = passwordChangeAttempts.get(userId);
    if (pwAttempts && pwAttempts.lockedUntil > Date.now()) {
      res.status(429).json({ error: 'Too many failed attempts. Try again later.', code: ERR.AUTH_TOO_MANY_ATTEMPTS });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, password: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found', code: ERR.NOT_FOUND });
      return;
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      // Track failed attempt
      const now = Date.now();
      const current = passwordChangeAttempts.get(userId) || { count: 0, lockedUntil: 0, lastAttempt: now };
      current.count++;
      current.lastAttempt = now;
      if (current.count >= MAX_PW_CHANGE_ATTEMPTS) {
        current.lockedUntil = now + PW_CHANGE_LOCKOUT_MS;
        current.count = 0;
      }
      passwordChangeAttempts.set(userId, current);
      res.status(401).json({ error: 'Current password is incorrect', code: ERR.AUTH_CURRENT_PASSWORD_INCORRECT });
      return;
    }

    // Clear failed attempts on success
    passwordChangeAttempts.delete(userId);

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Increment tokenVersion to invalidate all existing sessions
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 },
      },
      select: { id: true, tokenVersion: true },
    });

    // Invalidate cached auth so the revoked token is rejected immediately
    invalidateTokenCache(userId);

    // Immediately disconnect all WebSocket connections for this user
    // (don't wait for the 5-minute periodic revalidation — the password
    // change may be in response to a compromised account)
    kickUser(userId);

    // Issue a fresh token with the new tokenVersion
    const token = jwt.sign({ userId: updated.id, tokenVersion: updated.tokenVersion }, JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '7d',
    });

    res.json({ message: 'Password changed successfully', token });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues, code: ERR.VALIDATION_FAILED });
      return;
    }
    logError('Change password error', error);
    res.status(500).json({ error: 'Failed to change password', code: ERR.INTERNAL_ERROR });
  }
});

// GET /auth/invite/:code - Validate invite code (public, no auth required)
router.get('/invite/:code', async (req: Request, res: Response) => {
  try {
    const code = req.params.code as string;
    if (!code || code.length > 64) {
      res.status(400).json({ error: 'Invalid invite code', code: ERR.INVITE_INVALID });
      return;
    }

    const invite = await prisma.inviteLink.findUnique({
      where: { code },
      select: { role: true, expiresAt: true, maxUses: true, useCount: true },
    });

    if (!invite) {
      res.status(404).json({ error: 'Invite not found', code: ERR.INVITE_NOT_FOUND });
      return;
    }

    if (invite.expiresAt && invite.expiresAt < new Date()) {
      res.status(410).json({ error: 'Invite expired', code: ERR.INVITE_EXPIRED });
      return;
    }

    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
      res.status(410).json({ error: 'Invite exhausted', code: ERR.INVITE_EXHAUSTED });
      return;
    }

    res.json({ valid: true, role: invite.role });
  } catch (error) {
    logError('Validate invite error', error);
    res.status(500).json({ error: 'Failed to validate invite', code: ERR.INTERNAL_ERROR });
  }
});

export default router;
