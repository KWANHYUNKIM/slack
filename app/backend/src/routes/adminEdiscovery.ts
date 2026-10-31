import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { AuthRequest } from '../types.js';
import { parsePagination } from '../utils/pagination.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import { ERR } from '../utils/errorCodes.js';
import { EXPORT_TOKEN_TTL_MS, issueExportToken, consumeExportToken, writeWithBackpressure } from '../services/auditLogService.js';
import {
  SEARCH_KINDS,
  SearchKind,
  discoveryFilterSchema,
  discoveryBinding,
  filterSummary,
  custodianIds,
  holdWithCustodians,
  createdAtRange,
  isNewSearchFilter,
  countAll,
  search,
  iterateRecords,
} from '../services/ediscoveryService.js';

const router = Router();

// eDiscovery(E6). 비공개 채널과 DM 내용까지 보이므로 일반 검색 API와 나눈 관리자 전용 라우트다.
// 검색과 내보내기 모두 감사 로그를 남긴다(검색어 원문은 남기지 않는다).

const kindSchema = z.enum(SEARCH_KINDS).default('channel');

const holdNotFound = (res: Response) => res.status(404).json({ error: 'Legal hold not found', code: ERR.LEGAL_HOLD_NOT_FOUND });

// GET /admin/ediscovery/export?holdId=&q=&from=&to=&token= - JSONL 스트리밍
// 브라우저가 <a href>로 디스크에 바로 받게 하려고 감사 로그 내보내기처럼 1회용 토큰(POST /export-token)으로 인증한다.
// authMiddleware보다 먼저 등록해 헤더 없는 요청도 이 핸들러가 받는다.
router.get('/ediscovery/export', async (req: Request, res: Response) => {
  let userId: number | null = null;
  let holdId = 0;
  const counts: Record<SearchKind, number> = { channel: 0, dm: 0, file: 0 };
  let complete = false;
  let started = false;
  try {
    const filter = discoveryFilterSchema.safeParse(req.query);
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!filter.success) {
      res.status(400).json({ error: 'Invalid export request' });
      return;
    }
    userId = token ? consumeExportToken(token, discoveryBinding(filter.data)) : null;
    if (!userId) {
      res.status(403).json({ error: 'Invalid or expired export token' });
      return;
    }
    // 발급 이후에 권한을 잃었을 수 있으니 지금 다시 확인한다
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, deactivatedAt: true } });
    if (!user || user.deactivatedAt || (user.role !== 'ADMIN' && user.role !== 'OWNER')) {
      res.status(403).json({ error: 'Admin access required', code: ERR.ADMIN_REQUIRED });
      return;
    }
    holdId = filter.data.holdId;
    const found = await holdWithCustodians(holdId);
    if (!found) return void holdNotFound(res);
    const { hold, custodians } = found;
    const ids = custodians.map((c) => c.id);
    const range = createdAtRange(filter.data);

    const stamp = new Date().toISOString().slice(0, 10);
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ediscovery-hold-${holdId}-${stamp}.jsonl"`);
    res.setHeader('Cache-Control', 'no-store');
    started = true;

    // 첫 줄은 무엇을 어떤 조건으로 내보냈는지, 마지막 줄은 종류별 건수다(파일이 잘렸는지 확인할 수 있다).
    const meta = {
      type: 'meta',
      exportedAt: new Date().toISOString(),
      exportedBy: userId,
      hold,
      custodians,
      // to가 날짜만이면 그 날 끝까지(다음 날 00:00 UTC 미만)로 적용했다. 실제로 적용한 범위를 함께 남긴다.
      filter: {
        q: filter.data.q ?? null,
        from: filter.data.from ?? null,
        to: filter.data.to?.date ?? null,
        toDateOnly: filter.data.to?.dateOnly ?? null,
        applied: { createdAtGte: range?.gte ?? null, createdAtLt: range?.lt ?? null, createdAtLte: range?.lte ?? null },
      },
    };
    if (!(await writeWithBackpressure(res, JSON.stringify(meta) + '\n'))) return;
    for await (const record of iterateRecords(ids, filter.data)) {
      counts[record.kind]++;
      if (!(await writeWithBackpressure(res, JSON.stringify({ type: 'record', ...record }) + '\n'))) return;
    }
    await writeWithBackpressure(res, JSON.stringify({ type: 'summary', counts }) + '\n');
    complete = true;
    res.end();
  } catch (error) {
    logError('Admin ediscovery export error', error);
    // 이미 본문을 보냈다면 상태 코드를 바꿀 수 없으므로 연결을 끊어 불완전한 파일임을 알린다.
    if (res.headersSent) res.destroy();
    else res.status(500).json({ error: 'Failed to export' });
  } finally {
    // 다운로드를 시작했으면 끝까지 받았든 도중에 끊겼든 건수와 함께 남긴다
    if (started && userId) {
      await writeAuditLog({
        action: 'ediscovery.exported',
        actorId: userId,
        targetType: 'legal_hold',
        targetId: holdId,
        details: `channel=${counts.channel}; dm=${counts.dm}; file=${counts.file}; complete=${complete}`,
      });
    }
  }
});

