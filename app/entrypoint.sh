#!/bin/sh
# 마이그레이션을 적용한 뒤 서버를 시작한다. DB가 아직 준비되지 않았으면 재시도한다.
set -e

echo "Running database migrations..."
i=0
until timeout 60 npx prisma migrate deploy; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then
    echo "Migration failed after $i attempts. Exiting."
    npx prisma migrate status || true
    exit 1
  fi
  echo "Database not ready or migration failed, retrying in 3s... ($i/15)"
  sleep 3
done

echo "Starting server..."
exec node dist/index.js
