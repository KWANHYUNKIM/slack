import prisma from './db.js';
import { getIO } from './websocket/index.js';
import { USER_SELECT_BASIC, FILE_SELECT } from './db/selects.js';
import { logError } from './utils/logger.js';
import { processNewChannelMessage } from './services/mentionService.js';
import { clearExpired } from './services/statusService.js';
import { processDueReminders } from './services/reminderService.js';

const INTERVAL_MS = 30_000; // 30 seconds

let isProcessing = false;

/**
 * 시각이 된 예약 메시지를 보낸다. 스케줄러 틱과 테스트가 함께 부르는 단일 진입점이다.
 * 겹치는 호출은 isProcessing으로 건너뛴다. 같은 예약을 두 번 보내지 않게 claim(sent=false → true)도 한다.
 */
export async function processDueScheduledMessages(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
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
  } finally {
    isProcessing = false;
  }
}

export function startScheduler(): NodeJS.Timeout {
  console.log('Scheduler started — checking every 30s for due messages');

  const handle = setInterval(() => {
    // 만료된 커스텀 상태와 방해금지 정리는 예약 메시지 처리를 막지 않게 기다리지 않고 돌린다.
    void clearExpired().catch((err) => logError('Scheduler: clearExpired failed', err));
    // 리마인더도 예약 메시지 처리를 막지 않게 따로 돌린다. 겹치는 틱은 firedAt 선점이 막는다.
    void processDueReminders().catch((err) => logError('Scheduler: processDueReminders failed', err));
    void processDueScheduledMessages();
  }, INTERVAL_MS);

  return handle;
}
