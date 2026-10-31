import webpush from 'web-push';
import prisma from '../db.js';
import { logError } from '../utils/logger.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@slawk.dev';

const isConfigured = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (isConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
}

export function getVapidPublicKey(): string | null {
  return VAPID_PUBLIC_KEY || null;
}

interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

// 알림 맥락. 05 상태/DND 파트가 이 값으로 억제 여부를 판단한다.
export interface NotifyContext {
  kind?: 'message' | 'mention' | 'dm' | 'thread';
  channelId?: number;
}

/**
 * 알림을 보내도 되는지 판단하는 훅 자리. 지금은 항상 true.
 * 05 파트(상태/DND)가 방해 금지 시간, 채널 뮤트 등을 여기서 검사하도록 채운다.
 */
export async function shouldNotify(_userId: number, _ctx?: NotifyContext): Promise<boolean> {
  return true;
}

export async function sendPushToUser(userId: number, payload: PushPayload, ctx?: NotifyContext): Promise<void> {
  if (!isConfigured) return;
  if (!(await shouldNotify(userId, ctx))) return;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
  });

  if (subscriptions.length === 0) return;

  const jsonPayload = JSON.stringify(payload);
  const expiredIds: number[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          jsonPayload,
          { TTL: 60 }
        );
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          expiredIds.push(sub.id);
        } else {
          logError(`Push failed for subscription ${sub.id}`, err);
        }
      }
    })
  );

  // Clean up expired subscriptions
  if (expiredIds.length > 0) {
    await prisma.pushSubscription.deleteMany({
      where: { id: { in: expiredIds } },
    }).catch((err) => logError('Failed to clean expired push subscriptions', err));
  }
}
