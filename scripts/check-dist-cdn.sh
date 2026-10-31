#!/usr/bin/env bash
# 규칙 17: 빌드 산출물(dist)에 런타임 fetch 대상이 될 수 있는 CDN 도메인이 남지 않았는지 검사한다.
# 사용: scripts/check-dist-cdn.sh [dist 경로 ...]   (기본: app/frontend/dist)
# 소스 검사(check-external-urls.sh)는 node_modules 라이브러리 주석 오탐 때문에 dist를 보지 않는다.
# 대신 이 스크립트는 "CDN 도메인 차단 목록"만 dist에서 찾는다.
# 허용: scripts/dist-cdn.allow ("파일 경로 정규식<TAB>URL 정규식", 사유는 # 주석). 허용 URL을 지운 뒤에 차단 도메인이 남으면 실패한다.
#   예) emoji-mart 폴백 문자열은 라이브러리 코드에 남지만, 앱이 data·i18n을 직접 넘기고 set='native'를 써서 실행되지 않는다.
# 테스트용으로 DIST_CDN_ALLOW 환경변수로 허용 목록 파일을 바꿀 수 있다.
set -euo pipefail
cd "$(dirname "$0")/.."
export ALLOW_FILE="${DIST_CDN_ALLOW:-scripts/dist-cdn.allow}"
export BLOCKED='cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|esm\.sh|cdn\.skypack\.dev|ajax\.googleapis\.com|code\.jquery\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com|use\.fontawesome\.com|kit\.fontawesome\.com'

targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(app/frontend/dist)
for t in "${targets[@]}"; do
  [ -e "$t" ] || { echo "검사 대상이 없다: $t (빌드를 먼저 실행)" >&2; exit 1; }
done

files=$(find "${targets[@]}" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.svg' \))
# 검사할 파일이 없으면 통과가 아니라 실패다 (빈 dist는 빌드 실패로 본다)
if [ -z "$files" ]; then
  echo "검사할 파일이 없다: ${targets[*]} (빌드 산출물이 비어 있다, 빌드를 먼저 확인)" >&2
  exit 1
fi

hits=$(printf '%s\n' "$files" | tr '\n' '\0' \
  | xargs -0 -n1 perl -e '
    my $path = $ARGV[0];
    my @allow;
    if (open(my $f, "<", $ENV{ALLOW_FILE})) {
      while (<$f>) { chomp; next if /^\s*(#|$)/; push @allow, [split /\t/, $_, 2]; }
    }
    open(my $in, "<", $path) or die "$path: $!";
    local $/; my $c = <$in>;
    for my $a (@allow) { $c =~ s/$a->[1]//g if $path =~ /$a->[0]/; }
    my %seen;
    while ($c =~ /($ENV{BLOCKED})/g) { print "$path: $1\n" unless $seen{$1}++; }
  ')

if [ -n "$hits" ]; then
  echo "dist에 CDN 도메인 발견 (규칙 17 위반, 불가피하면 $ALLOW_FILE 에 사유와 함께 추가):" >&2
  printf '%s\n' "$hits" >&2
  exit 1
fi
echo "OK: dist에 CDN 도메인 없음"
