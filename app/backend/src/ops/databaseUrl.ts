// 컨테이너 시작 시 개별 변수(PGHOST, PGUSER, PGPASSWORD 등)로 DATABASE_URL을 조합한다.
// 비밀번호에 @ : / ? # % 같은 문자가 있어도 깨지지 않도록 사용자·비밀번호·DB 이름을 퍼센트 인코딩한다.

type Env = Record<string, string | undefined>;

/** DATABASE_URL이 이미 있으면 그대로 쓰고, 없으면 PG* 변수로 조합한다. 필수 값이 없으면 오류. */
export function buildDatabaseUrl(env: Env): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const host = env.PGHOST;
  const user = env.PGUSER;
  const password = env.PGPASSWORD;
  const database = env.PGDATABASE;
  const port = env.PGPORT || '5432';

  const missing = [
    ['PGHOST', host],
    ['PGUSER', user],
    ['PGPASSWORD', password],
    ['PGDATABASE', database],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`DATABASE_URL 또는 ${missing.join(', ')} 를 설정하세요`);
  }
  if (!/^\d{1,5}$/.test(port)) {
    throw new Error('PGPORT must be a number');
  }
  // IPv6 호스트는 대괄호로 감싼다.
  const hostPart = host!.includes(':') && !host!.startsWith('[') ? `[${host}]` : host!;
  return `postgresql://${encodeURIComponent(user!)}:${encodeURIComponent(password!)}@${hostPart}:${port}/${encodeURIComponent(database!)}`;
}
