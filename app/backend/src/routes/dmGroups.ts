import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireDmGroupMember } from '../middleware/authorize.js';
import { AuthRequest } from '../types.js';
import { getIO } from '../websocket/index.js';
import { DM_INCLUDE_USERS } from '../db/selects.js';
import { parsePagination, paginateResults } from '../utils/pagination.js';
import { MAX_MESSAGE_LENGTH } from '../utils/params.js';
import { logError } from '../utils/logger.js';
import { createActivitiesForDm, getMentionCountsByDmGroup, markDmGroupMentionsRead } from '../services/mentionService.js';
import {
  MIN_GROUP_OTHERS,
  MAX_GROUP_SIZE,
  validateGroupUsers,
  findOrCreateGroup,
  getGroupView,
  addGroupMembers,
  leaveGroup,
  sendGroupMessage,
  markGroupRead,
  listGroupConversations,
  emitToGroup,
} from '../services/dmGroupService.js';

// 그룹 DM(/dms/groups). 메시지 단위 경로(편집·삭제·스레드·리액션·핀)는 routes/dms.ts의 /dms/messages/:id를 같이 쓴다.
const router = Router();

const userIdsSchema = z.array(z.number().int().positive()).min(1).max(MAX_GROUP_SIZE * 2);

const createGroupSchema = z.object({ userIds: userIdsSchema });

const sendSchema = z.object({
  content: z.string().max(MAX_MESSAGE_LENGTH)
    .refine(val => !val.includes('\u0000'), { message: 'Content cannot contain null bytes' }),
  fileIds: z.array(z.number().int().positive()).max(10).optional(),
}).refine(
  (data) => (data.content?.trim().length ?? 0) > 0 || (data.fileIds && data.fileIds.length > 0),
  { message: 'Message must have content or file attachments' },
);

const renameSchema = z.object({
  name: z.string().max(100)
    .refine(val => !val.includes('\u0000'), { message: 'Name cannot contain null bytes' })
    .nullable(),
});

const readSchema = z.object({ messageId: z.number().int().positive().optional() });

// POST /dms/groups - 그룹 DM 만들기(같은 멤버 집합이 있으면 그것을 200으로 돌려준다)
router.post('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { userIds } = createGroupSchema.parse(req.body);
    const others = [...new Set(userIds)].filter((id) => id !== userId);
    if (others.length < MIN_GROUP_OTHERS || others.length + 1 > MAX_GROUP_SIZE) {
      res.status(400).json({
        error: `A group conversation needs ${MIN_GROUP_OTHERS} to ${MAX_GROUP_SIZE - 1} other people`,
      });
      return;
    }

    const check = await validateGroupUsers(req.user!, others);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }

    const { groupId, created } = await findOrCreateGroup(userId, others);
    const group = await getGroupView(groupId);
    res.status(created ? 201 : 200).json({ group, created });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Create group DM error', error);
    res.status(500).json({ error: 'Failed to create group conversation' });
  }
});

// GET /dms/groups - 내가 멤버인 그룹 DM 목록(사이드바)
router.get('/', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const conversations = await listGroupConversations(userId);
    const mentionCounts = await getMentionCountsByDmGroup(userId, conversations.map((c) => c.group.id));
    res.json(conversations.map((c) => ({ ...c, mentionCount: mentionCounts.get(c.group.id) ?? 0 })));
  } catch (error) {
    logError('List group DMs error', error);
    res.status(500).json({ error: 'Failed to get group conversations' });
  }
});

// GET /dms/groups/:id - 그룹 정보(멤버 목록)
router.get('/:id', authMiddleware, requireDmGroupMember, async (req: AuthRequest, res: Response) => {
  try {
    const group = await getGroupView(req.dmGroupId!);
    res.json({ group });
  } catch (error) {
    logError('Get group DM error', error);
    res.status(500).json({ error: 'Failed to get group conversation' });
  }
});

// PATCH /dms/groups/:id - 그룹 이름 바꾸기(null이면 멤버 이름 나열로 돌아간다)
router.patch('/:id', authMiddleware, requireDmGroupMember, async (req: AuthRequest, res: Response) => {
  try {
    const groupId = req.dmGroupId!;
    const { name } = renameSchema.parse(req.body);
    const trimmed = name?.trim() || null;
    await prisma.dMGroup.update({ where: { id: groupId }, data: { name: trimmed } });
    await emitToGroup(groupId, 'dmgroup:updated', { id: groupId, name: trimmed });
    const group = await getGroupView(groupId);
    res.json({ group });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Rename group DM error', error);
    res.status(500).json({ error: 'Failed to update group conversation' });
  }
});

