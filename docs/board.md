# 작업 보드

| 파트 | 담당 | 모델 | 상태 | 예상 시간 | 시작 | 종료 | 비고 |
|---|---|---|---|---|---|---|---|
| 00-gap-analysis (Slack ↔ slawk 기능 비교와 파트 분할) | planner-1 | sonnet | 완료 | 60분 | 2026-10-31 08:55 | 2026-10-31 08:58 | 루프 1, 실제 약 3분. 결과: specs/00~03 |
| 01a-mentions-activity (백엔드) | dev-1 | sonnet | PR #8 (리뷰 반영 완료) | 1.5h | 2026-10-31 10:05 | 2026-10-31 10:11 | P0, 스키마 변경. PR #5 위에 쌓음 |
| 01b-mentions-activity (프런트) | dev-5 | sonnet | PR #9 (리뷰 반영 중) | 1.5h | 2026-10-31 10:30 | 2026-10-31 10:35 | | 활동 탭, 배지, @channel |
| 03-channel-meta-star | - | sonnet | 대기 | 1.5h | | | P0, 스키마 변경 |
| 02-group-dm | - | opus | 대기 | 2h | | | P0, 스키마 변경, 01 병합 후 단독 |
| 04-threads-view, 05-user-status-dnd 스펙 | planner-2 | sonnet | 완료 | 40분 | 2026-10-31 09:36 | 2026-10-31 09:38 | 루프 3, Slack 테스트 채널 CRUD 실습 포함 |
| REA run1: Slack 데스크톱 앱 분석과 REA 평가 | planner-1 | opus | 완료 | 45분 | 2026-10-31 09:13 | 2026-10-31 09:35 | 루프 2 |
| 규칙 문서(git, FE, BE, 보안, 기술 스택, 엔터프라이즈·배포) | 총괄 | - | 완료 | 30분 | 2026-10-31 09:15 | 2026-10-31 09:35 | |
| fix/baseline-failing-tests: 기준 테스트 실패 6건과 Jest 미종료 | dev-1 | sonnet | PR #5 (리뷰 반영 완료) | 1h | 2026-10-31 09:23 | 2026-10-31 09:48 | security, files, edge-cases, admin |
| ci: GitHub Actions ci.yml (backend 테스트 + frontend 빌드/린트) | dev-2 | haiku | PR #3 | 1h | 2026-10-31 09:23 | 2026-10-31 09:26 | |
| D1 desktop-shell: Electron 셸, 서버 주소 입력, preload API, electron-builder | - | opus | 대기 | 2h | | | 보안 문서 9절 |
| D2 release: release.yml(Windows exe, dmg, AppImage를 Releases에 업로드), release-please | - | sonnet | 대기 | 1.5h | | | D1 이후 |
| E1~E10 엔터프라이즈 (architecture 문서 3절) | - | opus/sonnet | 대기 | | | | P0 이후 |
| 2026-10-31 09:00 | planner-2: Slack 기술 구조 조사 | planner-2 | sonnet | 완료 | 40분 | 2026-10-31 09:00 | 2026-10-31 09:02 | docs/research/slack-architecture.md |
| security/deps-upgrade-frontend: quill, react-router 등 | dev-3 | sonnet | PR #4 | 1h | 2026-10-31 09:36 | 2026-10-31 09:38 | 루프 3 |
| security/deps-upgrade-backend: critical 1, high 다수, CI audit 차단 복구 | dev-4 | sonnet | PR #6 (리뷰 반영 중) | 1.5h | 2026-10-31 09:58 | 2026-10-31 10:01 | multer, sharp, socket.io-parser, ws, zod, quill, react-router 등 |
| REA run2: Claude Code 재시작 후 MCP 경로로 재평가 | - | sonnet | 대기(재시작 필요) | 30분 | | | run1과 같은 질문 Q1~Q3 |
| refactor/ws-write-path: 소켓 쓰기(message:send/edit/delete)를 REST 저장 + 소켓 push로 전환, 이벤트 이름 매핑 표 | - | opus | 대기 | 2h | | | REA run1·조사 문서 권장. 01·02와 websocket/index.ts 충돌 |
| 04-threads-view | - | sonnet | 대기(01 이후) | 2.5h | | | 스키마 변경(ThreadRead) |
| 05-user-status-dnd | - | sonnet | 대기(01 이후) | 1.5h | | | 스키마 변경(User 상태 필드), 01 shouldNotify 훅 |
| fix/frontend-typecheck-lint: slawk 원래 있던 tsc 30건, lint 76건 | dev-5 | sonnet | PR #7 (리뷰 반영 완료) | 1.5h | 2026-10-31 09:58 | 2026-10-31 10:06 | CI frontend job 통과 조건 |
| feat/channel-name-unicode: 채널 이름에 한국어 등 유니코드 글자, 밑줄 허용 (백엔드 zod + 프런트 다이얼로그) | - | haiku | 대기(우선순위 올림, i18n) | 45분 | | | 총괄 결정: Slack과 같게 |
| security/file-scoped-download-token: 프런트가 파일별 토큰을 쓰게 하고 범위 없는 토큰 제거 검토 | - | sonnet | 대기 | 1h | | | PR #5 리뷰에서 발견 |
| perf/jwt-double-verify: rate limit 키 계산과 authMiddleware에서 JWT를 두 번 검증하는 것 정리 | - | haiku | 기록만 | 30분 | | | PR #5 리뷰 7번 |
| 테스트 채널 CRUD 실습: 메시지·스레드·리액션·상태·DND, 04·05 스펙 보완 | planner-1 | sonnet | 완료 | 40분 | 2026-10-31 09:58 | 2026-10-31 10:04 | #claude-test |
| test/scale-flaky: scale.test.ts '100 messages'가 400으로 한 번 실패, 재현 안 됨 | - | haiku | 관찰 | | | | PR #5 |
| verify/gcs-v8: @google-cloud/storage 8 실제 버킷 업로드·다운로드·삭제 확인 | - | haiku | 배포 전 | 30분 | | | PR #6에서 확인 못 함 |
| build/docker-self-contained: 원작자 GCP base 이미지 의존 제거, 자체 Dockerfile과 이미지 빌드 | - | sonnet | 대기 | 1.5h | | | PR #6 리뷰 1번. 웹 배포 전제 |
| verify/e2e-smoke: 백엔드+프런트 띄우고 Playwright 핵심 CRUD 스모크(메시지·스레드·DM·핀·검색) | - | sonnet | 대기(정상 단계에서만) | 1h | | | PR #7 수동 확인 항목 |
| feat/mentions-scheduled-webhook: 예약 메시지·웹훅 메시지에도 멘션 활동 생성 | - | haiku | 대기 | 30분 | | | PR #8 남은 이슈 |
| i18n-1 infra: i18next, 문자열 추출, 언어 선택 UI, Intl, html lang/dir | - | sonnet | **다음 최우선**(01b 반영 후) | 2.5h | | | docs/architecture/i18n.md |
| i18n-2 ko: 한국어 번역 전체와 검수 | - | sonnet | 대기 | 1.5h | | | 1등급 |
| i18n-3 backend: 오류 code, User.locale·timeZone, 푸시 문구 | - | sonnet | 대기(스키마 순서) | 2h | | | |
| i18n-4 rtl: 논리 속성 전환, ar/he 점검 | - | sonnet | 대기 | 1.5h | | | |
| i18n-5 tier2: 31개 언어 기계 번역, 누락 키 CI | - | haiku | 대기 | 2h | | | |
| chore/self-contained-assets: emoji-mart i18n 번들, mocks 삭제, CSP 축소, 외부 URL CI 검사 | - | sonnet | 대기(우선) | 1.5h | | | docs/architecture/self-contained-assets.md |
| feat/builtin-stun: 내장 STUN, /huddles/config | - | sonnet | 대기 | 1.5h | | | Google STUN 제거 |
| mcp-1 server+PAT: /mcp, PAT, 읽기 도구 | - | opus | 대기(01a 머지 후) | 2.5h | | | docs/architecture/mcp.md |
| mcp-2 write tools: 쓰기 도구, 감사 로그, MCP rate limit | - | sonnet | 대기 | 2h | | | |
| mcp-3 search+files: 검색, 파일, 리소스, 프롬프트 | - | sonnet | 대기(06 이후) | 1.5h | | | |
| mcp-4 oauth: OAuth 2.1, claude.ai 커넥터 | - | opus | 대기 | 3h | | | |
