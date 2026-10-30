import prisma from '../db.js';
import { logError } from './logger.js';

interface AuditEntry {
  action: string;
  actorId: number;
  targetType: string;
  targetId?: number;
  targetName?: string;
  details?: string;
}

export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({ data: entry });
  } catch (error) {
    // Audit log failure should never block the admin action
    logError('Audit log write failed', error);
  }
}
