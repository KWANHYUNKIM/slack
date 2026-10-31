#!/usr/bin/env bash
# 규칙 17: 소스에 외부 https 리터럴이 남지 않았는지 검사한다 (docs/architecture/self-contained-assets.md 3절).
# 대상: app/backend/src(테스트 제외), app/frontend/src(locales 제외), app/frontend/index.html.
# dist는 번들된 라이브러리의 주석·문서 링크가 섞여 오탐이 많아 검사하지 않는다. 런타임 요청은 CSP가 막는다.
# 허용 목록: scripts/external-urls.allow (한 줄에 정규식 하나). 라이선스·문서 링크, 웹 푸시, 사용자 입력 정규화 등.
set -u
cd "$(dirname "$0")/.."
ALLOW=scripts/external-urls.allow
targets=(app/backend/src app/frontend/src app/frontend/index.html)

hits=$(grep -rnIE 'https://[A-Za-z0-9]' "${targets[@]}" \
  --exclude-dir=tests --exclude-dir=locales --exclude='*.test.ts' --exclude='*.map' 2>/dev/null \
  | grep -vE '^\S+:[0-9]+:\s*(//|\*|/\*)' || true)

if [ -f "$ALLOW" ]; then
  patterns=$(grep -vE '^\s*(#|$)' "$ALLOW" || true)
  [ -n "$patterns" ] && hits=$(printf '%s\n' "$hits" | grep -vEf <(printf '%s\n' "$patterns") || true)
fi
hits=$(printf '%s\n' "$hits" | sed '/^$/d')

if [ -n "$hits" ]; then
  echo "외부 https 리터럴 발견 (규칙 17 위반, 허용하려면 $ALLOW 에 사유와 함께 추가):" >&2
  printf '%s\n' "$hits" >&2
  exit 1
fi
echo "OK: 외부 https 리터럴 없음"
