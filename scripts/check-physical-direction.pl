# check-physical-direction.sh가 부르는 검사 본체. 인자: 파일 경로들, 환경변수 ALLOW_FILE.
use strict;
use warnings;

my @allow;
if (open(my $f, "<", $ENV{ALLOW_FILE})) {
  while (<$f>) {
    chomp;
    next if /^\s*(#|$)/;
    unless (/\t/) {
      die "허용 목록 형식 오류 ($ENV{ALLOW_FILE}:$.): 경로 정규식과 줄 정규식을 TAB으로 구분해야 한다: $_\n";
    }
    push @allow, [split /\t/, $_, 2];
  }
}

my $dir = qr{(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-[\w\[\].%/-]+
  |text-(?:left|right)
  |border-[lr](?:-[\w\[\].%/-]+)?
  |rounded-(?:[lr]|t[lr]|b[lr])(?:-[\w\[\].%/-]+)?
  |float-(?:left|right)}x;
# 클래스 토큰: 앞은 공백/따옴표/백틱/중괄호, 뒤는 공백/따옴표/백틱/중괄호/줄 끝.
# 변형 접두사(md: hover: rtl: group-hover/name: 등), 음수 접두사, 중요(!) 수식어(앞/뒤)를 허용한다.
my $tw = qr/(?:^|[\s"'`\{])(?:[\w\[\]=&>*\/-]+:)*!?-?(?:$dir)!?(?=\z|[\s"'`\}])/;
# CSS 파일: 값이 무엇이든(0, auto, calc, var 포함) left/right 속성과 물리 border-*-radius를 잡는다.
my $css = qr/(?:margin|padding|border)-(?:left|right)\b|border-(?:top|bottom)-(?:left|right)-radius|text-align:\s*(?:left|right)\b|float:\s*(?:left|right)\b|(?:^|[\s\{;])(?:left|right)\s*:/;
# TSX/TS 인라인 스타일: marginLeft 등 카멜케이스 속성, textAlign: 'left', left/right에 숫자·문자열 리터럴.
# 변수 값(left: x, left: pos.left)은 JS 좌표 계산일 수 있어 잡지 않는다.
my $inline = qr/\b(?:margin|padding|border)(?:Left|Right)\b\s*:|\bborder(?:Top|Bottom)(?:Left|Right)Radius\b\s*:|\btextAlign\s*:\s*['"`](?:left|right)['"`]|\bfloat\s*:\s*['"`](?:left|right)['"`]|\b(?:left|right)\s*:\s*(?:-?\d[\d.]*\b|['"`][^'"`]*['"`])/;

for my $path (@ARGV) {
  open(my $fh, "<", $path) or next;
  my $is_css = $path =~ /\.css$/;
  my $in_block = 0;
  while (my $l = <$fh>) {
    chomp $l;
    my $n = $.;
    next if $l =~ /physical-ok/;
    if ($is_css) {
      next if $l =~ m{^\s*(/\*|\*)};
    } else {
      if ($in_block) { $in_block = 0 if $l =~ m{\*/}; next; }
      if ($l =~ m{^\s*/\*} && $l !~ m{\*/}) { $in_block = 1; next; }
      next if $l =~ m{^\s*(//|/\*|\*\s)};
      $l =~ s{\s//\s.*$}{};    # 줄 끝 주석
    }
    my $bad = ($l =~ $tw) || ($is_css ? ($l =~ $css) : ($l =~ $inline));
    next unless $bad;
    my $skip = 0;
    for my $a (@allow) { $skip = 1 if $path =~ /$a->[0]/ && $l =~ /$a->[1]/; }
    print "$path:$n:$l\n" unless $skip;
  }
  close $fh;
}
