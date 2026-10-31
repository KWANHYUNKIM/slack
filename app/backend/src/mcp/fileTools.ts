import fs from 'fs';
import path from 'path';
import type { Prisma } from '@prisma/client';
import prisma from '../db.js';
import { checkDmGroupMembership, verifyFileAccess, verifyFilesAccess } from '../middleware/authorize.js';
import { sharesChannel } from '../services/dmService.js';
import { paginateResults } from '../utils/pagination.js';
import { logError } from '../utils/logger.js';
import { ToolAccessError, type ToolContext } from './readTools.js';

// MCP 파일 도구(mcp-3): list_files(메타데이터)와 read_file(텍스트 내용).
// 권한은 PR #52의 파일 접근 규칙(verifyFileAccess / verifyFilesAccess)을 그대로 쓴다.
// 응답에는 다운로드 토큰·URL·저장 경로(url, filename, gcsPath)를 넣지 않는다.
// DM에 붙은 파일은 files:read만으로는 볼 수 없고 im:history 범위가 더 있어야 한다.

const NOT_ACCESSIBLE_FILE = 'File not found or not accessible';
const NOT_ACCESSIBLE_CHANNEL = 'Channel not found or not accessible';
const NOT_ACCESSIBLE_CONVERSATION = 'Conversation not found or not accessible';
const DM_SCOPE = 'im:history';

/** read_file이 내용을 돌려주는 최대 크기(바이트). 넘으면 메타데이터만 돌려준다. */
export const MAX_READ_FILE_BYTES = 256 * 1024;

// 업로드 허용 형식 중 텍스트 계열(text/*, JSON)과 흔한 텍스트 형식만 읽는다
const TEXT_MIMES = new Set([
  'application/json', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/toml',
  'application/javascript', 'application/x-ndjson', 'application/sql',
]);

export function isTextMimetype(mimetype: string): boolean {
  const base = mimetype.split(';')[0].trim().toLowerCase();
  return base.startsWith('text/') || TEXT_MIMES.has(base) || base.endsWith('+json') || base.endsWith('+xml');
}

// 업로드 위치(routes/files.ts의 uploadDir과 같다)
const uploadDir = path.join(process.cwd(), 'uploads');

const FILE_META_SELECT = {
  id: true, originalName: true, mimetype: true, size: true, createdAt: true, messageId: true, dmId: true,
  user: { select: { id: true, name: true } },
  message: { select: { channelId: true } },
  dm: { select: { groupId: true, fromUserId: true, toUserId: true } },
} satisfies Prisma.FileSelect;

type FileMetaRow = Prisma.FileGetPayload<{ select: typeof FILE_META_SELECT }>;

function toFileMeta(f: FileMetaRow, ctxUserId: number) {
  return {
    id: f.id,
    name: f.originalName,
    mimetype: f.mimetype,
    size: f.size,
    createdAt: f.createdAt,
    user: f.user,
    channelId: f.message?.channelId ?? null,
    messageId: f.messageId,
    dmId: f.dmId,
    groupId: f.dm?.groupId ?? null,
    // 1:1 DM이면 상대 사용자 id
    otherUserId: f.dm && !f.dm.groupId ? (f.dm.fromUserId === ctxUserId ? f.dm.toUserId : f.dm.fromUserId) : null,
    readable: isTextMimetype(f.mimetype) && f.size <= MAX_READ_FILE_BYTES,
  };
}

/** 1:1 DM 상대를 볼 수 있는지: 상대가 있어야 하고, 게스트는 채널을 공유하는 상대만(자기 자신은 가능) */
async function assertCanSeeUserDm(ctx: ToolContext, otherUserId: number) {
  if (otherUserId === ctx.userId) return;
  const other = await prisma.user.findUnique({ where: { id: otherUserId }, select: { id: true } });
  if (!other) throw new ToolAccessError(NOT_ACCESSIBLE_CONVERSATION);
  if (ctx.role === 'GUEST' && !(await sharesChannel(ctx.userId, otherUserId))) throw new ToolAccessError(NOT_ACCESSIBLE_CONVERSATION);
}