// 이 아래는 모두 관리자(ADMIN/OWNER)만
router.use('/ediscovery', authMiddleware, requireAdmin);

// GET /admin/ediscovery/search?holdId=&kind=channel|dm|file&q=&from=&to=&cursor=&limit=
// 필터가 바뀐 첫 페이지(커서 없음)에는 종류별 전체 건수(counts)를 함께 준다. counts=1이면 같은 필터여도 건수를 준다.
router.get('/ediscovery/search', async (req: AuthRequest, res: Response) => {
  try {
    const filter = discoveryFilterSchema.safeParse(req.query);
    const kind = kindSchema.safeParse(req.query.kind);
    if (!filter.success || !kind.success) {
      res.status(400).json({ error: 'Invalid search', details: filter.success ? undefined : filter.error.issues });
      return;
    }
    const ids = await custodianIds(filter.data.holdId);
    if (!ids) return void holdNotFound(res);
    const { limit, cursor } = parsePagination(req);
    const page = await search(kind.data, ids, filter.data, limit, cursor);
    if (cursor) {
      res.json(page);
      return;
    }
    // 필터가 바뀐 첫 페이지만 건수를 세고 감사 로그를 남긴다. 같은 필터로 탭만 바꾸면 둘 다 생략한다.
    // 화면이 건수를 잃었을 때(다른 보존 건에서 돌아옴 등)는 counts=1로 건수만 다시 받는다.
    const fresh = isNewSearchFilter(req.user!.userId, filter.data);
    if (!fresh && req.query.counts !== '1') {
      res.json(page);
      return;
    }
    const counts = await countAll(ids, filter.data);
    if (fresh) {
      await writeAuditLog({
        action: 'ediscovery.searched',
        actorId: req.user!.userId,
        targetType: 'legal_hold',
        targetId: filter.data.holdId,
        details: `kind=${kind.data}; ${filterSummary(filter.data)}; results=${counts.channel + counts.dm + counts.file}`,
      });
    }
    res.json({ ...page, counts });
  } catch (error) {
    logError('Admin ediscovery search error', error);
    res.status(500).json({ error: 'Failed to search' });
  }
});

// POST /admin/ediscovery/export-token - 60초짜리 1회용 내보내기 토큰. 보존 건과 필터에 묶인다. 요청 자체를 감사 로그로 남긴다.
router.post('/ediscovery/export-token', async (req: AuthRequest, res: Response) => {
  try {
    const filter = discoveryFilterSchema.safeParse(req.body ?? {});
    if (!filter.success) {
      res.status(400).json({ error: 'Invalid export request', details: filter.error.issues });
      return;
    }
    const ids = await custodianIds(filter.data.holdId);
    if (!ids) return void holdNotFound(res);
    const issued = issueExportToken(req.user!.userId, discoveryBinding(filter.data));
    if (!issued) {
      res.status(429).json({ error: 'Too many pending exports' });
      return;
    }
    await writeAuditLog({
      action: 'ediscovery.export_requested',
      actorId: req.user!.userId,
      targetType: 'legal_hold',
      targetId: filter.data.holdId,
      details: `${filterSummary(filter.data)}; custodians=${ids.length}`,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ token: issued.token, expiresAt: new Date(issued.expiresAt).toISOString(), ttlSeconds: EXPORT_TOKEN_TTL_MS / 1000 });
  } catch (error) {
    logError('Admin ediscovery export token error', error);
    res.status(500).json({ error: 'Failed to issue export token' });
  }
});

export default router;
