# Slack 데스크톱 앱 정적 분석 (REA + 대조 관찰)

작성: planner-1 / 2026-10-31 (루프 2). 대상: `/Applications/Slack.app` 4.53.276 (macOS, universal). 정적 분석만 했다(앱 실행, 주입, 수정 없음).
추출물은 스크래치패드에만 두었고 이 문서에는 이름(이벤트명, API 메서드명, 모듈 구조)만 적는다. Slack 코드는 인용하지 않는다.

표기: **확인** = 산출물 바이트나 관찰에서 직접 본 사실, **추정** = 이름/구조에서 유추한 것.
근거 열의 약어:
- `R-desk` = REA `inspect-desktop-application` (Evidence `ev_44985852…`)
- `R-fuse` = REA `inspect-electron-fuses` (Evidence `ev_1ce0a382…`)
- `R-js` = REA `analyze-javascript-application` app-arm64.asar 전체 (parent Evidence `ev_9159c0f2…`, 97MB 번들)
- `R-js-main` = REA 같은 도구를 `dist/main.bundle.cjs` 하나에 힙 1800MiB로 재실행. **실패**(힙 소진, findings 0). 그래서 main 프로세스(1.7MB) 관련 결론은 전부 `G`에 의존한다
- `G` = REA 없이 직접 만든 ASAR 추출 스크립트 + grep (기준선)
- `C` = Claude in Chrome으로 웹 클라이언트 읽기 전용 관찰 (리소스 목록, 로드된 스크립트 문자열 집계)

REA는 MCP 도구가 이 세션에 노출되지 않아 CLI(`npx -y rea-agents@6.8.0 …`)로 대신 실행했다. 상세는 `docs/ops/rea-evaluation-run1.md`.

## 1. 앱 구성

| 항목 | 결과 | 근거 | 확신도 |
|---|---|---|---|
| 앱 버전 | 4.53.276, 최소 지원 버전 4.44.0, 빌드 커밋 단축 해시 있음 | G (package.json), Info.plist | 확인 |
| Electron | 45.1.0 (Electron Framework Info.plist CFBundleVersion) | G | 확인 |
| 런타임 계열 | Electron 후보로 판정 | R-desk | 확인(REA는 "inferred"로 표시) |
| Electron fuse | RunAsNode 끔, NodeOptions 환경변수 끔, `--inspect` 인자 끔, 쿠키 암호화 켬, ASAR 무결성 검증 켬, ASAR에서만 로드 켬, file 프로토콜 추가 권한 끔. x64/arm64 슬라이스 동일 | R-fuse | 확인 |
| ASAR 구성 | `app.asar`(3KB)는 아키텍처 분기 스텁. `process.arch`에 따라 `app-arm64.asar` 또는 `app-x64.asar`(각 9.8MB)를 앱 경로로 바꿔 로드 | G (스텁 index.js 읽음) | 확인 |
| 진입점 | `dist/boot.bundle.cjs`(23KB) -> `dist/main.bundle.cjs`(1.7MB, main 프로세스 본체) + `898.bundle.cjs`(공용 청크) | G | 확인 |
| preload | `preload.bundle.js`(웹앱 창용, 770KB), `component-preload-entry-point`(보조 창), `child-preload-entry-point`(자식 창), `magic-login-preload-entry-point`(매직 링크 로그인) | G, R-js(파일 인벤토리) | 확인 |
| contextBridge 노출 이름 | `slackPlatform`(메인 웹앱 창), `desktop`(보조/자식 창), `__SENTRY_IPC__`(오류 보고), `process`(보조 창) | G. R-js는 "context_bridge_apis 2, exposed members 3"만 집계 | 확인 |
| 로컬 렌더러 HTML | 설정 편집기, 네트워크 로그 창, 기본 인증(HTTP basic auth) 창 3개뿐 | R-js(electron-renderer 노드), G | 확인 |
| 웹 클라이언트 | **번들에 없음.** 메시지 UI(React/Redux 웹앱)는 `app.slack.com/client/...`에서 원격 로드. main 번들에 URL을 `/client`, `/ssb` 경로로 분류하는 로직과 `ssb/signin`, `ssb/add`, `ssb/signout` 같은 셸 경로가 있음 ("ssb"는 데스크톱 셸의 내부 명칭으로 보임) | G (번들 내용 + 크기), C (웹앱 51개 JS, 약 46MB가 a.slack-edge.com에서 로드) | 확인(원격 로드), 추정(ssb 의미) |
| 창 구성 | `BrowserWindow` 생성 지점 3곳, `BrowserView`/`WebContentsView` 문자열 없음, `webviewTag` 설정 1회 | G | 확인(문자열), 추정(단일 창 + webview 여부는 런타임 미확인) |
| 네이티브 애드온 | 키맵, 데스크톱 유틸, macOS 환경설정(cf-prefs), 네이티브 인증, 파일 핸들러 정보, macOS 알림 상태, Windows 레지스트리/집중 모드 | G (package.json), R-js(무결성 불일치 경고 8건이 정확히 이 .node 파일들) | 확인 |
| 상태 관리 | main 프로세스에 Redux 스토어가 있고 렌더러가 `redux-action` IPC로 액션을 보냄. 웹앱 상태를 셸로 올리는 `REDUX_UPDATE_FROM_WEBAPP` 액션 | G | 확인(이름), 추정(동기화 방향) |

