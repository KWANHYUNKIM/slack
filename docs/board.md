# 작업 보드

| 파트 | 담당 | 모델 | 상태 | 예상 시간 | 시작 | 종료 | 비고 |
|---|---|---|---|---|---|---|---|
| 00-gap-analysis (Slack ↔ slawk 기능 비교와 파트 분할) | planner-1 | sonnet | 완료 | 60분 | 2026-10-31 08:55 | 2026-10-31 08:58 | 루프 1, 실제 약 3분. 결과: specs/00~03 |
| 01a-mentions-activity (백엔드) | dev-1 | sonnet | 완료(PR #8 머지) | 1.5h | 2026-10-31 10:05 | 2026-10-31 10:11 | P0, 스키마 변경. PR #5 위에 쌓음 |
| 01b-mentions-activity (프런트) | dev-5 | sonnet | 완료(PR #9 머지) | 1.5h | 2026-10-31 10:30 | 2026-10-31 10:35 | | 활동 탭, 배지, @channel |
| 03-channel-meta-star | dev-3 | sonnet | 완료(PR #21 머지) | 1.5h | 2026-10-31 19:50 | 2026-10-31 20:23 | P0, 스키마 변경 |
| 02-group-dm | dev-4 | opus | 완료(PR #23 머지) | 2h | 2026-10-31 20:25 | 2026-10-31 21:25 | P0, 스키마 변경, 01 병합 후 단독 |
| 04-threads-view, 05-user-status-dnd 스펙 | planner-2 | sonnet | 완료 | 40분 | 2026-10-31 09:36 | 2026-10-31 09:38 | 루프 3, Slack 테스트 채널 CRUD 실습 포함 |
| REA run1: Slack 데스크톱 앱 분석과 REA 평가 | planner-1 | opus | 완료 | 45분 | 2026-10-31 09:13 | 2026-10-31 09:35 | 루프 2 |
| 규칙 문서(git, FE, BE, 보안, 기술 스택, 엔터프라이즈·배포) | 총괄 | - | 완료 | 30분 | 2026-10-31 09:15 | 2026-10-31 09:35 | |
| fix/baseline-failing-tests: 기준 테스트 실패 6건과 Jest 미종료 | dev-1 | sonnet | 완료(PR #5 머지) | 1h | 2026-10-31 09:23 | 2026-10-31 09:48 | security, files, edge-cases, admin |
| ci: GitHub Actions ci.yml (backend 테스트 + frontend 빌드/린트) | dev-2 | haiku | 완료(PR #3 머지) | 1h | 2026-10-31 09:23 | 2026-10-31 09:26 | |
| D1 desktop-shell: Electron 셸, 서버 주소 입력, preload API, electron-builder | dev-4 | opus | 완료(PR #45 머지) | 2h | 2026-10-31 23:07 | | 보안 문서 9절 |
| D2 release: release.yml(Windows exe, dmg, AppImage를 Releases에 업로드), release-please | dev-4 | sonnet | 완료(PR #51 머지) | 1.5h | 2026-10-31 23:33 | | D1 이후 |
| E1~E10 엔터프라이즈 (architecture 문서 3절) | - | opus/sonnet | 진행(E4·E5·E6·E7·E7b·E7c·E10 완료, E1·E2·E3·E8·E9 대기) | | | | P0 이후 |
| 2026-10-31 09:00 | planner-2: Slack 기술 구조 조사 | planner-2 | sonnet | 완료 | 40분 | 2026-10-31 09:00 | 2026-10-31 09:02 | docs/research/slack-architecture.md |
| security/deps-upgrade-frontend: quill, react-router 등 | dev-3 | sonnet | 완료(PR #4 머지) | 1h | 2026-10-31 09:36 | 2026-10-31 09:38 | 루프 3 |
| security/deps-upgrade-backend: critical 1, high 다수, CI audit 차단 복구 | dev-4 | sonnet | 완료(PR #6 머지) | 1.5h | 2026-10-31 09:58 | 2026-10-31 10:01 | multer, sharp, socket.io-parser, ws, zod, quill, react-router 등 |
| REA run2: Claude Code 재시작 후 MCP 경로로 재평가 | - | sonnet | 대기(재시작 필요) | 30분 | | | run1과 같은 질문 Q1~Q3 |
| refactor/ws-write-path: 소켓 쓰기(message:send/edit/delete)를 REST 저장 + 소켓 push로 전환, 이벤트 이름 매핑 표 | - | opus | 대기 | 2h | | | REA run1·조사 문서 권장. 01·02와 websocket/index.ts 충돌 |
| 04-threads-view | dev-5 | sonnet | 완료(PR #26 머지) | 2.5h | 2026-10-31 21:42 | 2026-10-31 21:48 | 스키마 변경(ThreadRead) |
| 05-user-status-dnd | dev-1 | sonnet | 완료(PR #28 머지) | 1.5h | 2026-10-31 21:58 | 2026-10-31 22:07 | 스키마 변경(User 상태 필드), 01 shouldNotify 훅 |
| fix/frontend-typecheck-lint: slawk 원래 있던 tsc 30건, lint 76건 | dev-5 | sonnet | 완료(PR #7 머지) | 1.5h | 2026-10-31 09:58 | 2026-10-31 10:06 | CI frontend job 통과 조건 |
| feat/channel-name-unicode: 채널 이름에 한국어 등 유니코드 글자, 밑줄 허용 (백엔드 zod + 프런트 다이얼로그) | dev-5 | sonnet | 완료(PR #14 머지) | 1h | 12:23 | 12:33 | 총괄 결정: Slack과 같게 |
| security/file-scoped-download-token: 프런트가 파일별 토큰을 쓰게 하고 범위 없는 토큰 제거 검토 | dev-3 | sonnet | 완료(PR #52 머지) | 1h | 2026-10-31 23:33 | | PR #5 리뷰에서 발견 |
| perf/jwt-double-verify: rate limit 키 계산과 authMiddleware에서 JWT를 두 번 검증하는 것 정리 | - | haiku | 기록만 | 30분 | | | PR #5 리뷰 7번 |
| 테스트 채널 CRUD 실습: 메시지·스레드·리액션·상태·DND, 04·05 스펙 보완 | planner-1 | sonnet | 완료 | 40분 | 2026-10-31 09:58 | 2026-10-31 10:04 | #claude-test |
| test/suite-flaky-rest: 전체 npm test 3회 중 2회 실패(files 타임아웃, dms 회원가입 응답 누락, edge-cases 타임아웃, DB 컨테이너 연결 끊김). scale.test.ts는 POST 응답 상태 확인 추가 | dev-1 | sonnet | 완료(PR #15 머지) | 1h | 12:36 | 14:39 | 256MB DB 부하 의심 |
| feat/channel-name-hardening: 결합 문자 연속 개수 제한, 문자 체계 혼합(키릴+라틴 동형 문자) 차단 검토, 관리자 상한 80과 생성 상한 25 통일 여부 | dev-1 | sonnet | 완료(PR #94 머지) | 45분 | 2026-11-01 02:19 | 2026-11-01 02:40 | dev-5 남은 이슈 |
| fix/search-nfc: /search 질의와 메시지 본문 NFC 정규화(NFD 한글 질의 미일치) | dev-4 | sonnet | 완료(PR #33에 포함) | 1h | | | 06 search-v2와 함께 |
| test/scale-flaky: scale.test.ts '100 messages'가 400으로 한 번 실패, 재현 안 됨 | - | haiku | 관찰 | | | | PR #5 |
| verify/gcs-v8: @google-cloud/storage 8 실제 버킷 업로드·다운로드·삭제 확인 | - | haiku | 배포 전 | 30분 | | | PR #6에서 확인 못 함 |
| build/docker-self-contained: 원작자 GCP base 이미지 의존 제거, 자체 Dockerfile과 이미지 빌드 | dev-5 | sonnet | 완료(PR #55 머지) | 1.5h | 2026-10-31 23:23 | | PR #6 리뷰 1번. 웹 배포 전제 |
| verify/e2e-smoke: 백엔드+프런트 띄우고 Playwright 핵심 CRUD 스모크(메시지·스레드·DM·핀·검색 + 이번 세션 기능: 2FA·QR·비밀번호 변경·관리 탭·DLP 문구·언어 전환) | dev-2 | sonnet | 완료(PR #116 머지) | 1.5h | 2026-11-01 04:14 | 2026-11-01 04:21 | PR #7 수동 확인 항목 |
| feat/mentions-scheduled-webhook: 예약 메시지·웹훅 메시지에도 멘션 활동 생성 | dev-1 | haiku | 완료(PR #42 머지) | 30분 | 2026-10-31 23:03 | | PR #8 남은 이슈 |
| i18n-1 infra: i18next, 문자열 추출, 언어 선택 UI, Intl, html lang/dir | dev-2 | sonnet | 완료(PR #11 머지) | 2.5h | | | docs/architecture/i18n.md |
| i18n-2 ko: 한국어 번역 전체와 검수 | dev-1 | sonnet | 완료(PR #47 머지) | 1.5h | 2026-10-31 23:23 | | 1등급 |
| i18n-3 backend: 오류 code, User.locale·timeZone, 푸시 문구 | dev-4 | sonnet | 완료(PR #71 머지) | 2h | 2026-11-01 00:07 | | |
| i18n-4 rtl: 논리 속성 전환, ar/he 점검 | dev-3 | sonnet | 완료(PR #74 머지) | 1.5h | 2026-11-01 00:48 | | |
| i18n-5 tier2: 31개 언어 기계 번역, 누락 키 CI(5a: 기반+ja·zh-Hans·es, 나머지 28개는 후속) | dev-5 | haiku | 5a·5b 완료(7/31), 5c(it·ru·uk·pl) 진행 | 2h | 2026-11-01 04:29 | | |
| chore/self-contained-assets: emoji-mart i18n 번들, mocks 삭제, CSP 축소, 외부 URL CI 검사 | dev-2 | sonnet | 완료(PR #19 머지) | 1.5h | 2026-10-31 19:50 | 2026-10-31 20:08 | docs/architecture/self-contained-assets.md |
| feat/builtin-stun: 내장 STUN, /huddles/config | dev-4 | sonnet | 완료(PR #10 머지) | 1.5h | | | Google STUN 제거 |
| mcp-1 server+PAT: /mcp, PAT, 읽기 도구 | dev-2 | opus | 완료(PR #43 머지) | 2.5h | 2026-10-31 22:57 | | docs/architecture/mcp.md |
| mcp-2 write tools: 쓰기 도구, 감사 로그, MCP rate limit | dev-2 | sonnet | 완료(PR #49 머지) | 2h | 2026-10-31 23:23 | | |
| mcp-3 search+files: 검색, 파일, 리소스, 프롬프트 | dev-2 | sonnet | 완료(PR #68 머지) | 1.5h | 2026-11-01 00:15 | | |
| mcp-4 oauth: OAuth 2.1, claude.ai 커넥터 | dev-4 | opus | 완료(PR #107 머지) | 3h | 2026-11-01 03:16 | | |
| fix/channel-read-clears-mentions: 채널을 열어 끝까지 읽어도 오래된 멘션 배지가 남는 문제(01a markChannelMentionsRead 기준점 확인) | dev-1 | sonnet | 완료(PR #12 머지) | 45분 | | | PR #9 브라우저 확인에서 발견 |
| fix/i18n-followups: 허들 오류 문구 키 연결(PR #10 후), <Trans>로 굵은 글씨·kbd 복원, 스레드 placeholder 즉시 반영 | dev-1 | haiku | 완료(PR #90 머지) | 45분 | 2026-11-01 02:11 | 2026-11-01 02:18 | PR #11 남은 이슈 |
| verify/e2e-smoke에 Playwright 포트 분리 포함(3000·5173은 다른 프로젝트) | | | | | | | PR #11 |
| test/flaky-activity: 원인 2개 확정(소켓 연결 직후 리스너 없음, 활동 후처리 경쟁) → 브랜치 fix/activity-race(b79bf51, #12 위 스택). activity 30회 0 실패. 남은 전체 스위트 간헐 실패(요청 멈춤, DB 컨테이너 연결 끊김)는 원인 미확정 | dev-3 | opus | 완료(PR #13 머지) | 1.5h | 11:12 | 12:20 | 실제 70분 |
| feat/stun-public-port: 컨테이너 UDP 포트 매핑이 다를 때 STUN_PUBLIC_PORT | dev-3 | haiku | 완료(PR #109 머지) | 20분 | 2026-11-01 03:48 | 2026-11-01 03:52 | PR #10 남은 이슈 |
| fix/auth-error-logging: auth 미들웨어 catch가 DB 오류까지 401로 삼켜 진단이 어려움 → logError, 인증 실패와 서버 오류 구분 | dev-1 | haiku | 완료(PR #38 머지) | 30분 | 2026-10-31 22:52 | | PR #15 남은 이슈 |
| fix/admin-store-rethrow: useAdminStore.editChannel이 실패를 삼켜 컴포넌트가 이름 비교로 추정 → 다시 던지기 | dev-1 | haiku | 완료(PR #38 머지) | 20분 | 2026-10-31 22:52 | | PR #14 남은 이슈 |
| feat/channel-name-taken-code: 중복 채널 이름 오류에 code(CHANNEL_NAME_TAKEN)와 errors 번역(POST /channels·관리자 변경) | dev-3 | sonnet | 완료(PR #21에 포함) | 30분 | | | PR #14 남은 이슈 |
| feat/channel-name-skeleton: UTS #39 skeleton 컬럼으로 단일 체계 동형 이름(рау/pay, ɡ/g) 유니크 검사 | - | opus | 대기(스키마) | 2h | | | PR #14 남은 이슈 |
| 00b-gap-analysis-v2: 실제 Slack(#claude-test)과 현재 main 기능 비교, CRUD 관찰, 차이 우선순위 표와 다음 파트 스펙(06~) | planner-1 | sonnet | 완료(문서 기반, 브라우저 미관찰) | 1h | 2026-10-31 21:42 | 2026-10-31 21:45 | Claude in Chrome 도구 없음 → 04·05·06~10 "검증 필요" 항목 브라우저 재관찰 필요 | 2026-10-31 20:33 사용자 지시 |
| 06-quick-switcher-shortcuts: Cmd/Ctrl+K 빠른 전환기, 전역 단축키 | dev-2 | sonnet | 완료(PR #30 머지) | 1.5h | 2026-10-31 22:17 | 2026-10-31 22:20 | 00b |
| 07-message-permalink: 메시지 링크 복사와 딥링크 | dev-3 | sonnet | 완료(PR #32 머지) | 1.5h | 2026-10-31 22:26 | 2026-10-31 22:32 | 00b |
| 08-search-v2: from:/in:/날짜 필터, 탭, 하이라이트 | dev-4 | sonnet | 완료(PR #33 머지) | 2h | 2026-10-31 22:26 | 2026-10-31 22:37 | 00b, 기존 fix/search-nfc 흡수 |
| 10-unread-divider: 안 읽음 구분선 | dev-3 | sonnet | 완료(PR #36 머지) | 1.5h | 2026-10-31 22:43 | 2026-10-31 22:49 | 00b |
| 09-reminders: 리마인더 | dev-5 | sonnet | 완료(PR #34 머지) | 1.5h | 2026-10-31 22:30 | 2026-10-31 22:39 | 00b, 스키마 |
| 00c-slack-browser-verify: Claude in Chrome으로 #claude-test CRUD 재관찰, 06~10 "검증 필요" 확인 | - | sonnet | 대기(브라우저 도구 필요) | 1h | | | 사용자 확인 필요 |
| feat/dm-unread-divider: 1:1 DM·그룹 DM 안 읽음 구분선(기준점 필드, 열 때 읽음 처리 순서) | dev-3 | sonnet | 완료(PR #41 머지) | 1h | 2026-10-31 23:01 | | PR #36 남은 이슈 |
| fix/admin-store-actions: useAdminStore 나머지 액션(delete/archive/role) 실패 전달과 호출 측 처리 | dev-1 | haiku | 완료(PR #42 머지) | 30분 | 2026-10-31 23:03 | | PR #38 남은 이슈 |
| mcp-2b send_dm: MCP DM·그룹 DM 쓰기·읽기 도구(DM 공용 서비스 추출) | dev-2 | sonnet | 완료(PR #63 머지, #58 빈 머지 재제출) | 1.5h | 2026-10-31 23:40 | | PR #49 남은 이슈 |
| feat/bootstrap-owner: 빈 DB 배포에서 첫 OWNER 생성 경로(사용자 0명일 때만, 동시성 안전) | dev-5 | opus | 완료(PR #57 머지) | 1h | 2026-10-31 23:44 | | PR #55에서 발견 |
| fix/emoji-cdn-runtime: emoji-mart data를 번들로, dist CDN 도메인 검사 | dev-1 | sonnet | 완료(PR #64 머지) | 1h | 2026-11-01 00:00 | | PR #55에서 발견(규칙 17) |
| chore/ops-followups: .env.example BOOTSTRAP 키, compose $$ 안내, 자동 업데이트 문서 정리, ci.yml action SHA 고정 | dev-3 | haiku | 완료(PR #61 머지) | 45분 | 2026-11-01 00:00 | | |
| E4 감사 로그 강화: 기록 범위 보강, 조회·필터 API, CSV/JSON 내보내기(수식 주입 방지), 보존 기간, 관리자 탭 | dev-1 | sonnet | 완료(PR #77 머지) | 2h | 2026-11-01 00:48 | | 엔터프라이즈 3절, 선행 없음 |
| E7 세션 관리: Session 모델·sid, 기기 목록·개별/전체 로그아웃, 관리자 강제 로그아웃 UI, 유휴·최대 수명 정책(2FA는 E7b) | dev-5 | sonnet | 완료(PR #80 머지) | 2h | 2026-11-01 01:17 | | 엔터프라이즈 3절 |
| E5 데이터 보존 정책: 워크스페이스·채널 보존 일수, 일 1회 하드 삭제 배치, legalHold 제외 자리, 관리자 탭 | dev-1 | sonnet | 완료(PR #84 머지) | 2h | 2026-11-01 01:40 | 2026-11-01 02:00 | 엔터프라이즈 3절 |
| E7b 2단계 인증: TOTP(암호화 저장), 복구 코드, 로그인 2단계, 조직 필수 정책, 관리자 초기화 | dev-4 | opus | 완료(PR #89 머지) | 2h | 2026-11-01 01:40 | 2026-11-01 02:48 | E7 후속 |
| E6 법적 보존과 eDiscovery: LegalHold 건·대상자, 보존 정리 제외, 관리자 검색·스트리밍 내보내기, 감사 로그 | dev-1 | opus | 완료(PR #98 머지) | 2h | 2026-11-01 02:42 | 2026-11-01 02:55 | 엔터프라이즈 3절, 마이그레이션 060000 |
| E10 DLP: 정규식 규칙(내장 카드·주민번호·AWS 키·개인 키), 차단/경고, ReDoS 방지, 관리자 탭 | dev-5 | sonnet | 완료(PR #96 머지) | 2h | 2026-11-01 02:42 | 2026-11-01 02:51 | 엔터프라이즈 3절, 마이그레이션 070000 |
| test/flaky-code-under-load: 전체 스위트에서만 channel-name-unicode의 400 응답 code 누락·edge-cases 타임아웃 재현, 원인 조사 | dev-3 | sonnet | 완료(PR #87 머지, 원인: supertest listen(0) 듀얼스택 바인딩을 다른 로컬 프로세스가 가로챔) | 1h | 2026-11-01 01:48 | 2026-11-01 02:11 | 2026-11-01 전체 스위트 |
| E7c 2FA 후속: 로컬 QR 렌더링(외부 의존 없이), 복구 코드 재발급 API·UI | dev-4·dev-5 | sonnet | 복구 코드 재발급 완료(PR #99), QR 완료(PR #101 머지) | 1.5h | | | E7b 남은 이슈 |
| e2e/vite-proxy-target, e2e/2fa-hang(ThreadsPage 체크는 #120에서 해결): ThreadsPage 같은 체크 초기화 패턴, vite 프록시 대상 환경 변수화, 2FA E2E가 고스왑 환경에서 멈추는 원인 조사 | - | haiku | 대기 | 1h | | | PR #120 남은 이슈 |
| fix/spa-routes: 프로덕션 spaRoutes에 /search, /unreads 등 누락 확인·보완(새로고침 시 API 응답) | dev-2 | haiku | 완료(PR #120 머지) | 30분 | 2026-11-01 04:49 | | E2E 남은 이슈 |
| fix/thread-alsosend-race, fix/login-admin-nav-race: 스레드 '채널에도 보내기' 체크 해제 경합, 로그인 직후 관리자 이동 경합 | dev-2 | haiku | 완료(PR #120 머지) | 45분 | 2026-11-01 04:49 | 2026-11-01 05:06 | E2E 남은 이슈 |
| fix/channel-purge-order: 채널 메시지 정리(deleteMessages, blankParents)도 DB 처리 행(RETURNING) 기준으로 저장소 파일을 사후 삭제할지, 본체 삭제 실패 재시도 방식 통일 | dev-3 | sonnet | 완료(PR #112 머지) | 45분 | 2026-11-01 04:14 | | PR #106 남은 이슈 |
| spec/E1-multi-workspace: E1 조직·멀티 워크스페이스 스펙과 파트 분할(E2·E3·E8·E9 의존 정리), Enterprise Grid 조사 | planner-1 | opus | 완료(D1~D11 제안안 확정) | 1.5h | 2026-11-01 03:54 | 2026-11-01 04:03 | 엔터프라이즈 3절 |
| E1a 스키마와 백필(Organization·Workspace·WorkspaceMember·ChannelWorkspace, 기본 조직·워크스페이스 백필) | dev-4 | opus | PR #115 재리뷰 반영 중 | 2h | 2026-11-01 04:22 | 2026-11-01 04:19 | docs/specs/E1-multi-workspace.md 9절 |
| E1b 워크스페이스 컨텍스트와 API(resolveWorkspace, /workspaces, ws:<id> room) | - | opus | 대기(E1a 후) | 2h | | | E1 스펙 |
| E1c 채널·사용자·관리 격리(io.emit 4곳 제거, 이름 유니크 워크스페이스 단위) | - | opus | 대기(E1b 후) | 2h | | | E1 스펙 |
| E1d DM·검색·활동·MCP 워크스페이스 범위 | - | sonnet | 대기(E1c 후) | 2h | | | E1 스펙 |
| E1e 조직 거버넌스 설정 분리 | - | sonnet | 대기(E1d 후) | 2h | | | E1 스펙 |
| E1f 프런트 전환기와 /w/:id URL | - | sonnet | 대기(E1c 후, E1d와 병렬 가능) | 2h | | | E1 스펙 |
| E1g 조직 내부 공유 채널 | - | opus | 대기(E1c·E1f 후) | 2h | | | E1 스펙 |
| E1h 관리 화면 분리·User.role 제거·누출 매트릭스 | - | sonnet | 대기(E1e·E1f·E1g 후) | 2h | | | E1 스펙 |
| test/error-code-coverage-consts: 정적 검사가 code를 담은 상수 객체(.json(MFA_TOKEN_EXPIRED) 등)를 오탐 → main에서 실패 | dev-3 | haiku | 완료(PR #104 머지) | 30분 | 2026-11-01 03:24 | 2026-11-01 03:27 | PR #98 검토 중 발견 |
| fix/dm-delete-detach: DM 삭제도 첨부를 분리할지 결정, 분리 첨부 재연결 방지(detachedFrom* null 조건) | dev-3 | sonnet | 완료(PR #105 머지) | 45분 | 2026-11-01 03:29 | 2026-11-01 03:33 | PR #98 남은 이슈 |
| feat/group-membership-history: 그룹 DM 구성원 이력(가입·탈퇴 시각)으로 eDiscovery·법적 보존이 나간 대상자의 재직 기간 메시지까지 포함 | dev-1 | opus | 완료(PR #106 머지) | 1.5h | 2026-11-01 03:25 | 2026-11-01 03:32 | PR #98 리뷰 4번 |
| fix/read-cursor-race: 동시 /channels/:id/read에서 커서가 최대 id보다 작게 남는 경쟁(activity.test.ts:748, 1/6회) | dev-3 | sonnet | 완료(PR #93 머지) | 45분 | 2026-11-01 02:26 | 2026-11-01 02:30 | PR #91 보고 |
| refactor/api-401-by-code: 프런트 request()가 401 전체가 아니라 토큰 code(AUTH_INVALID_TOKEN 등)일 때만 로그아웃, 이후 2FA·비밀번호 오류 상태 코드 정리 | dev-4 | sonnet | 완료(PR #97 머지) | 1h | 2026-11-01 02:49 | 2026-11-01 02:56 | PR #89 리뷰 |
| feat/account-password-ui: 프런트 비밀번호 변경 화면(AUTH_CURRENT_PASSWORD_INCORRECT 표시) | dev-4 | sonnet | 완료(PR #99 머지) | 45분 | 2026-11-01 02:58 | | PR #86 남은 이슈 |
| test/socket-listen-loopback: websocket 등 host 없는 httpServer.listen()도 127.0.0.1 고정 검토 | dev-3 | haiku | 완료(PR #91 머지) | 30분 | 2026-11-01 02:15 | 2026-11-01 02:24 | PR #87 남은 이슈 |
| fix/change-password-401: 틀린 비밀번호에 401 → 프런트가 로그아웃 처리. 400/403+code로 변경 | dev-5 | haiku | 완료(PR #86 머지) | 0.5h | 2026-11-01 02:05 | 2026-11-01 02:09 | E7b 보고 |
