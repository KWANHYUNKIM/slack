# 작업 보드

| 파트 | 담당 | 모델 | 상태 | 예상 시간 | 시작 | 종료 | 비고 |
|---|---|---|---|---|---|---|---|
| 00-gap-analysis (Slack ↔ slawk 기능 비교와 파트 분할) | planner-1 | sonnet | 완료 | 60분 | 2026-10-31 08:55 | 2026-10-31 08:58 | 루프 1, 실제 약 3분. 결과: specs/00~03 |
| 01-mentions-activity | - | sonnet | 대기 | 2h | | | P0, 스키마 변경 |
| 03-channel-meta-star | - | sonnet | 대기 | 1.5h | | | P0, 스키마 변경 |
| 02-group-dm | - | opus | 대기 | 2h | | | P0, 스키마 변경, 01 병합 후 단독 |
| 04-threads-view, 05-user-status-dnd 스펙 | planner-2 | sonnet | 완료 | 40분 | 2026-10-31 09:36 | 2026-10-31 09:38 | 루프 3, Slack 테스트 채널 CRUD 실습 포함 |
| REA run1: Slack 데스크톱 앱 분석과 REA 평가 | planner-1 | opus | 완료 | 45분 | 2026-10-31 09:13 | 2026-10-31 09:35 | 루프 2 |
| 규칙 문서(git, FE, BE, 보안, 기술 스택, 엔터프라이즈·배포) | 총괄 | - | 완료 | 30분 | 2026-10-31 09:15 | 2026-10-31 09:35 | |
| fix/baseline-failing-tests: 기준 테스트 실패 6건과 Jest 미종료 | dev-1 | sonnet | 진행 중 | 1h | 2026-10-31 09:23 | | security, files, edge-cases, admin |
| ci: GitHub Actions ci.yml (backend 테스트 + frontend 빌드/린트) | dev-2 | haiku | PR #3 | 1h | 2026-10-31 09:23 | 2026-10-31 09:26 | |
| D1 desktop-shell: Electron 셸, 서버 주소 입력, preload API, electron-builder | - | opus | 대기 | 2h | | | 보안 문서 9절 |
| D2 release: release.yml(Windows exe, dmg, AppImage를 Releases에 업로드), release-please | - | sonnet | 대기 | 1.5h | | | D1 이후 |
| E1~E10 엔터프라이즈 (architecture 문서 3절) | - | opus/sonnet | 대기 | | | | P0 이후 |
| 2026-10-31 09:00 | planner-2: Slack 기술 구조 조사 | planner-2 | sonnet | 완료 | 40분 | 2026-10-31 09:00 | 2026-10-31 09:02 | docs/research/slack-architecture.md |
| security/deps-upgrade-frontend: quill, react-router 등 | dev-3 | sonnet | PR #4 | 1h | 2026-10-31 09:36 | 2026-10-31 09:38 | 루프 3 |
| security/deps-upgrade-backend: critical 1, high 다수, CI audit 차단 복구 | - | sonnet | 대기(dev-1 이후) | 1.5h | | | multer, sharp, socket.io-parser, ws, zod, quill, react-router 등 |
| REA run2: Claude Code 재시작 후 MCP 경로로 재평가 | - | sonnet | 대기(재시작 필요) | 30분 | | | run1과 같은 질문 Q1~Q3 |
| refactor/ws-write-path: 소켓 쓰기(message:send/edit/delete)를 REST 저장 + 소켓 push로 전환, 이벤트 이름 매핑 표 | - | opus | 대기 | 2h | | | REA run1·조사 문서 권장. 01·02와 websocket/index.ts 충돌 |
| 04-threads-view | - | sonnet | 대기(01 이후) | 2h | | | 스키마 변경(ThreadRead) |
| 05-user-status-dnd | - | sonnet | 대기(01 이후) | 1.5h | | | 스키마 변경(User 상태 필드), 01 shouldNotify 훅 |
| fix/frontend-typecheck-lint: slawk 원래 있던 tsc 30건, lint 76건 | dev-4 | sonnet | 진행 중 | 1.5h | 2026-10-31 09:40 | | CI frontend job 통과 조건 |
