# 00. Slack ↔ slawk 갭 분석과 파트 분할

작성: planner-1 (루프 1) / 기준: app/ = ncvgl/slawk 커밋 5f30358

## 0. 분석 방법과 한계
- slawk: 코드만 읽음(실행 안 함). 근거 파일은 `app/backend/...`, `app/frontend/src/...` 기준.
- Slack 워크스페이스: Claude in Chrome으로 로그인된 상태의 화면을 **보기만** 했다(성공). 클릭/입력 없이 첫 화면만 관찰했으므로 "관찰 확인" 표시는 화면에 보이는 항목에 한정된다. 나머지는 공식 문서와 SDK 지식 기반이며 "문서 기반"이라 표시한다.
- 관찰한 워크스페이스는 채널이 하나뿐인 신규 워크스페이스이며 한국어 UI다. 실제 메시지·인물 정보는 기록하지 않았다.
- 데스크톱 앱(REA) 분석은 다음 루프 범위. 따라서 클라이언트 내부 API 이름(예: conversations.history, WebSocket RTM/Socket 이벤트 세부)은 공식 문서 수준이며 REA로 검증 필요.

### 관찰로 확인한 Slack 화면 구조 (관찰 확인)
- 좌측 레일: 워크스페이스 스위처(상단), 홈, DM, 내 활동, 파일, 에이전트 및 도구, 관리자, 하단에 새 워크스페이스 추가(+), 방해금지(달 아이콘) 토글, 내 아바타(프레즌스 점).
- 사이드바(홈): 대화 찾기(빠른 전환기), 스레드, 허들, 디렉터리, 즐겨찾기(별표 영역, 드래그 안내문), 채널 섹션(접기 가능), 다이렉트 메시지 섹션, 앱 섹션, 상단에 워크스페이스 이름 드롭다운과 새 메시지 작성 버튼.
- 최상단: 뒤로/앞으로/기록 버튼 + 워크스페이스 전체 검색창.
- 채널 헤더: 별표(즐겨찾기), 채널명, 탭(메시지 / 캔버스 / + 추가), 우측에 멤버 수/허들/기타 컨트롤.
- 채널 빈 상태: 채널 소개문, "설명 편집", "채널에 사람 추가" 버튼.
- 컴포저: 서식 툴바(굵게/기울임/밑줄/취소선/링크/순서·글머리 목록/인용/코드/코드블록), 첨부(+), 서식 토글(Aa), 이모지, 멘션(@), 영상/음성 클립, 슬래시 명령(/) 버튼, 전송 버튼.

## 1. slawk 구현 기능 목록 (근거 파일)
백엔드 API는 `app/backend/src/routes/`, WebSocket은 `app/backend/src/websocket/`, 스키마는 `app/backend/prisma/schema.prisma`.

