import { Request } from 'express';

export function parsePagination(req: Request): { limit: number; cursor: number | undefined } {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 50, 100));
  const rawCursor = req.query.cursor ? parseInt(req.query.cursor as string) : undefined;
  const cursor = rawCursor !== undefined && !isNaN(rawCursor) && rawCursor > 0 ? rawCursor : undefined;
  return { limit, cursor };
}

export function paginateResults<T extends { id: number }>(
  items: T[],
  limit: number,
): { results: T[]; nextCursor: number | undefined; hasMore: boolean } {
  const hasMore = items.length > limit;
  const results = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;
  return { results, nextCursor, hasMore };
}
