import prisma from './db.js';
import { getIO } from './websocket/index.js';
import { USER_SELECT_BASIC, FILE_SELECT } from './db/selects.js';
import { logError } from './utils/logger.js';
import { processNewChannelMessage } from './services/mentionService.js';
import { clearExpired } from './services/statusService.js';
import { processDueReminders } from './services/reminderService.js';
import { getAuditRetentionDays } from './config.js';
import { purgeOldAuditLogs } from './utils/auditLog.js';
import { purgeSessions } from './services/sessionService.js';
import { purgeMfaChallenges } from './services/mfaService.js';
import { purgeExpiredMessages, type PurgeCounts } from './services/retentionService.js';

const INTERVAL_MS = 30_000; // 30 seconds

// 처리 중이면 진행 중인 Promise를 돌려준다. 호출자는 끝날 때까지 기다린 뒤 결과를 본다(건너뛰지 않는다).
let inFlight: Promise<void> | null = null;

/**
 * 시각이 된 예약 메시지를 보낸다. 스케줄러 틱과 테스트가 함께 부르는 단일 진입점이다.
 * 같은 예약을 두 번 보내지 않게 claim(sent=false → true)도 한다.
 */
export function processDueScheduledMessages(): Promise<void> {
  if (!inFlight) {
    inFlight = runDueScheduledMessages().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function runDueScheduledMessages(): Promise<void> {
  try {
    const due = await prisma.scheduledMessage.findMany({
      where: {
        sent: false,
        scheduledAt: { lte: new Date() },
      },
      include: {
        user: { select: USER_SELECT_BASIC },
        channel: { select: { id: true, name: true } },
      },
      take: 50, // process up to 50 per tick
    });

    if (due.length === 0) return;

    const io = getIO();

    for (const scheduled of due) {
      try {
        // Verify user is not deactivated
        const user = await prisma.user.findUnique({
          where: { id: scheduled.userId },
          select: { deactivatedAt: true },
        });

        if (user?.deactivatedAt) {
          // User has been deactivated — cancel the scheduled message
          await prisma.scheduledMessage.update({
            where: { id: scheduled.id },
            data: { sent: true },
          });
          console.log(
            `Scheduler: cancelled scheduled message ${scheduled.id} — user ${scheduled.userId} has been deactivated`
          );
          continue;
        }

        // Atomically claim, re-verify authorization, and create message.
        // Membership and archival are checked inside the transaction to
        // close the TOCTOU gap — without this, a user removed from the
        // channel between the check and the INSERT could still inject a
        // message into a channel they no longer belong to.
        const message = await prisma.$transaction(async (tx) => {
          const claimed = await tx.scheduledMessage.updateMany({
            where: { id: scheduled.id, sent: false },
            data: { sent: true },
          });
          if (claimed.count === 0) return null; // Already processed

          // Verify membership inside transaction
          const membership = await tx.channelMember.findUnique({
            where: {
              userId_channelId: {
                userId: scheduled.userId,
                channelId: scheduled.channelId,
              },
            },
          });
          if (!membership) return { cancelled: 'not-member' as const };

          // Verify channel is not archived inside transaction
          const channel = await tx.channel.findUnique({
            where: { id: scheduled.channelId },
            select: { archivedAt: true },
          });
          if (channel?.archivedAt) return { cancelled: 'archived' as const };

          const msg = await tx.message.create({
            data: {
              content: scheduled.content,
              userId: scheduled.userId,
              channelId: scheduled.channelId,
            },
            include: {
              user: { select: USER_SELECT_BASIC },
              files: { select: FILE_SELECT },
            },
          });
          return msg;
        });

        if (!message) continue; // Already claimed by another instance

        if ('cancelled' in message) {
          const reason = message.cancelled === 'not-member'
            ? `user ${scheduled.userId} is no longer a member of channel ${scheduled.channelId}`
            : `channel ${scheduled.channelId} has been archived`;
          console.log(`Scheduler: cancelled scheduled message ${scheduled.id} — ${reason}`);
          continue;
        }

        // Broadcast via WebSocket to the channel
        if (io) {
          io.to(`channel:${scheduled.channelId}`).emit('message:new', message);
        }

        // 활동 생성과 푸시(예약 발송도 멘션을 알린다). 응답 경로와 같은 서비스를 await 없이 부른다.
        void processNewChannelMessage(message, { generalPush: true });

        console.log(
          `Scheduler: sent message ${message.id} to channel ${scheduled.channelId} (was scheduled ${scheduled.id})`
        );
      } catch (err) {
        logError(`Scheduler: failed to send scheduled message ${scheduled.id}`, err);
      }
    }
  } catch (err) {
    logError('Scheduler tick error', err);
  }
}

const AUDIT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 성공하면 하루 뒤
const AUDIT_PURGE_RETRY_MS = 60 * 60 * 1000; // 실패하면 1시간 뒤 재시도(백오프)
let nextAuditPurgeAt = 0;

/** 틱마다 불러도 하루에 한 번만 오래된 감사 로그를 정리한다. 보존 기간이 0(무기한)이면 건너뛴다. 실패하면 1시간 뒤 다시 시도한다. */
export async function purgeAuditLogsIfDue(now: number = Date.now()): Promise<number> {
  const days = getAuditRetentionDays();
  if (days <= 0 || now < nextAuditPurgeAt) return 0;
  try {
    const removed = await purgeOldAuditLogs(days, new Date(now));
    nextAuditPurgeAt = now + AUDIT_PURGE_INTERVAL_MS;
    return removed;
  } catch (err) {
    nextAuditPurgeAt = now + AUDIT_PURGE_RETRY_MS;
    throw err;
  }
}

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 성공하면 하루 뒤
const RETENTION_RETRY_MS = 60 * 60 * 1000; // 실패하면 1시간 뒤 재시도(백오프)
let nextRetentionAt = 0;
let retentionRunning = false; // 정리가 길어져도 겹쳐 돌지 않는다

/** 틱마다 불러도 하루에 한 번만 보존 정책에 따라 만료된 메시지를 지운다. 정책이 없으면 아무것도 지우지 않는다. 실패하면 1시간 뒤 다시 시도한다. */
export async function purgeRetentionIfDue(now: number = Date.now()): Promise<PurgeCounts | null> {
  if (retentionRunning || now < nextRetentionAt) return null;
  retentionRunning = true;
  try {
    const result = await purgeExpiredMessages(new Date(now));
    nextRetentionAt = now + RETENTION_INTERVAL_MS;
    return result;
  } catch (err) {
    nextRetentionAt = now + RETENTION_RETRY_MS;
    throw err;
  } finally {
    retentionRunning = false;
  }
}

/** 테스트용: 다음 실행 시각을 되돌린다 */
export function resetRetentionSchedule(): void {
  nextRetentionAt = 0;
}

const SESSION_PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1시간에 한 번이면 충분하다(만료 판정은 요청 때 따로 한다)
let nextSessionPurgeAt = 0;

/** 틱마다 불러도 1시간에 한 번만 만료, 유휴 초과, 폐기된 세션 행을 지운다. 지운 행 수를 돌려준다. */
export async function purgeSessionsIfDue(now: number = Date.now()): Promise<number> {
  if (now < nextSessionPurgeAt) return 0;
  nextSessionPurgeAt = now + SESSION_PURGE_INTERVAL_MS;
  return purgeSessions(new Date(now));
}

const MFA_CHALLENGE_PURGE_INTERVAL_MS = 10 * 60 * 1000; // 대기는 5분짜리라 10분마다 치운다(유효성은 요청 때 따로 본다)
let nextMfaChallengePurgeAt = 0;

/** 틱마다 불러도 10분에 한 번만 만료됐거나 닫힌 2FA 로그인 대기(E7b)를 지운다. 지운 행 수를 돌려준다. */
export async function purgeMfaChallengesIfDue(now: number = Date.now()): Promise<number> {
  if (now < nextMfaChallengePurgeAt) return 0;
  nextMfaChallengePurgeAt = now + MFA_CHALLENGE_PURGE_INTERVAL_MS;
  return purgeMfaChallenges(new Date(now));
}

export function startScheduler(): NodeJS.Timeout {
  console.log('Scheduler started — checking every 30s for due messages');

  const handle = setInterval(() => {
    void purgeSessionsIfDue().catch((err) => logError('Scheduler: purgeSessions failed', err));
    void purgeMfaChallengesIfDue().catch((err) => logError('Scheduler: purgeMfaChallenges failed', err));
    void purgeAuditLogsIfDue().catch((err) => logError('Scheduler: purgeAuditLogs failed', err));
    void purgeRetentionIfDue().catch((err) => logError('Scheduler: purgeRetention failed', err));
    // 만료된 커스텀 상태와 방해금지 정리는 예약 메시지 처리를 막지 않게 기다리지 않고 돌린다.
    void clearExpired().catch((err) => logError('Scheduler: clearExpired failed', err));
    // 리마인더도 예약 메시지 처리를 막지 않게 따로 돌린다. 겹치는 틱은 firedAt 선점이 막는다.
    void processDueReminders().catch((err) => logError('Scheduler: processDueReminders failed', err));
    void processDueScheduledMessages();
  }, INTERVAL_MS);

  return handle;
}
