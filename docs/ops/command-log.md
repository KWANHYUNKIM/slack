# 지시와 명령 기록 (총괄 관리)

사용자 지시, 총괄이 내린 배정, 총괄이 실행한 주요 명령을 시간순으로 남긴다. 시각은 KST.

## 사용자 지시
| 시각 | 지시 | 반영 위치 |
|---|---|---|
| 10-31 08:07 | reverse-engineering으로 Slack을 만든다. 공개 GitHub 현황 조사 | 조사 완료 |
| 10-31 08:10 | 스타·포크가 가장 많은 RE 도구 선택, 기존 Slack 클론 찾기 | REA 선택 |
| 10-31 08:15 | 마지막 커밋과 PR 수 기준으로 클론 다시 정리 | slawk 선택 |
| 10-31 08:29 | 팀 규칙: 총괄 1, 기획 2, 개발 5. 루프로 돌고, 메모리가 높으면 감속. 무조건 따르는 규칙 | CLAUDE.md |
| 10-31 08:31 | 진행 (slawk, REA, git) | `app/`, REA 설치 |
| 10-31 08:32 | 저장소는 github.com/KWANHYUNKIM/slack | origin |
| 10-31 08:54 | 루프 시작 | 루프 1 |
| 10-31 08:59 | 지시할 때 CRUD 실습 권장 명시, 외부 기술 문서로 유추, FE/BE/DB 선택 이유 직접 분석, 위임, 오래 걸리면 넘기기 | CLAUDE.md 2장 7~10 |
| 10-31 09:03 | REA를 실제로 쓰고 성능 기록(토큰, 구현 가능성 비교). 총괄이 명령 기록 | `rea-evaluation.md`, 이 문서 |
| 10-31 09:08 | Git 규칙(최신 방식), FE/BE 규칙, PR 리뷰, Node.js 보안, 엔터프라이즈 기능, 웹과 exe 배포 구조 | `docs/conventions/`, `docs/security/`, `docs/architecture/` |
| 10-31 09:08 | 기록할 수 있는 건 모두 기록 | 이 문서 |

## 배정 기록
| 시각 | 루프 | 담당 | 모델 | 작업 | 결과 | 토큰 |
|---|---|---|---|---|---|---|
| 08:55 | 1 | planner-1 | sonnet | 갭 분석, P0 스펙 3개 | 완료 | 89,081 |
| 09:00 | 2 | planner-2 | sonnet | Slack 기술 구조 공개 문서 조사 | 완료 | 58,267 |
| 09:15 | 2 | planner-1 | opus | REA로 Slack 데스크톱 앱 분석, REA 평가 | 진행 중 | |

## 총괄 실행 명령
| 시각 | 명령 | 목적 | 결과 |
|---|---|---|---|
| 08:31 | `git init`, `git clone --depth 1 ncvgl/slawk app` | 기반 코드 | 기준 커밋 5f30358 |
| 08:40 | `brew install node@24 && brew link --force node@24` | REA 요구 Node 버전 | 24.6.0에서 24.22.2로 |
| 08:45 | `npx rea-agents@6.8.0 setup --client claude_code --yes` | REA 설치 | MCP `rea` 연결, 스킬 설치 |
| 08:46 | `git push -u origin main` | 저장소 연결 | d2ceac2 |
| 09:00 | `docker run -d --name slackclone-db --memory 256m -p 127.0.0.1:5434:5432 postgres:16-alpine` | 전용 테스트 DB(다른 프로젝트 DB 보호) | 약 43MB 사용 |
| 09:01 | `npm ci`, `npm install-scripts approve ...`(prisma, bcrypt, esbuild, sharp 등 8개) | 백엔드 의존성 | 완료 |
| 09:02 | `npx prisma migrate deploy` | 스키마 적용 | 완료 |
| 09:05 | `npm test` (backend) | 기준 테스트 | 375개 중 369개 통과, 6개 실패(4개 스위트: security, files, edge-cases, admin). Jest가 종료되지 않음(열린 핸들) |