## 2. 실시간 (WebSocket)

데스크톱 셸 번들에는 WebSocket 클라이언트 코드가 사실상 없다. 실시간 연결은 원격 웹앱이 담당한다.

| 항목 | 결과 | 근거 | 확신도 |
|---|---|---|---|
| 셸의 WebSocket | `new WebSocket` 생성 없음. 문자열 `WebSocketWorker`(5회)와 네트워크 로그 필터용 `webSocket` 리소스 타입만 있음. REA의 request 추출기도 셸 번들에서 WebSocket 생성을 찾지 못함 | G, R-js(request family에 WebSocket 없음) | 확인 |
| 소켓 위치 | 웹앱이 **Worker 안에서** 소켓을 연다. 페이지의 리소스 타이밍과 확장 프로그램의 네트워크 기록 모두에 wss 요청이 안 보였고, 셸에 `WebSocketWorker` 이름이 있음 | C, G | 추정(강함) |
| 연결 대상 | 웹앱 스크립트에 `wss-primary.slack.com` 호스트 문자열과 템플릿 형태의 `wss://${…}`가 있음. 소켓 URL은 API `client.getWebSocketURL`로 받는 구조 | C | 확인(이름), 추정(흐름) |
| 이벤트 타입 이름 (웹앱 스크립트에서 발견) | `hello`, `goodbye`, `ping`, `pong`, `reconnect_url`, `message`, `message_changed`, `message_deleted`, `message_replied`, `reaction_added`, `reaction_removed`, `user_typing`, `presence_change`, `manual_presence_change`, `presence_sub`, `channel_marked`, `im_marked`, `thread_marked`, `channel_created`, `channel_joined`, `member_joined_channel`, `member_left_channel`, `pin_added`, `star_added`, `file_shared`, `pref_change`, `user_change`, `emoji_changed`, `dnd_updated_user`, `flannel` | C (로드된 스크립트에서 따옴표 문자열 일치 집계) | 확인(이름 존재), 추정(전송 방향/페이로드) |
| 재연결/핑 단서 | 웹앱 스크립트에 `reconnect` 277회, `backoff` 33회, `socket_closed`, `online`/`offline`, `visibilitychange` 다수. 셸에는 `powerMonitor`의 `suspend`/`resume`/`lock-screen`/`unlock-screen` 핸들러와 `SET_NETWORK_STATUS`, `ONLINE`, `SET_SYSTEM_IDLE` 액션 | C, G | 추정(백오프 재연결 + 절전 복귀 시 재연결) |
| 셸 쪽 연결 상태 | main이 OS 네트워크/절전 상태를 감지해 웹앱에 알리는 구조로 보임 | G | 추정 |

## 3. 클라이언트 API

