# 00b. 실제 Slack ↔ 현재 main 갭 분석 v2

작성: planner-1 / 기준: main 514b1eb(01 멘션·활동, 02 그룹 DM, 03 채널 메타·별표, i18n, 내장 STUN, 채널 이름 유니코드 머지 후)

## 1. 관찰 방법과 한계 (중요)
- **브라우저 관찰 실패.** 이번 세션에는 Claude in Chrome 도구(`mcp__claude-in-chrome__*`)가 노출되지 않았다(도구 검색 3회, 결과 없음). 사용 가능한 브라우저 도구는 REA의 `capture_browser_scenario`(새 프로필로 띄우는 CDP 시나리오)뿐인데, 사용자의 로그인된 Slack 세션이 없고 인증 정보를 기록하면 안 되므로 쓰지 않았다. 따라서 **이번 루프에서는 `#claude-test`에 아무것도 쓰지 않았다.** 지울 것도 없다.
- 대체 근거(표의 "근거" 열에 표시): [R1] `docs/research/slack-crud-observations.md`(이전 루프 CRUD 실습, 메시지·스레드·리액션·상태·DND 관찰 확인), [R2] `docs/specs/00-gap-analysis.md`(첫 화면 관찰 + 문서), [R3] `docs/research/slack-architecture.md`·`rea-slack-desktop.md`, [D] 공식 API 문서·Slack 도움말 수준의 공개 지식(추정 포함).
- 이번에 새 관찰이 필요했던 항목(핀, 북마크, 저장, 링크 복사, 리마인더, 예약 전송, 검색 필터, 단축키, 안 읽음 구분선, 입력 중 표시, 파일 첨부, 멘션 자동완성, 서식)은 [R1]의 호버 메뉴 목록 외에는 **미관찰**이며 [D] 추정이다. 후속 루프에서 브라우저 도구가 되면 `docs/specs/` 각 파일의 "검증 필요" 항목부터 확인할 것.
- 우리 앱은 코드만 읽었다(앱 미실행). 판정은 같음 / 다름 / 없음.

## 2. 차이 표
크기: S(1h 이하) / M(1~2h) / L(2h 초과). 우선순위: P0 핵심 사용 흐름, P1 자주 쓰는 편의, P2 후순위. "스펙" 열은 이미 있거나 이번에 쓴 문서.

