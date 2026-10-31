import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types.js';
import { ERR } from '../utils/errorCodes.js';

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'OWNER') {
    res.status(403).json({ error: 'Admin access required', code: ERR.ADMIN_REQUIRED });
    return;
  }
  next();
}

export function requireOwner(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'OWNER') {
    res.status(403).json({ error: 'Owner access required', code: ERR.OWNER_REQUIRED });
    return;
  }
  next();
}
