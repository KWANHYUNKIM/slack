// `prisma migrate deploy` 출력으로 재시도 여부를 판정한다.
// DB 연결 실패(아직 기동 중)만 재시도하고, 마이그레이션 오류나 그 밖의 오류는 즉시 실패시킨다.

export type MigrateOutcome = 'retry' | 'fatal';

// P1001: 서버에 닿을 수 없음, P1002: 서버 응답 시간 초과, P1017: 서버가 연결을 닫음
const CONNECTION_CODES = ['P1001', 'P1002', 'P1017'];

export function classifyMigrateOutput(output: string): MigrateOutcome {
  // 연결 오류 코드와 마이그레이션 오류 코드가 함께 보이면 마이그레이션 오류를 우선한다.
  if (/\bP30\d{2}\b/.test(output)) return 'fatal';
  if (CONNECTION_CODES.some((code) => new RegExp(`\\b${code}\\b`).test(output))) return 'retry';
  if (/Can't reach database server/i.test(output)) return 'retry';
  return 'fatal';
}
