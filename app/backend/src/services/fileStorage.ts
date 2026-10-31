import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';
import { logError } from '../utils/logger.js';

// 파일 저장소 접근의 공용부(routes/files.ts와 MCP read_file이 함께 쓴다).
// GCS는 버킷 이름이 설정된 때만 쓰고, Storage 클라이언트는 프로세스에 하나만 만든다.
// gcsPath가 있어도 버킷 설정이 없으면 REST 다운로드처럼 로컬 uploads 폴더로 되돌아간다.

const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const gcsStorage = GCS_BUCKET_NAME ? new Storage() : null;
export const bucket = gcsStorage && GCS_BUCKET_NAME ? gcsStorage.bucket(GCS_BUCKET_NAME) : null;

export const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/** 저장된 파일의 앞부분 최대 maxBytes 바이트. 읽을 수 없으면 null. */
export async function readStoredBytes(
  file: { filename: string; gcsPath: string | null; size: number },
  maxBytes: number,
): Promise<Buffer | null> {
  try {
    if (file.gcsPath && bucket) {
      // 0바이트 파일은 range 요청이 오류가 되므로 요청하지 않는다
      if (file.size === 0) return Buffer.alloc(0);
      const [bytes] = await bucket.file(file.gcsPath).download({ start: 0, end: maxBytes - 1 });
      return bytes;
    }
    const filePath = path.resolve(uploadDir, file.filename);
    if (!filePath.startsWith(uploadDir + path.sep)) return null;
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    logError('Read stored file error', error);
    return null;
  }
}
