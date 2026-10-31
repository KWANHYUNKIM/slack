#!/bin/sh
# DATABASE_URL을 준비하고 마이그레이션을 적용한 뒤 서버를 시작한다.
# - DATABASE_URL이 없으면 PGHOST, PGUSER, PGPASSWORD, PGDATABASE(, PGPORT)로 조합한다(특수문자는 인코딩).
# - DB 연결 실패(P1001 등)만 재시도하고, 마이그레이션 오류는 즉시 상태를 출력하고 종료한다.
set -e

if ! DATABASE_URL=$(node dist/ops/cli.js database-url); then
  exit 1
fi
export DATABASE_URL

MIGRATE_LOG=$(mktemp)
echo "Running database migrations..."
i=0
while true; do
  if timeout 60 npx prisma migrate deploy > "$MIGRATE_LOG" 2>&1; then
    cat "$MIGRATE_LOG"
    break
  fi
  cat "$MIGRATE_LOG"
  outcome=$(node dist/ops/cli.js classify-migrate < "$MIGRATE_LOG" || echo fatal)
  i=$((i + 1))
  if [ "$outcome" != "retry" ] || [ "$i" -ge 15 ]; then
    echo "Migration failed ($outcome, attempt $i). Migration status:"
    npx prisma migrate status || true
    rm -f "$MIGRATE_LOG"
    exit 1
  fi
  echo "Database not reachable yet, retrying in 3s... ($i/15)"
  sleep 3
done
rm -f "$MIGRATE_LOG"

echo "Starting server..."
exec node dist/index.js
