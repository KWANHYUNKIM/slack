#!/usr/bin/env bash
# 규칙 17: 소스에 외부 URL 리터럴이 남지 않았는지 검사한다 (docs/architecture/self-contained-assets.md 3절).
# 대상: app/backend/src(테스트 제외), app/frontend/src(locales 제외), app/frontend/index.html.
# 잡는 것: http://, https://, 따옴표 또는 src=/href= 뒤의 프로토콜 상대 URL(//host).
# dist는 번들 라이브러리의 주석, 문서 링크 오탐이 많아 검사하지 않는다. 런타임 요청은 CSP가 막는다.
# 허용 목록: scripts/external-urls.allow ("경로 정규식<TAB>URL 정규식"). localhost, 127.0.0.1, http://www.w3.org/ (SVG 네임스페이스)는 기본 허용.
set -euo pipefail
cd "$(dirname "$0")/.."
ALLOW=scripts/external-urls.allow
targets=(app/backend/src app/frontend/src app/frontend/index.html)
for t in "${targets[@]}"; do
  [ -e "$t" ] || { echo "검사 대상이 없다: $t" >&2; exit 1; }
done

# grep exit 1(일치 없음)만 정상으로 처리한다. 2 이상은 오류라 그대로 실패한다.
rc=0
raw=$(grep -rnIE "https?://[A-Za-z0-9]|[\"'\`]//[A-Za-z0-9]|(src|href)=//[A-Za-z0-9]" "${targets[@]}" \
  --exclude-dir=tests --exclude-dir=locales --exclude='*.test.ts' --exclude='*.map') || rc=$?
if [ "$rc" -gt 1 ]; then echo "grep 오류 (exit $rc)" >&2; exit "$rc"; fi

hits=""
if [ -n "$raw" ]; then
  hits=$(printf '%s\n' "$raw" | ALLOW_FILE="$ALLOW" perl -e '
    my @allow;
    if (open(my $f, "<", $ENV{ALLOW_FILE})) {
      while (<$f>) { chomp; next if /^\s*(#|$)/; push @allow, [split /\t/, $_, 2]; }
    }
    while (my $l = <STDIN>) {
      chomp $l;
      next unless $l =~ /^([^:]+):(\d+):(.*)$/;
      my ($path, $n, $c) = ($1, $2, $3);
      next if $c =~ /^\s*(\/\/|\/\*|\*\s)/;
      for my $a (@allow) { $c =~ s/$a->[1]//g if $path =~ /$a->[0]/; }
      $c =~ s{https?://(?:localhost|127\.0\.0\.1)(?::[\d*]+)?[^\s"\x27`)]*}{}g;
      $c =~ s{http://www\.w3\.org/[^\s"\x27`)]*}{}g;   # XML 네임스페이스 식별자(요청 아님)
      print "$path:$n:$c\n" if $c =~ /https?:\/\/[A-Za-z0-9]|["\x27`]\/\/[A-Za-z0-9]|(?:src|href)=\/\/[A-Za-z0-9]/;
    }')
fi

if [ -n "$hits" ]; then
  echo "외부 URL 리터럴 발견 (규칙 17 위반, 허용하려면 $ALLOW 에 사유와 함께 추가):" >&2
  printf '%s\n' "$hits" >&2
  exit 1
fi
echo "OK: 외부 URL 리터럴 없음"
