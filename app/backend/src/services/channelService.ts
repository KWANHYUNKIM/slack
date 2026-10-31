import { Prisma, Channel } from '@prisma/client';
import prisma from '../db.js';
import { getIO } from '../websocket/index.js';
import { validateChannelName } from '../utils/channelName.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { channelNameKey } from './workspaceService.js';

// 채널 이름이 이미 쓰이고 있을 때의 오류 코드(클라이언트가 번역 키로 바꿔 보여 준다)
export const CHANNEL_NAME_TAKEN = 'CHANNEL_NAME_TAKEN';
export const CHANNEL_NAME_TAKEN_MESSAGE = 'A channel with that name already exists';

export interface ChannelUpdateInput {
  /** 원문 이름. 현재 이름과 같으면 검증도 변경도 하지 않는다(대문자·80자 초과인 옛 이름 보호) */
  name?: unknown;
  topic?: string | null;
  description?: string | null;
  isPrivate?: boolean;
}

export type ChannelUpdateResult =
  | { ok: true; channel: Channel; changed: boolean }
  | { ok: false; status: number; body: { error: string; code?: string; reason?: string } };

const channelWithCounts = { _count: { select: { members: true, messages: true } } } as const;

// 이름·주제·설명·공개 여부 변경의 공용 경로: 검증, 중복 검사, P2002, 감사 로그, channel:updated 전송.
// PATCH /channels/:id와 PATCH /admin/channels/:id가 함께 쓴다. 권한 검사는 호출한 쪽이 한다.
export async function updateChannel(params: {
  channel: Channel;
  actorId: number;
  input: ChannelUpdateInput;
}): Promise<ChannelUpdateResult> {
  const { channel, actorId, input } = params;
  const data: Prisma.ChannelUpdateInput = {};
  const changes: string[] = [];
  let newName: string | undefined;

  if (input.name !== undefined && input.name !== channel.name) {
    const nameResult = validateChannelName(input.name);
    if (!nameResult.ok) {
      return { ok: false, status: 400, body: { error: nameResult.error, code: nameResult.code, reason: nameResult.reason } };
    }
    if (nameResult.name !== channel.name) {
      // 대소문자 무시 중복 검사(DB 유니크 제약은 대소문자를 구분한다)
      const existing = await prisma.channel.findFirst({
        where: { name: { equals: nameResult.name, mode: 'insensitive' }, id: { not: channel.id } },
        select: { id: true },
      });
      if (existing) {
        return { ok: false, status: 409, body: { error: CHANNEL_NAME_TAKEN_MESSAGE, code: CHANNEL_NAME_TAKEN } };
      }
      data.name = nameResult.name;
      newName = nameResult.name;
      changes.push(`Renamed from #${channel.name} to #${nameResult.name}`);
    }
  }
  if (input.topic !== undefined && input.topic !== channel.topic) {
    data.topic = input.topic;
    changes.push(input.topic === null ? 'Topic cleared' : 'Topic changed');
  }
  if (input.description !== undefined && input.description !== channel.description) {
    data.description = input.description;
    changes.push(input.description === null ? 'Description cleared' : 'Description changed');
  }
  if (input.isPrivate !== undefined && input.isPrivate !== channel.isPrivate) {
    data.isPrivate = input.isPrivate;
    changes.push(`Changed to ${input.isPrivate ? 'private' : 'public'}`);
  }

  if (Object.keys(data).length === 0) {
    return { ok: true, channel, changed: false };
  }

  let updated;
  try {
    // 이름이 바뀌면 채널이 보이는 모든 워크스페이스의 nameKey를 같은 UPDATE 문맥에서 바꾼다(워크스페이스 단위 유일성, E1a).
    // 기본 채널 지정(isDefault·defaultSlot)은 이름·공개 여부와 무관하게 유지한다(자동 가입 대상은 defaultChannelService가 거른다).
    if (newName !== undefined) {
      data.workspaces = { updateMany: { where: {}, data: { nameKey: channelNameKey(newName) } } };
    }
    updated = await prisma.channel.update({ where: { id: channel.id }, data, include: channelWithCounts });
  } catch (error) {
    // 중복 검사와 update 사이에 같은 이름이 먼저 저장된 경우(Channel.name 또는 ChannelWorkspace.nameKey 유니크 제약)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { ok: false, status: 409, body: { error: CHANNEL_NAME_TAKEN_MESSAGE, code: CHANNEL_NAME_TAKEN } };
    }
    throw error;
  }

  await writeAuditLog({
    action: 'channel.edited',
    actorId,
    targetType: 'channel',
    targetId: channel.id,
    targetName: updated.name,
    details: changes.join('; '),
  });

  await emitChannelUpdated(updated);
  return { ok: true, channel: updated, changed: true };
}

// DB 커밋 뒤 알림: 공개 채널은 모두에게(archived·deleted와 같은 방식), 비공개 채널은 멤버 각자의 개인 룸으로
async function emitChannelUpdated(channel: Channel): Promise<void> {
  const io = getIO();
  if (!io) return;
  const payload = {
    id: channel.id,
    name: channel.name,
    topic: channel.topic,
    description: channel.description,
  };
  if (!channel.isPrivate) {
    io.emit('channel:updated', payload);
    return;
  }
  const members = await prisma.channelMember.findMany({
    where: { channelId: channel.id },
    select: { userId: true },
  });
  if (members.length === 0) return;
  let target = io.to(`user:${members[0].userId}`);
  for (const m of members.slice(1)) target = target.to(`user:${m.userId}`);
  target.emit('channel:updated', payload);
}
