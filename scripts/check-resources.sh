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

# memory_pressure 여유 비율이 정상이어도 스왑이 거의 차 있으면 node·Docker VM이 수 초씩 멈춘다
# (test/suite-flaky-rest 조사: 스왑 10.1/11.3GB에서 전체 테스트 40% 실패). 스왑 90% 이상이면 감속으로 낮춘다.
swap_pct=$(sysctl -n vm.swapusage | awk '{gsub("M","",$3); gsub("M","",$6); if ($3 > 0) printf "%d", $6 * 100 / $3; else print 0}')
if (( swap_pct >= 90 && limit > 1 )); then
  stage="감속(스왑)"; limit=1
fi

echo "여유 메모리: ${free_pct}%"
echo "스왑 사용: ${swap_pct}%"
echo "디스크 여유: ${disk_free_gb}GB"
echo "CPU 부하(1분): ${load}"
echo "단계: ${stage} / 동시 실행 서브에이전트 한도: ${limit}"
(( disk_free_gb < 5 )) && echo "경고: 디스크 여유 5GB 미만, 새 설치/빌드 중지"
(( swap_pct >= 90 )) && echo "경고: 스왑 90% 이상, 전체 테스트·빌드는 하나씩, 결과 실패가 멈춤 탓일 수 있음"
exit 0
