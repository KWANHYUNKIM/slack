// 파일 형식 목록의 단일 출처. 업로드 허용 목록(routes/files.ts)과 MCP read_file의 텍스트 판정이 같은 상수를 쓴다.

export const UPLOAD_ALLOWED_MIMES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/json',
  'application/zip',
  'application/x-zip-compressed',
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp4;codecs=opus',
  'audio/aac',
  'video/mp4',
  'video/webm',
  'video/quicktime',
];

/** 업로드를 허용하는 형식 중 텍스트로 읽을 수 있는 것(text/*, JSON) */
const TEXT_MIMES = new Set(UPLOAD_ALLOWED_MIMES.filter((m) => m.startsWith('text/') || m === 'application/json'));

export function isTextMimetype(mimetype: string): boolean {
  return TEXT_MIMES.has(mimetype.split(';')[0].trim().toLowerCase());
}

/** MCP read_file이 내용을 돌려주는 최대 크기(바이트). 넘으면 메타데이터만 돌려준다. */
export const MAX_READ_FILE_BYTES = 256 * 1024;