export async function listFiles(
  ctx: ToolContext,
  args: { channelId?: number; userId?: number; groupId?: number; limit: number; cursor?: number },
) {
  const targets = [args.channelId, args.userId, args.groupId].filter((v) => v !== undefined).length;
  if (targets > 1) throw new ToolAccessError('Provide at most one of channelId, userId or groupId');

  let where: Prisma.FileWhereInput;
  if (args.channelId !== undefined) {
    // 파일 접근 규칙이 멤버십을 요구하므로 비멤버는 없는 채널과 같게 답한다
    const member = await prisma.channelMember.findUnique({
      where: { userId_channelId: { userId: ctx.userId, channelId: args.channelId } },
      select: { userId: true },
    });
    if (!member) throw new ToolAccessError(NOT_ACCESSIBLE_CHANNEL);
    where = { message: { channelId: args.channelId, deletedAt: null } };
  } else if (args.groupId !== undefined || args.userId !== undefined) {
    if (!ctx.scopes.includes(DM_SCOPE)) throw new ToolAccessError(`Listing files in direct messages requires the ${DM_SCOPE} scope`);
    if (args.groupId !== undefined) {
      if (!(await checkDmGroupMembership(ctx.userId, args.groupId))) throw new ToolAccessError(NOT_ACCESSIBLE_CONVERSATION);
      where = { dm: { groupId: args.groupId, deletedAt: null } };
    } else {
      await assertCanSeeUserDm(ctx, args.userId!);
      where = {
        dm: {
          groupId: null,
          deletedAt: null,
          OR: [
            { fromUserId: ctx.userId, toUserId: args.userId },
            { fromUserId: args.userId, toUserId: ctx.userId },
          ],
        },
      };
    }
  } else {
    // 대상을 안 주면 내가 속한 채널의 파일만(DM 파일은 대화를 지정해야 한다)
    const memberships = await prisma.channelMember.findMany({ where: { userId: ctx.userId }, select: { channelId: true } });
    where = { message: { channelId: { in: memberships.map((m) => m.channelId) }, deletedAt: null } };
  }

  const rows = await prisma.file.findMany({
    where: { ...where, ...(args.cursor && { id: { lt: args.cursor } }) },
    select: FILE_META_SELECT,
    orderBy: { id: 'desc' },
    take: args.limit + 1,
  });
  const { results, nextCursor } = paginateResults(rows, args.limit);
  // 위 조건은 범위를 좁힐 뿐이다. 최종 접근 판단은 REST 다운로드와 같은 verifyFilesAccess가 한다.
  const allowed = await verifyFilesAccess(ctx.userId, results.map((f) => f.id));
  return { items: results.filter((f) => allowed.has(f.id)).map((f) => toFileMeta(f, ctx.userId)), nextCursor: nextCursor ?? null };
}

type ReadOutcome = { bytes: Buffer } | { reason: 'unavailable' };

/** 저장소(로컬 디스크 또는 GCS)에서 앞부분 최대 maxBytes 바이트를 읽는다 */
async function readStoredBytes(file: { filename: string; gcsPath: string | null }, maxBytes: number): Promise<ReadOutcome> {
  try {
    if (file.gcsPath) {
      const bucketName = process.env.GCS_BUCKET_NAME;
      if (!bucketName) return { reason: 'unavailable' };
      const { Storage } = await import('@google-cloud/storage');
      const [bytes] = await new Storage().bucket(bucketName).file(file.gcsPath).download({ start: 0, end: maxBytes - 1 });
      return { bytes };
    }
    const filePath = path.resolve(uploadDir, file.filename);
    if (!filePath.startsWith(uploadDir + path.sep)) return { reason: 'unavailable' };
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return { bytes: buf.subarray(0, bytesRead) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    logError('MCP read_file storage error', error);
    return { reason: 'unavailable' };
  }
}

export async function readFile(ctx: ToolContext, args: { fileId: number }) {
  const file = await verifyFileAccess(ctx.userId, args.fileId);
  if (!file) throw new ToolAccessError(NOT_ACCESSIBLE_FILE);
  if (file.dmId && !file.messageId) {
    // DM 파일은 im:history 범위와 게스트 격리(1:1은 채널을 공유하는 상대만)를 더 확인한다
    if (!ctx.scopes.includes(DM_SCOPE)) throw new ToolAccessError(NOT_ACCESSIBLE_FILE);
    const dm = await prisma.directMessage.findUnique({ where: { id: file.dmId }, select: { groupId: true, fromUserId: true, toUserId: true } });
    if (dm && !dm.groupId && ctx.role === 'GUEST') {
      const otherId = dm.fromUserId === ctx.userId ? dm.toUserId : dm.fromUserId;
      if (otherId !== null && otherId !== ctx.userId && !(await sharesChannel(ctx.userId, otherId))) throw new ToolAccessError(NOT_ACCESSIBLE_FILE);
    }
  }

  const meta = {
    id: file.id,
    name: file.originalName as string,
    mimetype: file.mimetype as string,
    size: file.size as number,
    createdAt: file.createdAt,
    user: file.user,
  };
  // 내용을 못 주는 경우에도 메타데이터는 돌려준다(다운로드 URL은 넣지 않는다)
  if (!isTextMimetype(meta.mimetype)) return { ...meta, content: null, reason: 'not_text' };
  if (meta.size > MAX_READ_FILE_BYTES) return { ...meta, content: null, reason: 'too_large', maxBytes: MAX_READ_FILE_BYTES };

  // DB의 size를 믿지 않고 상한+1바이트까지만 읽어 상한을 넘는지 다시 확인한다
  const outcome = await readStoredBytes(file, MAX_READ_FILE_BYTES + 1);
  if ('reason' in outcome) return { ...meta, content: null, reason: outcome.reason };
  if (outcome.bytes.length > MAX_READ_FILE_BYTES) return { ...meta, content: null, reason: 'too_large', maxBytes: MAX_READ_FILE_BYTES };
  // NUL 바이트가 있거나 UTF-8이 아니면 텍스트가 아니다(mimetype만 text인 바이너리)
  if (outcome.bytes.includes(0)) return { ...meta, content: null, reason: 'not_text' };
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(outcome.bytes);
  } catch {
    return { ...meta, content: null, reason: 'not_text' };
  }
  return { ...meta, content, reason: null };
}