| 항목 | 결과 | 근거 | 확신도 |
|---|---|---|---|
| 셸이 직접 부르는 API | `api.test`, `auth.loginMagicBulk`, `signin.claimDeviceMultipass`, `desktop.features`, 업데이트 확인 `desktop/update/v2/should-i-update` 정도. 나머지 API는 웹앱이 호출 | G | 확인 |
| 부트 시 실제 호출 (채널 하나 열 때) | `client.init`, `client.counts`, `client.channels`, `client.extras`, `client.shouldReload`, `conversations.view`, `conversations.history`, `users.prefs.get`, `drafts.list`, `dnd.info`, `users.customStatus.list`, `experiments.getByUser`, `api.features` 등 약 30개. 호스트는 워크스페이스 전용 서브도메인 `<워크스페이스>.slack.com/api/` | C (리소스 타이밍의 경로만 집계) | 확인 |
| Flannel(엣지 캐시) | `edgeapi.slack.com/cache/<team>/users/info`, `users/list`, `users/counts`, `channels/membership`, `permissions/info`, `huddles/list|info` 호출을 관찰. 사용자/채널 정보는 Flannel에서 lazy 조회 | C | 확인 |
| 구 부트 API | `rtm.start` 문자열은 남아 있으나 부트 시 호출 안 됨. `rtm.connect` 없음. 부트는 `client.init` 계열 | C | 확인 |
| 웹앱 스크립트의 메서드 이름 (계열별 개수) | conversations 76, users 62, files 66, client 37, search 24, chat 16, drafts 7, subscriptions 7, bookmarks 6, dnd 5, channels 4, pins 3, stars 3, reactions 3, im 3, rtm 2 | C | 확인(이름 존재) |
| 핵심 메서드 | `chat.postMessage`, `chat.update`, `chat.delete`, `conversations.history`, `conversations.replies`, `conversations.mark`, `conversations.info`, `conversations.members`, `conversations.join`, `conversations.leave`, `reactions.add`, `reactions.remove`, `reactions.get`, `users.info`, `users.list`, `pins.add`, `pins.remove`, `subscriptions.thread.add`, `drafts.create`, `drafts.update`, `users.channelSections.list` | C | 확인(이름 존재) |

## 4. 데스크톱 전용 기능

| 기능 | 결과 | 근거 | 확신도 |
|---|---|---|---|
| 알림 | `new Notification` 1곳, 액션 `NEW_NOTIFICATION`, `CLICK_NOTIFICATION`, `REPLY_TO_NOTIFICATION`(알림에서 답장), `NOTIFICATION_ACTION`, `REMOVE_NOTIFICATION`, `ZERO_MAX_NOTIFICATIONS`, `MACOS_NOTIFICATIONS_DISABLED`, `SLACK_BOUNCE_DOCK`. 네이티브 애드온으로 macOS 알림 허용 상태 / Windows 집중 모드 확인 | G | 확인(이름) |
| 배지 | `dock.setBadge` 1회, `SET_TASKBAR_BADGE` | G | 확인 |
| 딥링크 | `setAsDefaultProtocolClient` 2회, `open-url`(macOS), `second-instance`(Windows/Linux), `requestSingleInstanceLock`. 경로 `slack://open`, `slack://doc`, `slack://toolbelt-callback`, 패턴 `slack://app…`, `slack://setting…`. 액션 `HANDLE_DEEP_LINK`, `FORWARD_DEEP_LINK`, `WHITELIST_PROTOCOL` | G | 확인 |
| 커스텀 스킴 | `registerSchemesAsPrivileged` 4회, `protocol.handle` 2회, 오류 페이지 `app://error` | G | 확인 |
| 자동 업데이트 | Electron `autoUpdater`(32회), `setFeedURL`, `checkForUpdates`, `update-downloaded`, `quitAndInstall`. 업데이트 판단 엔드포인트 `desktop/update/v2/should-i-update`(플랫폼 파라미터). Mac App Store / Microsoft Store 빌드는 스토어 업데이트 페이지로 분기 | G | 확인 |
| 다중 워크스페이스 | 액션 `ADD_NEW_TEAMS`, `REMOVE_TEAMS`, `REFRESH_TEAMS`, `SELECT_TEAM`, `SELECT_TEAM_BY_INDEX`, `SELECT_NEXT_TEAM`/`PREVIOUS`, `SIGN_OUT_TEAM`, `SYNC_WORKSPACES`, `STORE_USER_WORKSPACES`, `WORKSPACE_SELECTION`. 세션 파티션 `persist:` 사용 13회 | G | 확인(이름), 추정(워크스페이스 전환은 웹앱 내부, 셸은 목록/선택만 보관) |
| 트레이 | `new Tray` 1곳, `SHOW_TRAY_BALLOON`(Windows 풍선 알림) | G | 확인 |
| 기타 | `safeStorage`(40회, 자격 저장 암호화), `crashReporter` + Sentry, 로그인 시 자동 실행 `setLoginItemSettings`, 맞춤법 사전 `spellcheck.slack-edge.com`, 네트워크 로그 창 | G | 확인 |

## 5. 우리 클론에 쓸 설계 시사점

`docs/research/slack-architecture.md`(planner-2 공개 문서 조사)의 항목을 이번 분석으로 대조했다.

