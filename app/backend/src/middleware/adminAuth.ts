import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types.js';

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'OWNER') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

export function requireOwner(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'OWNER') {
    res.status(403).json({ error: 'Owner access required' });
    return;
  }
  next();
}
