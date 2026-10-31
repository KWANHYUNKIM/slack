import webpush from 'web-push';
import prisma from '../db.js';
import { logError } from '../utils/logger.js';
import { isUserDnd } from './statusService.js';

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@slawk.dev';

// 키는 환경 변수에서 호출 시점에 읽는다(테스트가 키를 주입할 수 있게). 설정은 키가 바뀔 때만 다시 한다.
let appliedKeys: string | null = null;

function ensureConfigured(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  if (appliedKeys !== `${pub}:${priv}`) {
    webpush.setVapidDetails(VAPID_SUBJECT, pub, priv);
    appliedKeys = `${pub}:${priv}`;
  }
  return true;
}

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

// 알림 맥락. 05 상태/DND 파트가 이 값으로 억제 여부를 판단한다.
export interface NotifyContext {
  kind?: 'message' | 'mention' | 'dm' | 'thread' | 'reminder';
  channelId?: number;
}

/**
 * 알림을 보내도 되는지 판단하는 훅. 채널 메시지, 1:1 DM, 그룹 DM, 스레드 답글 푸시가 모두 sendPushToUser를 거치므로 여기서 한 번만 막으면 된다.
 * 지금은 방해금지(DND)가 켜져 있으면 false. 채널 뮤트 등은 08 파트가 이어서 채운다.
 * 활동(Activity) 기록은 이 훅과 무관하게 남는다(DND가 끝난 뒤 활동 탭에서 확인).
 */
export async function shouldNotify(userId: number, _ctx?: NotifyContext): Promise<boolean> {
  if (await isUserDnd(userId)) return false;
  return true;
}

export async function sendPushToUser(userId: number, payload: PushPayload, ctx?: NotifyContext): Promise<void> {
  if (!ensureConfigured()) return;
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
