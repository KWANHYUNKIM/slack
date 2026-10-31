#!/usr/bin/env bash
# RTL 대비(i18n-4): 소스에 Tailwind 물리 방향 클래스나 CSS 물리 속성이 새로 들어오지 않았는지 검사한다.
# 대상: app/frontend/src (locales 제외), app/frontend/index.html.
# 잡는 것: ml- mr- pl- pr- left- right- text-left text-right border-l border-r rounded-l rounded-r rounded-tl/tr/bl/br
#          scroll-ml/mr, float-left/right, CSS의 margin/padding/border-left·right, text-align: left|right, float: left|right
# 바꿀 것: ms- me- ps- pe- start- end- text-start text-end border-s border-e rounded-s rounded-e rounded-ss/se/es/ee, inline 속성.
# space-x/divide-x는 Tailwind v4에서 이미 논리 속성(margin-inline)이라 검사하지 않는다.
# 예외: 줄에 `physical-ok` 주석을 달거나 scripts/physical-direction.allow ("경로 정규식<TAB>줄 정규식")에 적는다.
#       좌우가 의미 자체인 경우(예: 지도 좌표, 슬라이더 고정 방향)만 허용한다. 이유를 함께 적는다.
# 사용: scripts/check-physical-direction.sh [파일...]  (인자가 없으면 기본 대상 전체)
set -euo pipefail
cd "$(dirname "$0")/.."
ALLOW=scripts/physical-direction.allow

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=()
  while IFS= read -r f; do files+=("$f"); done < <(find app/frontend/src app/frontend/index.html \
    -type f \( -name '*.tsx' -o -name '*.ts' -o -name '*.css' -o -name '*.html' \) \
    -not -path '*/locales/*' -not -name '*.test.ts' | sort)
fi

hits=$(ALLOW_FILE="$ALLOW" perl scripts/check-physical-direction.pl "${files[@]}")

if [ -n "$hits" ]; then
  echo "물리 방향 클래스/속성이 있다. 논리 속성(ms- me- ps- pe- start- end- text-start border-s rounded-s ...)으로 바꾸거나," >&2
  echo "방향 자체가 의미라면 줄에 physical-ok 주석 또는 scripts/physical-direction.allow 항목을 달아라 (docs/conventions/frontend.md):" >&2
  printf '%s\n' "$hits" >&2
  exit 1
fi
echo "물리 방향 검사 통과 (${#files[@]}개 파일)"