// GET /dms/groups/:id/messages - 메시지 목록(커서, around). 첫 페이지를 읽으면 읽음 커서를 마지막 메시지로 옮긴다.
router.get('/:id/messages', authMiddleware, requireDmGroupMember, async (req: AuthRequest, res: Response) => {
  try {
    const groupId = req.dmGroupId!;
    const userId = req.user!.userId;
    const { limit, cursor } = parsePagination(req);
    const aroundRaw = req.query.around ? parseInt(req.query.around as string) : undefined;
    const around = aroundRaw !== undefined && !isNaN(aroundRaw) && aroundRaw > 0 ? aroundRaw : undefined;

    const where = { groupId, deletedAt: null, threadId: null };
    const include = {
      ...DM_INCLUDE_USERS,
      _count: { select: { replies: { where: { deletedAt: null } } } },
      replies: {
        where: { deletedAt: null },
        select: { fromUser: { select: { id: true, name: true, avatar: true } } },
        distinct: ['fromUserId' as const],
        take: 5,
      },
    };
    const enrich = (msgs: any[]) =>
      msgs.map(({ replies, ...rest }) => ({ ...rest, threadParticipants: replies ? replies.map((r: any) => r.fromUser) : [] }));

    let messages: any[];
    let nextCursor: number | undefined;
    let hasMore = false;
    if (around) {
      const half = Math.floor(limit / 2);
      const [before, target, after] = await Promise.all([
        prisma.directMessage.findMany({ where: { ...where, id: { lt: around } }, include, orderBy: { createdAt: 'desc' }, take: half }),
        prisma.directMessage.findMany({ where: { ...where, id: around }, include, take: 1 }),
        prisma.directMessage.findMany({ where: { ...where, id: { gt: around } }, include, orderBy: { createdAt: 'asc' }, take: half }),
      ]);
      messages = enrich([...before.reverse(), ...target, ...after]);
    } else {
      const rows = await prisma.directMessage.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      });
      const page = paginateResults(rows, limit);
      messages = enrich(page.results);
      nextCursor = page.nextCursor;
      hasMore = page.hasMore;
      if (!cursor) {
        await Promise.all([
          markGroupRead(groupId, userId).catch((err) => logError('Group DM read update failed', err)),
          markDmGroupMentionsRead(userId, groupId).catch((err) => logError('Group DM mention read update failed', err)),
        ]);
      }
    }

    const group = await getGroupView(groupId);
    res.json({ group, messages, nextCursor, hasMore });
  } catch (error) {
    logError('Get group DM messages error', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

// POST /dms/groups/:id/messages - 메시지 보내기
router.post('/:id/messages', authMiddleware, requireDmGroupMember, async (req: AuthRequest, res: Response) => {
  try {
    const { content, fileIds } = sendSchema.parse(req.body);
    const dm = await sendGroupMessage({ groupId: req.dmGroupId!, fromUserId: req.user!.userId, content, fileIds });
    res.status(201).json(dm);
    void createActivitiesForDm(dm);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Send group DM error', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// POST /dms/groups/:id/members - 멤버 추가(기존 기록은 새 멤버에게도 보인다)
router.post('/:id/members', authMiddleware, requireDmGroupMember, async (req: AuthRequest, res: Response) => {
  try {
    const groupId = req.dmGroupId!;
    const { userIds } = createGroupSchema.parse(req.body);
    const check = await validateGroupUsers(req.user!, [...new Set(userIds)]);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }
    const result = await addGroupMembers(groupId, req.user!.userId, userIds);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const group = await getGroupView(groupId);
    res.json({ group, addedUserIds: result.addedIds });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Add group DM members error', error);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// DELETE /dms/groups/:id/members/me - 그룹 나가기
router.delete('/:id/members/me', authMiddleware, requireDmGroupMember, async (req: AuthRequest, res: Response) => {
  try {
    await leaveGroup(req.dmGroupId!, req.user!.userId);
    res.json({ left: true });
  } catch (error) {
    logError('Leave group DM error', error);
    res.status(500).json({ error: 'Failed to leave conversation' });
  }
});

// POST /dms/groups/:id/read - 읽음 커서 옮기기(messageId가 없으면 마지막 메시지까지)
router.post('/:id/read', authMiddleware, requireDmGroupMember, async (req: AuthRequest, res: Response) => {
  try {
    const groupId = req.dmGroupId!;
    const userId = req.user!.userId;
    const { messageId } = readSchema.parse(req.body ?? {});
    if (messageId) {
      const target = await prisma.directMessage.findFirst({ where: { id: messageId, groupId }, select: { id: true } });
      if (!target) {
        res.status(404).json({ error: 'Message not found in this conversation' });
        return;
      }
    }
    const lastReadDmId = await markGroupRead(groupId, userId, messageId);
    await markDmGroupMentionsRead(userId, groupId).catch((err) => logError('Group DM mention read update failed', err));
    res.json({ lastReadDmId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues });
      return;
    }
    logError('Mark group DM read error', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// GET /dms/groups/:id/pins - 고정한 메시지
router.get('/:id/pins', authMiddleware, requireDmGroupMember, async (req: AuthRequest, res: Response) => {
  try {
    const pinned = await prisma.directMessage.findMany({
      where: { groupId: req.dmGroupId!, isPinned: true, deletedAt: null },
      include: DM_INCLUDE_USERS,
      orderBy: { pinnedAt: 'desc' },
    });
    res.json(pinned);
  } catch (error) {
    logError('Get group DM pins error', error);
    res.status(500).json({ error: 'Failed to get pinned messages' });
  }
});

// PUT/DELETE /dms/groups/:id/star - 사이드바 별표(멱등). 멤버 행에 저장하므로 나가면 함께 사라진다.
async function setStar(req: AuthRequest, res: Response, isStarred: boolean): Promise<void> {
  try {
    const groupId = req.dmGroupId!;
    const userId = req.user!.userId;
    await prisma.dMGroupMember.update({
      where: { groupId_userId: { groupId, userId } },
      data: { starredAt: isStarred ? new Date() : null },
    });
    getIO()?.to(`user:${userId}`).emit('star:updated', { type: 'group', id: groupId, isStarred });
    res.json({ groupId, isStarred });
  } catch (error) {
    logError('Star group DM error', error);
    res.status(500).json({ error: 'Failed to update star' });
  }
}
router.put('/:id/star', authMiddleware, requireDmGroupMember, (req: AuthRequest, res: Response) => setStar(req, res, true));
router.delete('/:id/star', authMiddleware, requireDmGroupMember, (req: AuthRequest, res: Response) => setStar(req, res, false));

export default router;