| # | 기능 | 근거 |
|---|---|---|
| I1 | 가입/로그인/JWT/비밀번호 변경/세션 무효화(tokenVersion) | routes/auth.ts, middleware/auth.ts, components/Auth/* |
| I2 | 초대 링크(코드, 만료, 사용 횟수, 역할) | routes/admin.ts(/invites), routes/auth.ts(/invite/:code), Admin/AdminInvitesTab.tsx |
| I3 | 역할 OWNER/ADMIN/MEMBER/GUEST, 채널 역할 OWNER/MODERATOR/MEMBER, 소유권 이전 | schema.prisma, middleware/authorize.ts, admin.ts(/transfer-ownership) |
| I4 | 공개/비공개 채널 생성·조회·참여·탈퇴·멤버 추가/제거/역할 변경 | routes/channels.ts, Sidebar/AddChannelDialog.tsx, Messages/MembersPanel.tsx |
| I5 | 채널 둘러보기(공개 채널 목록) | Sidebar/Sidebar.tsx(handleBrowseChannels) |
| I6 | 채널 아카이브/복원/삭제(관리자) | routes/admin.ts, Admin/AdminChannelsTab.tsx |
| I7 | 채널 메시지 전송/조회(페이지네이션), 실시간 수신 | routes/messages.ts, websocket/index.ts(message:send/new), utils/pagination.ts |
| I8 | 메시지 편집/삭제(소프트 삭제) | routes/threads.ts(PATCH/DELETE), websocket message:edit/delete, hooks/useMessageEdit.ts, DeleteConfirmDialog.tsx |
| I9 | 스레드 답글/스레드 패널 | routes/threads.ts, Messages/ThreadPanel.tsx, ThreadIndicator.tsx |
| I10 | 이모지 리액션(채널/DM) | routes/reactions.ts, dms.ts, Messages/MessageReactions.tsx, ui/emoji-picker.tsx |
| I11 | 1:1 DM(전송/조회/편집/삭제/스레드/리액션/핀/읽음) | routes/dms.ts, websocket dm:*, Messages/DMConversation.tsx |
| I12 | 파일 업로드/다운로드 토큰/미리보기/삭제, 채널 파일 목록, 파일 페이지 | routes/files.ts, channels.ts(/:id/files), Messages/FilePreview*.tsx, FilesPanel.tsx, FilesPage.tsx, ImageLightbox.tsx |
| I13 | 메시지 핀(채널/DM)과 핀 패널 | threads.ts(/pin), dms.ts, channels.ts(/:id/pins), Messages/PinsPanel.tsx |
| I14 | 북마크("나중에 저장") | routes/bookmarks.ts, Messages/LaterPage.tsx, stores/useBookmarkStore.ts |
| I15 | 프레즌스(온라인/오프라인 브로드캐스트), 상태값 online/away/busy/offline | websocket presence:update, routes/users.ts(PUT /me/status, GET /:id/presence), tests/presence.test.ts |
| I16 | 타이핑 표시(채널/DM) | websocket typing:start/stop, dm:typing:* |
| I17 | 읽음 위치/안 읽음 배지/안 읽음 페이지/수동 안 읽음 처리 | schema ChannelRead, channels.ts(/read,/unread,/read/baseline), routes/unreads.ts, Messages/UnreadsPage.tsx, Sidebar/UnreadBadge.tsx |
| I18 | 예약 전송 | routes/scheduled-messages.ts, scheduler.ts, Messages/Schedule*.tsx |
| I19 | 수신 웹훅(생성/삭제/POST) + 관리 UI | routes/webhooks.ts, Admin/AdminWebhooksTab.tsx |
| I20 | 웹 푸시 + 브라우저 알림 권한 | routes/push.ts, services/pushService.ts, stores/useNotificationStore.ts, Messages/HeaderNotifications.tsx |
| I21 | 허들: 1:1 초대/수락/거절/WebRTC 시그널링/음소거 | websocket/huddles.ts, components/Huddle/*, stores/useHuddleStore.ts |
| I22 | 관리자 패널(멤버/채널/초대/웹훅/감사 로그), 계정 비활성화 | routes/admin.ts, Admin/*, utils/auditLog.ts |
| I23 | 프로필(이름/소개/아바타 업로드·크롭), 사용자 프로필 조회 | routes/users.ts, ProfileModal.tsx, AvatarCropModal.tsx |
| I24 | 리치 텍스트 입력(Quill), 서식 툴바, 링크 모달, 이모지 자동완성, 음성 녹음 | hooks/useQuillEditor.ts, Messages/MessageInput.tsx, EditorToolbar.tsx, FormatToolbar.tsx, LinkModal.tsx, EmojiAutocomplete.tsx, hooks/useVoiceRecorder.ts |
| I25 | 멘션 입력 UI(@사용자, @here)와 렌더링 `<@id\|name>`, `<@here>` | Messages/MentionDropdown.tsx, lib/serializeDelta.ts, lib/renderMessageContent.tsx |
| I26 | 기본 검색(메시지/DM, 채널 필터) + 헤더 검색/모바일 검색 | routes/search.ts, Messages/HeaderSearch.tsx, MobileSearchOverlay.tsx |
| I27 | 모바일 반응형, 연결 상태 표시 | stores/useMobileStore.ts, useConnectionStore.ts |
| I28 | 보안/레이트리밋/DB 무결성 테스트(jest 22개 파일) | backend/src/tests/*, app.ts(helmet, limiter) |

참고: `app/my_prompts/`는 slawk 작성자의 에이전트 프롬프트(개발/QA/리뷰)와 과거 버그 로그로, 기능 스펙은 아님. `deprecated/` 내 버그 로그는 인증/권한 회귀 지점 참고용.

## 2. 기능별 분류표 (구현됨 / 부족함 / 없음)
"관찰"은 Slack 워크스페이스 화면에서 확인, "문서"는 공식 문서 기반.

| # | Slack 기능 | 확인 | 분류 | 메모 |
|---|---|---|---|---|
| 1 | 가입/로그인/세션 | 문서 | 구현됨 | I1. 2FA/SSO/매직링크 없음은 항목 33 |
| 2 | 공개·비공개 채널 | 관찰 | 구현됨 | I4 |
| 3 | 채널 둘러보기 | 관찰(디렉터리) | 부족함 | I5는 단순 목록. 디렉터리(사람/채널/그룹 탭, 필터) 없음 |
| 4 | 채널 메시지 송수신 | 관찰 | 구현됨 | I7 |
| 5 | 1:1 DM | 관찰 | 구현됨 | I11 |
| 6 | 그룹 DM(멀티파티) | 문서 | 없음 | DirectMessage가 from/to 한 쌍 구조 |
| 7 | 스레드 답글 | 문서 | 구현됨 | I9 |
| 8 | 스레드 모아보기(사이드바 "스레드") | 관찰 | 없음 | 내가 참여한 스레드 목록·읽음 상태 |
| 9 | 스레드 답글을 채널에도 보내기 | 문서 | 없음 | |
| 10 | 리액션 | 문서 | 구현됨 | I10. 커스텀 이모지, 피부색 없음(항목 36) |
| 11 | 멘션 입력/렌더링 | 관찰(@ 버튼) | 구현됨 | I25 |
| 12 | 멘션 알림·추적(@사용자 알림, @channel, 멘션 카운트) | 문서 | 부족함 | 서버가 멘션을 해석하지 않음. @channel/@everyone 없음 |
| 13 | 내 활동(Activity) 피드 | 관찰 | 없음 | 멘션·스레드 답글·리액션 모음 |
| 14 | 파일 업로드/공유/미리보기 | 관찰(+ 버튼) | 구현됨 | I12. 파일 검색, 스니펫 없음 |
| 15 | 검색 | 관찰(검색창) | 부족함 | I26은 단순 LIKE. from:/in:/날짜/파일/사람 필터, 하이라이트, 검색 전용 페이지 없음 |
| 16 | 프레즌스 | 관찰(점) | 구현됨 | I15 |
| 17 | 커스텀 상태(텍스트·이모지·만료) | 문서 | 없음 | status가 enum 문자열뿐 |
| 18 | 방해금지/알림 일시중지 | 관찰(달 아이콘) | 없음 | |
| 19 | 편집/삭제 | 문서 | 구현됨 | I8 |
| 20 | 핀 | 문서 | 구현됨 | I13 |
| 21 | 북마크/나중에 저장 | 문서 | 구현됨 | I14. 채널 북마크 바(링크 모음)는 항목 28 |
| 22 | 사용자 프로필 | 문서 | 부족함 | I23. 표시 이름, 직함, 시간대, 전화, 현지 시각 없음 |
| 23 | 초대/권한 | 문서 | 구현됨 | I2, I3. 이메일 초대 발송 없음 |
| 24 | 안 읽음/읽음 상태 | 관찰 | 구현됨 | I17 |
| 25 | 타이핑 표시 | 문서 | 구현됨 | I16 |
| 26 | 허들(1:1 음성) | 관찰(허들 메뉴) | 부족함 | I21. 채널 허들, 다자 통화, 화면 공유 없음 |
| 27 | 예약 전송 | 문서 | 구현됨 | I18 |
| 28 | 채널 북마크 바/탭(캔버스 포함) | 관찰(탭: 메시지/캔버스) | 없음 | 채널 헤더 탭 구조 자체가 없음. 캔버스는 P2 |
| 29 | 채널 토픽/설명/이름 변경 | 관찰("설명 편집") | 없음 | Channel에 description/topic 컬럼 없음, 이름 변경 API 없음(관리자 PATCH만) |
| 30 | 즐겨찾기(별표)/사이드바 섹션 | 관찰 | 없음 | |
| 31 | 빠른 전환기(Cmd+K, 대화 찾기) | 관찰 | 없음 | |
| 32 | 알림 설정(채널별 뮤트, 키워드, 모바일/이메일) | 문서 | 부족함 | I20은 푸시 구독뿐. 채널별 설정 모델 없음 |
| 33 | 2FA/SSO(SAML·OAuth) | 문서 | 없음 | |
| 34 | 다중 워크스페이스 | 관찰(스위처/+) | 없음 | Workspace 모델 자체가 없음(단일 테넌트) |
| 35 | 앱/봇/Slash 명령/Events API/OAuth | 관찰(앱·/ 버튼) | 부족함 | I19 수신 웹훅만 있음 |
| 36 | 커스텀 이모지 | 문서 | 없음 | |
| 37 | 리마인더(/remind, 메시지 리마인드) | 문서 | 없음 | |
| 38 | 사용자 그룹(@팀) | 문서 | 없음 | |
| 39 | 메시지 링크 복사(퍼말링크)/메시지 공유 | 문서 | 없음 | 개별 메시지 딥링크 라우팅 없음 |
| 40 | 링크 미리보기(unfurl) | 문서 | 없음 | |
| 41 | 임시 저장(드래프트) | 관찰(사이드바 구조에서 추정) | 없음 | |
| 42 | 관리자 패널/감사 로그 | 관찰(관리자) | 구현됨 | I22 |
| 43 | 서식 있는 컴포저 | 관찰 | 구현됨 | I24 |
| 44 | 영상/음성 클립 | 관찰 | 부족함 | 음성 녹음(I24)만, 영상 없음 |
| 45 | 캔버스/리스트 | 관찰(탭) | 없음 | P2 |
| 46 | 워크플로/이메일 알림/데이터 내보내기 | 문서 | 없음 | P2 후순위 |
| 47 | 키보드 단축키/접근성 | 문서 | 부족함 | 일부 Enter/Esc만 |
| 48 | 모바일 레이아웃 | 문서 | 구현됨 | I27 |

### 요약 개수 (총 48)
**구현됨 19 (1,2,4,5,7,10,11,14,16,19,20,21,23,24,25,27,42,43,48) / 부족함 9 (3,12,15,22,26,32,35,44,47) / 없음 20 (6,8,9,13,17,18,28,29,30,31,33,34,36,37,38,39,40,41,45,46)**

## 3. 파트 분할 (개발자 1명 / 한 루프 1~2시간 기준)
충돌 열의 "S"는 schema.prisma 마이그레이션, 숫자는 같은 파일을 건드리는 파트. **schema.prisma를 바꾸는 파트는 동시에 배정하지 말고 순차 병합**(Prisma 마이그레이션 충돌 방지). 자원 규칙상 감속 단계에서는 어차피 1개씩 진행.

| 파트 | 이름 | 우선순위 | 모델 | 시간 | 충돌 |
|---|---|---|---|---|---|
| 01 | mentions-activity: 서버 멘션 해석/저장, @channel, 멘션 알림 푸시, 내 활동 탭 | P0 | sonnet | 2h | S, messages.ts, threads.ts, websocket/index.ts, Sidebar, AppLayout |
| 02 | group-dm: 멀티파티 DM(최대 9명) | P0 | opus | 2h | S, dms.ts, websocket dm:*, Sidebar, DMConversation |
| 03 | channel-meta-star: 채널 토픽/설명, 이름 변경, 즐겨찾기 별표와 사이드바 섹션 | P0 | sonnet | 1.5h | S, channels.ts, Sidebar |
| 04 | threads-view: "스레드" 모아보기 + 스레드 읽음 + 채널에도 보내기 | P0 | sonnet | 2h | threads.ts, S(소규모), Sidebar |
| 05 | user-status-dnd: 커스텀 상태(텍스트·이모지·만료), 방해금지/알림 일시중지, 푸시 억제 | P0 | sonnet | 1.5h | S, users.ts, pushService.ts, ProfileModal, 01 |
| 06 | search-v2: 필터(from:/in:/before:), 파일/사람/채널 탭, 하이라이트, 검색 페이지 | P1 | sonnet | 2h | search.ts, HeaderSearch(독립적) |
| 07 | quick-switcher: Cmd+K 대화 찾기 + 키보드 단축키 모음 | P1 | haiku | 1h | AppLayout, Sidebar |
| 08 | notification-prefs: 채널별 뮤트·알림 수준, 키워드, 설정 UI | P1 | sonnet | 2h | S, pushService.ts, 01, 05 |
| 09 | message-links-share: 퍼말링크/딥링크 라우팅, 링크 복사, 메시지 공유 | P1 | sonnet | 1.5h | App.tsx 라우팅, MessageActionsMenu |
| 10 | reminders: 메시지 리마인드 + /remind 기본 | P1 | sonnet | 1.5h | S, scheduler.ts |
| 11 | profile-fields-directory: 직함·표시 이름·시간대, 디렉터리(사람/채널 탭) | P1 | sonnet | 2h | S, users.ts, Sidebar |
| 12 | huddle-channel-multi: 채널 허들, 3인 이상 메시 WebRTC | P1 | opus | 2h+ (분할 가능) | huddles.ts, useHuddleStore |
| 13 | link-unfurl: URL 미리보기(서버 fetch, SSRF 방어) | P1 | opus | 1.5h | messages.ts, Message.tsx |
| 14 | custom-emoji-usergroups: 커스텀 이모지, 사용자 그룹 @팀 | P2 | sonnet | 2h | S, 01 |
| 15 | slash-commands-bot-api: 슬래시 명령, 봇 토큰, Events 웹훅 | P2 | opus | 2h+ | S, webhooks.ts |
| 16 | channel-tabs-canvas: 채널 탭 구조 + 북마크 바 + 간이 캔버스 | P2 | opus | 2h+ | S, MessageArea |
| 17 | drafts: 임시 저장 | P2 | haiku | 1h | S(소) , MessageInput |
| 18 | workspace-multitenancy: Workspace 모델/라우팅/스위처 | P2 | opus | 분할 필수(3루프 이상) | 전체 S, 전 라우트 |
| 19 | auth-2fa-sso: TOTP 2FA, OAuth 로그인 | P2 | opus | 2h | auth.ts, S |
| 20 | export-email-notify: 이메일 초대·알림, 데이터 내보내기 | P2 | sonnet | 2h | admin.ts |

권장 병렬(정상 단계에서 3동시): 서로 S를 안 건드리는 조합 → (06 검색) + (07 단축키) + (09 링크) 같은 비스키마 파트를 스키마 파트 1개와 함께 배정. P0는 01 → 03 → 02 순서로 스키마 병합을 직렬화할 것을 권장(02가 가장 위험하므로 스키마가 안정된 뒤 opus에게).

## 4. 이번 루프에서 상세 스펙을 쓴 P0 상위 3개
- `docs/specs/01-mentions-activity.md`
- `docs/specs/02-group-dm.md`
- `docs/specs/03-channel-meta-star.md`
나머지(04, 05 ...)는 다음 루프에서 작성. 04, 05도 P0이며 스펙 대기 중.
