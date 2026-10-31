# check-physical-direction.sh가 부르는 검사 본체. 인자: 파일 경로들, 환경변수 ALLOW_FILE.
use strict;
use warnings;

my @allow;
if (open(my $f, "<", $ENV{ALLOW_FILE})) {
  while (<$f>) { chomp; next if /^\s*(#|$)/; push @allow, [split /\t/, $_, 2]; }
}

my $dir = qr{(?:ml|mr|pl|pr|left|right|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-[\w\[\].%/-]+
  |text-(?:left|right)
  |border-[lr](?:-[\w\[\].%/-]+)?
  |rounded-(?:[lr]|t[lr]|b[lr])(?:-[\w\[\].%/-]+)?
  |float-(?:left|right)}x;
# 클래스 토큰: 앞은 공백/따옴표/백틱/중괄호, 뒤는 공백/따옴표/백틱/중괄호/줄 끝.
# 변형 접두사(md: hover: rtl: 등)와 음수 접두사를 허용한다.
my $tw = qr/(?:^|[\s"'`\{])(?:[\w\[\]=&>*-]+:)*-?(?:$dir)(?=\z|[\s"'`\}])/;
my $css = qr/(?:margin|padding|border)-(?:left|right)\b|text-align:\s*(?:left|right)\b|float:\s*(?:left|right)\b|(?:^|[\s\{;])(?:left|right):\s*[-\d.]+(?:px|rem|em|%)/;

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
    my $bad = ($l =~ $tw) || ($is_css && $l =~ $css);
    next unless $bad;
    my $skip = 0;
    for my $a (@allow) { $skip = 1 if $path =~ /$a->[0]/ && $l =~ /$a->[1]/; }
    print "$path:$n:$l\n" unless $skip;
  }
  close $fh;
}
