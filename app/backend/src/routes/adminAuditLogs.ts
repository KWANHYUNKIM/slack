import { Router, Response } from 'express';
import { once } from 'events';
import { z } from 'zod';
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
} from '../services/auditLogService.js';

const router = Router();

// 관리자(ADMIN/OWNER)만. 이 라우터는 /admin 아래에서 admin.ts보다 먼저 연결된다.
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

const formatSchema = z.enum(['csv', 'json']);

// GET /admin/audit-logs/export?format=csv|json - 같은 필터, 최대 EXPORT_MAX_ROWS행, 스트리밍
router.get('/audit-logs/export', async (req: AuthRequest, res: Response) => {
  try {
    const format = formatSchema.safeParse(req.query.format ?? 'csv');
    const filter = auditFilterSchema.safeParse(req.query);
    if (!format.success || !filter.success) {
      res.status(400).json({ error: 'Invalid export request' });
      return;
    }

    // 내보내기 실행 자체를 먼저 기록한다. 도중에 끊겨도 실행한 사실은 남는다(필터 값은 남기고 결과 내용은 남기지 않는다).
    await writeAuditLog({
      action: 'audit.exported',
      actorId: req.user!.userId,
      targetType: 'audit_log',
      details: `format=${format.data}; filter=${JSON.stringify(req.query, ['action', 'actorId', 'targetType', 'targetId', 'from', 'to'])}; max=${EXPORT_MAX_ROWS}`,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    res.status(200);
    res.setHeader('Content-Type', format.data === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${stamp}.${format.data}"`);
    res.setHeader('Cache-Control', 'no-store');

    // 클라이언트가 끊으면 멈춘다. 버퍼가 차면 drain을 기다려 메모리를 일정하게 유지한다.
    const write = async (chunk: string): Promise<boolean> => {
      if (res.destroyed) return false;
      if (!res.write(chunk)) await once(res, 'drain').catch(() => undefined);
      return !res.destroyed;
    };

    if (format.data === 'csv') {
      await write('﻿' + CSV_COLUMNS.join(',') + '\r\n');
    } else {
      await write('[');
    }
    let first = true;
    for await (const row of iterateAuditRows(filter.data)) {
      const chunk = format.data === 'csv' ? csvLine(row) + '\r\n' : (first ? '' : ',') + JSON.stringify(jsonRow(row));
      first = false;
      if (!(await write(chunk))) return;
    }
    if (format.data === 'json') await write(']');
    res.end();
  } catch (error) {
    logError('Admin audit export error', error);
    // 이미 본문을 보냈다면 상태 코드를 바꿀 수 없으므로 연결을 끊어 불완전한 파일임을 알린다.
    if (res.headersSent) res.destroy();
    else res.status(500).json({ error: 'Failed to export audit logs' });
  }
});

export default router;