| # | 항목 | Slack 동작 | 우리 상태 | 근거 파일 | 근거 자료 | 우선 | 크기 | 스펙 |
|---|---|---|---|---|---|---|---|---|
| 1 | 메시지 서식 | 굵게/기울임/취소선/링크/목록/인용/코드/코드블록 | 같음(Quill 툴바) | hooks/useQuillEditor.ts, Messages/EditorToolbar.tsx | R2 | - | - | - |
| 2 | 편집됨 표시 | 본문 옆 "(편집됨)", `chat.update` | 같음(editedAt 컬럼, 라벨). 시각 툴팁은 미확인 | prisma Message.editedAt, Messages/Message.tsx | R1 | - | - | - |
| 3 | 삭제 확인 | 미리보기 포함 확인창, 부모 삭제 시 자리표시자 | 같음(확인창). 답글 남은 부모 자리표시자는 다름(없음 추정) | Messages/DeleteConfirmDialog.tsx, routes/threads.ts | R1 | P1 | S | 04에 포함 |
| 4 | 스레드 답글 | 우측 패널, "N개의 댓글" | 같음 | Messages/ThreadPanel.tsx | R1 | - | - | - |
| 5 | 채널에도 보내기 | 체크박스, 사후 토글, "스레드에 댓글 남김" 머리글 | 없음(alsoSend 필드 없음) | routes/threads.ts | R1 | P0 | M | 04 |
| 6 | 스레드 모아보기 | 사이드바 "스레드", 카드, 인라인 답글 | 없음 | - | R1 | P0 | L | 04 |
| 7 | 리액션 | 호버 빠른 리액션 3개 + 추가, 칩과 개수, 재클릭 제거 | 다름: 추가·제거·칩은 같음, "빠른 리액션 3개"와 최근 사용 없음 | Messages/MessageReactions.tsx, MessageToolbar.tsx | R1 | P2 | S | 11 후보 |
| 8 | 이모지 | 피커 + `:` 자동완성, 피부색, 커스텀 이모지 | 다름: 피커·`:` 자동완성 같음(emoji-mart 번들). 피부색 선택·커스텀 이모지 없음 | EmojiAutocomplete.tsx, ui/emoji-picker.tsx | R2,D | P2 | M | 후보 |
| 9 | 멘션 자동완성·알림 | `@` 목록, @here/@channel, 활동 탭 | 같음(01 머지). 사용자 그룹 @팀 없음 | MentionDropdown.tsx, services/mentionService.ts | R2 | - | - | 01 |
| 10 | 파일 첨부·미리보기 | + 버튼, 드래그&드롭, 붙여넣기, 이미지 미리보기/라이트박스 | 다름: + 버튼, 미리보기, 라이트박스는 같음. 드래그&드롭·붙여넣기 업로드는 코드에서 못 찾음(검증 필요) | MessageInput.tsx, FilePreview*.tsx | R2,D | P1 | S | 12 후보 |
| 11 | 핀 | 더 보기 "채널에 고정(P)", 핀 목록 | 같음(키 P 단축키는 없음) | routes/threads.ts /pin, PinsPanel.tsx | R1 | - | - | 06에 단축키 |
| 12 | 북마크/저장 | 호버 "저장", 사이드바 "나중에" | 같음(Bookmark, LaterPage). 채널 북마크 바(링크 모음)는 없음 | routes/bookmarks.ts | R1,R2 | P2 | M | 후보 |
| 13 | 메시지 링크 복사 | 더 보기 "링크 복사(L)", 링크로 열면 해당 메시지로 스크롤·강조 | 없음(라우트는 c/:channelId뿐, 메시지 ID 라우팅 없음) | App.tsx(646~652) | R1 | P0 | M | 07 |
| 14 | 읽지 않음으로 표시(U) | 더 보기 메뉴 | 같음(actionsMenu.markUnread) | MessageActionsMenu.tsx | R1 | - | - | - |
| 15 | 안 읽음 구분선 | 채널 열면 "새 메시지" 줄과 첫 안 읽음 위치로 스크롤 | 없음(배지·UnreadsPage만, 구분선 코드 없음) | MessageList.tsx | D | P0 | M | 10 |
| 16 | 리마인더 | 메시지 더 보기 "리마인더 추가"(하위 시간 메뉴), `/remind`, 시각에 알림 | 없음 | - | R1 | P1 | M | 09 |
| 17 | 예약 전송 | 컴포저 전송 옆 메뉴, 목록 | 다름: 채널만. DM·그룹 DM·스레드 예약 없음 | routes/scheduled-messages.ts(channelId만) | D | P2 | M | 후보 |
| 18 | 채널 주제·설명 | 헤더, "설명 편집" | 같음(03 머지) | ChannelDetailsModal.tsx | R2 | - | - | 03 |
| 19 | 별표 | 즐겨찾기 섹션 | 같음(03, DMStar, SidebarPref) | prisma ChannelStar | R2 | - | - | 03 |
| 20 | 검색 필터 | `from:` `in:` `before:` `after:` `has:` , 탭(메시지/파일/사람/채널), 하이라이트, 전용 페이지 | 다름: LIKE 포함 검색, 채널 필터 1개. 연산자·탭·하이라이트 없음, 최소 2자 | routes/search.ts | R2,D | P0 | M | 08 |
| 21 | 상태 | 이모지+텍스트+만료, `users.profile.set` | 없음(05 대기) | - | R1 | P0 | M | 05 |
| 22 | 방해금지 | 일시중지 30분~다음 주, 켜기/끄기/조회 | 없음(05 대기) | - | R1 | P0 | M | 05 |
| 23 | 단축키 | Cmd/Ctrl+K 빠른 전환, E 편집, L 링크 복사, P 핀, U 안 읽음, Esc 닫기 | 없음(Esc/Enter만, 전역 단축키 핸들러 없음) | grep metaKey 0건 | R1,D | P0 | S~M | 06 |
| 24 | 빠른 전환기 | 대화 찾기: 채널·DM·사람 퍼지 검색, 최근 항목 | 없음 | - | R2 | P0 | M | 06 |
| 25 | 입력 중 표시 | "OOO님이 입력 중…" | 같음(typing:start/stop, 그룹 DM 포함) | websocket/index.ts | D | - | - | - |
| 26 | 그룹 DM | 멀티파티 DM | 같음(02 머지, DMGroup) | routes/dmGroups.ts | R2 | - | - | 02 |
| 27 | 채널 이름 규칙 | 소문자/숫자/하이픈/밑줄, 유니코드 가능 | 같음(PR #14 머지) | lib/channelName.ts | D | - | - | - |
| 28 | 링크 미리보기 | URL 카드 | 없음 | - | D | P1 | L | 후보(opus) |
| 29 | 알림 환경설정 | 채널별 뮤트, 키워드, 알림 수준 | 부족: 푸시 구독만 | routes/push.ts | D | P1 | L | 후보(08-notif-prefs) |
| 30 | 다중 워크스페이스, SSO, 캔버스 | - | 없음 | - | R2 | P2 | L+ | 00 파트 18~20 |

## 3. 우선순위 상위 10
1. 04 스레드 모아보기 + 채널에도 보내기 (P0, L, 기존 스펙)
2. 05 사용자 상태·DND (P0, M, 기존 스펙)
3. 06 빠른 전환기(Cmd/Ctrl+K)와 전역 단축키 (P0, M) 신규 스펙
4. 07 메시지 퍼말링크·링크 복사·딥링크 이동 (P0, M) 신규 스펙
5. 08 검색 v2(연산자 필터, 탭, 하이라이트) (P0, M) 신규 스펙
6. 10 안 읽음 구분선과 첫 안 읽음 위치로 이동 (P0, M) 신규 스펙
7. 09 리마인더(메시지 더 보기 + /remind) (P1, M) 신규 스펙
8. 링크 미리보기(unfurl) (P1, L, opus, SSRF 방어 필요, 스펙 후보)
9. 알림 환경설정(채널 뮤트·키워드) (P1, L)
10. 파일 드래그&드롭·붙여넣기 업로드 확인과 보완 (P1, S)

선정 이유: 사용자가 "진짜 Slack과 비교해 만들어 달라"고 했고, 단축키·링크·검색·안 읽음 구분선은 매일 쓰는 동작인데 현재 전부 없다. 앞의 네 개 신규 스펙은 스키마 변경이 거의 없어(09만 스키마 추가) 05·04와 병렬로 돌리기 쉽다.

## 4. 신규 스펙 파일 번호
첫 분석(00)의 파트 번호(06 search-v2, 07 quick-switcher, 09 links, 10 reminders)와 이번 번호가 다르다. 보드에는 아래 이번 번호를 쓴다.
`06-quick-switcher-shortcuts.md`, `07-message-permalink.md`, `08-search-v2.md`, `09-reminders.md`, `10-unread-divider.md`

## 5. 파일 충돌 지도
- 06: AppLayout.tsx(전역 키 훅), Sidebar 데이터 읽기만. 신규 파일 위주.
- 07: App.tsx 라우트, MessageActionsMenu.tsx, MessageList.tsx(스크롤 이동). 10과 MessageList.tsx 충돌 가능, **07과 10은 순차** 권장.
- 08: routes/search.ts, HeaderSearch.tsx, 신규 SearchPage. 독립.
- 09: schema.prisma(Reminder), scheduler.ts, MessageActionsMenu.tsx(07과 충돌 가능).
- 10: MessageList.tsx, routes/channels.ts(/read 응답). 07과 순차.
- 04·05는 schema.prisma 직렬 규칙 유지. 09는 05 이후.