| 기존 문서 항목 | 이번 결과 | 판정 |
|---|---|---|
| "데스크톱 앱은 사실상 웹 클라이언트를 감싼 셸" | 셸 번들에 메시지 UI 없음, 웹앱은 원격 로드 | **확인** |
| "2017년 webview -> BrowserView 전환" | 현재 4.53 번들에 `BrowserView`/`WebContentsView` 문자열 없음, `webviewTag` 설정 1회 | **반박(현행 기준)**: 지금은 BrowserView 기반이 아님. 단일 BrowserWindow가 웹앱을 직접 로드하는 쪽으로 보임(추정) |
| "Redux로 워크스페이스마다 독립 store" | 셸에도 Redux 스토어가 있고 웹앱 상태를 받아옴 | 부분 확인(셸 쪽), 웹앱 내부는 미확인 |
| "부트 시 Webapp에서 토큰과 WebSocket URL을 받고 연결" | `client.getWebSocketURL` 메서드 존재, 호스트 `wss-primary.slack.com` | **확인**(이름 수준) |
| "rtm.start 대신 lazy loading + Flannel" | 부트에 `client.init`/`client.counts`/`client.channels`, 사용자/채널 정보는 `edgeapi.slack.com/cache/...` | **확인** |
| "쓰기는 HTTP, 읽기 갱신은 WebSocket" | `chat.postMessage`/`chat.update`/`chat.delete`가 HTTP API로 존재 | 확인(이름), 전송 경로 실측은 CRUD 미실시로 미확인 |
| "수정/삭제는 message의 subtype" | `message_changed`, `message_deleted`, `message_replied` 이름이 웹앱에 존재 | 이름 확인, subtype 여부는 미확인 |
| "재연결 시 history 재조회" | `reconnect`/`backoff`/`online`/`offline`/`visibilitychange` 다수, 셸은 절전/복귀 감지 | 추정 강화 |

slawk 대비 (app/backend 소켓 이벤트 이름만 확인):
- slawk는 소켓으로 쓰기를 받는다(`message:send`, `message:edit`, `message:delete` 수신). Slack은 쓰기를 HTTP API로 하고 소켓은 push 전용이다. -> **바꿀 것**: REST로 저장, 커밋 후 room에 emit. 소켓 쓰기 핸들러는 제거하거나 REST 호출로 위임.
- slawk 이벤트명은 `message:new`/`message:updated`/`message:deleted`, `typing:start`, `presence:update`. Slack은 `message`(+ `message_changed`/`message_deleted`), `user_typing`, `presence_change`, `reaction_added`/`reaction_removed`. -> 이름 매핑 표를 스펙에 두고 클라이언트 이벤트 계층을 하나로 통일 권장.
- Slack은 부트를 `client.init`(설정/기능 플래그) + `client.counts`(안 읽은 수) + `client.channels`(채널 목록) + `conversations.history`(현재 채널)로 쪼갠다. 사용자 정보는 필요할 때만. -> slawk 초기 로딩도 "카운트 / 채널 목록 / 현재 채널 메시지 / 필요 시 사용자" 4단으로 나누는 스펙 권장.
- 연결 관리: `hello`(연결 확인), `ping`/`pong`(생존 확인), `goodbye`/`reconnect_url`(서버 주도 재연결)을 Socket.io의 기본 heartbeat + 재연결 후 `마지막 ts 이후` 재조회로 대응.
- 데스크톱 셸은 마지막 단계. 만들 경우 필요한 셸 기능은 알림(답장 포함), 배지, `slack://` 딥링크 대응 커스텀 스킴, 단일 인스턴스, 절전 복귀 시 재연결 신호, 자동 업데이트 정도로 범위가 명확하다.

## 6. 하지 않은 것과 미확인
- CRUD 실습은 하지 않았다. 메시지 전송은 사용자 본인의 채팅 승인이 필요한 동작이라, 총괄 지시만으로는 진행하지 않았다. 따라서 이벤트 페이로드 구조, subtype 여부, 쓰기 경로(HTTP vs 소켓)의 실측은 미확인이다.
- WebSocket 프레임은 Worker 안이라 확장 프로그램에서 관찰하지 못했다. 프레임 관찰이 필요하면 DevTools에서 사람이 직접 보거나, 사용자가 승인한 CRUD 실습과 함께 해야 한다.
- 웹앱 원본 JS는 저장하지 않았다(페이지 안에서 이름/개수만 집계).
