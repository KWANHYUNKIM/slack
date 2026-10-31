import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { AuthRequest } from '../types.js';
import { parsePagination } from '../utils/pagination.js';
import { logError } from '../utils/logger.js';
import { writeAuditLog } from '../utils/auditLog.js';
import {
  auditFilterSchema,
  listAuditLogs,
  iterateAuditRows,
  csvLine,
  jsonRow,
  CSV_COLUMNS,
  EXPORT_MAX_ROWS,
  EXPORT_TOKEN_TTL_MS,
  exportBinding,
  issueExportToken,
  consumeExportToken,
  writeWithBackpressure,
} from '../services/auditLogService.js';

const router = Router();

const formatSchema = z.enum(['csv', 'json']);

// GET /admin/audit-logs/export?format=csv|json&token=... - 같은 필터, 최대 EXPORT_MAX_ROWS행, 스트리밍
// 브라우저가 <a href>로 직접 받으므로 Authorization 헤더 대신 일회용 토큰(POST /export-token)으로 인증한다.
// authMiddleware 보다 먼저 등록해 헤더 없는 요청도 이 핸들러가 받는다.
router.get('/audit-logs/export', async (req: Request, res: Response) => {
  try {
    const format = formatSchema.safeParse(req.query.format ?? 'csv');
    const filter = auditFilterSchema.safeParse(req.query);
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!format.success || !filter.success) {
      res.status(400).json({ error: 'Invalid export request' });
      return;
    }
    // 토큰은 1회용이다. 필터·형식이 발급 때와 다르거나 만료돼도 소진된다.
    const userId = token ? consumeExportToken(token, exportBinding(format.data, filter.data)) : null;
    if (!userId) {
      res.status(403).json({ error: 'Invalid or expired export token' });
      return;
    }
    // 발급 이후에 권한을 잃었을 수 있으니 지금 다시 확인한다
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, deactivatedAt: true } });
    if (!user || user.deactivatedAt || (user.role !== 'ADMIN' && user.role !== 'OWNER')) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    // 내보내기 실행 자체를 먼저 기록한다. 도중에 끊겨도 실행한 사실은 남는다(필터 값은 남기고 토큰과 결과 내용은 남기지 않는다).
    await writeAuditLog({
      action: 'audit.exported',
      actorId: userId,
      targetType: 'audit_log',
      details: `format=${format.data}; filter=${JSON.stringify(req.query, ['action', 'actorId', 'targetType', 'targetId', 'from', 'to'])}; max=${EXPORT_MAX_ROWS}`,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.status(200);
    res.setHeader('Content-Type', format.data === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${stamp}.${format.data}"`);
    res.setHeader('Cache-Control', 'no-store');

    // write가 false(연결 끊김)를 돌려주면 return 해서 for await가 generator를 닫는다(더 읽지 않는다).
    if (!(await writeWithBackpressure(res, format.data === 'csv' ? '﻿' + CSV_COLUMNS.join(',') + '\r\n' : '['))) return;
    let first = true;
    for await (const row of iterateAuditRows(filter.data)) {
      const chunk = format.data === 'csv' ? csvLine(row) + '\r\n' : (first ? '' : ',') + JSON.stringify(jsonRow(row));
      first = false;
      if (!(await writeWithBackpressure(res, chunk))) return;
    }
    if (format.data === 'json') await writeWithBackpressure(res, ']');
    res.end();
  } catch (error) {
    logError('Admin audit export error', error);
    // 이미 본문을 보냈다면 상태 코드를 바꿀 수 없으므로 연결을 끊어 불완전한 파일임을 알린다.
    if (res.headersSent) res.destroy();
    else res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

// 이 아래는 모두 관리자(ADMIN/OWNER)만. 이 라우터는 /admin 아래에서 admin.ts보다 먼저 연결된다.
router.use('/audit-logs', authMiddleware, requireAdmin);

// GET /admin/audit-logs - 필터 + 커서 페이지네이션(최신순)
router.get('/audit-logs', async (req: AuthRequest, res: Response) => {
  try {
    const filter = auditFilterSchema.safeParse(req.query);
    if (!filter.success) {
      res.status(400).json({ error: 'Invalid filter', details: filter.error.issues });
      return;
    }
    const { limit, cursor } = parsePagination(req);
    res.json(await listAuditLogs(filter.data, limit, cursor));
  } catch (error) {
    logError('Admin audit logs error', error);
    res.status(500).json({ error: 'Failed to get audit logs' });
  }
});

// POST /admin/audit-logs/export-token - 60초짜리 1회용 내보내기 토큰. 형식과 필터가 묶인다.
router.post('/audit-logs/export-token', async (req: AuthRequest, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const format = formatSchema.safeParse(body.format ?? 'csv');
    const filter = auditFilterSchema.safeParse(body);
    if (!format.success || !filter.success) {
      res.status(400).json({ error: 'Invalid export request' });
      return;
    }
    const issued = issueExportToken(req.user!.userId, exportBinding(format.data, filter.data));
    if (!issued) {
      res.status(429).json({ error: 'Too many pending exports' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ token: issued.token, expiresAt: new Date(issued.expiresAt).toISOString(), ttlSeconds: EXPORT_TOKEN_TTL_MS / 1000 });
  } catch (error) {
    logError('Admin audit export token error', error);
    res.status(500).json({ error: 'Failed to issue export token' });
  }
});

export default router;
