#!/bin/zsh
# 자원 점검: CLAUDE.md 4장의 단계(정상/감속/정지)와 동시 실행 한도를 출력한다.

free_pct=$(memory_pressure | awk -F': ' '/free percentage/ {gsub("%","",$2); print $2}')
disk_free_gb=$(df -g / | awk 'NR==2 {print $4}')
load=$(sysctl -n vm.loadavg | awk '{print $2}')

if (( free_pct >= 30 )); then
  stage="정상"; limit=3
elif (( free_pct >= 15 )); then
  stage="감속"; limit=1
else
  stage="정지"; limit=0
fi

echo "여유 메모리: ${free_pct}%"
echo "디스크 여유: ${disk_free_gb}GB"
echo "CPU 부하(1분): ${load}"
echo "단계: ${stage} / 동시 실행 서브에이전트 한도: ${limit}"
(( disk_free_gb < 5 )) && echo "경고: 디스크 여유 5GB 미만, 새 설치/빌드 중지"
exit 0
