import { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { ERR } from '../utils/errorCodes.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // body-parser가 던지는 상태 오류(본문이 너무 큼 413, 지원하지 않는 형식 415)
  const status = (err as { status?: number }).status;
  if (status === 413) {
    res.status(413).json({ error: 'Payload too large', code: ERR.PAYLOAD_TOO_LARGE });
    return;
  }
  if (status === 415) {
    res.status(415).json({ error: 'Unsupported media type', code: ERR.UNSUPPORTED_MEDIA_TYPE });
    return;
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues, code: ERR.VALIDATION_FAILED });
    return;
  }

  // Handle multer errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'File too large', code: ERR.FILE_TOO_LARGE });
      return;
    }
    res.status(400).json({ error: err.message, code: ERR.UPLOAD_FAILED });
    return;
  }

  // Handle file type not allowed error from multer fileFilter
  if (err.message === 'File type not allowed') {
    res.status(400).json({ error: 'File type not allowed', code: ERR.FILE_TYPE_NOT_ALLOWED });
    return;
  }

  // Handle JSON parsing errors
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'Invalid JSON', code: ERR.INVALID_JSON });
    return;
  }

  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error', code: ERR.INTERNAL_ERROR });
}
