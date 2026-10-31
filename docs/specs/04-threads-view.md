# 04. "스레드" 모아보기, 스레드 읽음 상태, 채널에도 보내기

우선순위 P0 / 추천 모델 sonnet / 예상 2h / 스키마 변경 있음(ThreadRead 추가, 01·05와 schema.prisma 직렬)

## 1. 기능 설명
관찰(Claude in Chrome): 사이드바 상단에 "스레드" 항목이 있고(채널 목록 위, 허들/디렉터리와 같은 묶음), 클릭하면 주소가 채널 없는 `/client/<워크스페이스>`로 바뀌고 제목이 "스레드"가 된다. 참여한 스레드가 없으면 빈 화면 안내("스레드 관리하기", 설명 문구)가 나온다. (#claude-test 실습 확인) 스레드는 카드 하나씩이고, 카드 헤더에 채널 이름, 카드 안에 부모 메시지와 답글이 인라인으로 모두 보이며, 맨 아래에 "채널로도 전송" 체크박스가 있는 인라인 답글 입력창이 있다(패널을 열지 않고 바로 답글). 카드 안에서도 수정/삭제/리액션 툴바가 동작한다. 부모가 삭제돼도 답글이 남아 있으면 카드는 유지(부모 자리에 "이 메시지는 삭제되었습니다."), 살아 있는 메시지가 없으면 카드가 사라진다. 안 읽음 굵게/점 표시와 읽음 처리는 멤버가 1명뿐이라 미관찰(추정 유지). 상세는 `docs/research/slack-crud-observations.md`.
- Slack 구조: 스레드 패널을 열면 `conversations.replies`와 `subscriptions.thread.mark`가 호출되어 스레드 단위로 읽음이 기록된다(#claude-test 실습 확인). 모아보기는 `subscriptions.thread.getTimestamps`와 `messages.list`로 채운다. 답글 전송은 `chat.postMessage`(스레드 부모 지정, 채널에도 보내기는 브로드캐스트 플래그), 수정 `chat.update`, 삭제 `chat.delete`. WebSocket 이름 `message_replied`, `thread_marked`는 리서치 기준 추정(프레임 미관찰).
- 채널에도 보내기는 생성 시 옵션이자 사후 토글(#claude-test 실습 확인): 일반 답글 메뉴에 "이 채널에 댓글 보내기", 브로드캐스트 답글 메뉴에 "채널에서 댓글 지우기"가 있다. 채널 본문의 브로드캐스트 항목은 "스레드에 댓글 남김: <부모 발췌>" 머리글. 일반 답글은 채널 본문에 나오지 않고 부모 아래 "N개의 댓글" 링크만 늘어난다. 브로드캐스트 답글을 삭제하면 채널 복사본도 함께 사라진다.

기능
1. 스레드 모아보기: 내가 참여한 스레드(부모 작성자 또는 답글 작성자) 목록을 마지막 활동 순으로. 각 항목은 부모 메시지, 답글(실습에서는 전부 인라인 표시, 많을 때 접기 규칙은 미관찰), 채널명, 새 답글 수, 인라인 답글 입력창.
2. 스레드 읽음 상태: 스레드마다 마지막으로 읽은 답글 id를 저장해 안 읽은 답글 수 계산. 스레드 패널을 열면 읽음 처리. 사이드바 "스레드" 항목에 안 읽은 스레드 수 점/숫자.
3. 채널에도 보내기: 답글 입력창의 체크박스. 켜면 답글이 스레드 안에 들어가면서 채널 본문 타임라인에도 "스레드에 답글" 표시와 함께 나타난다. 수정/삭제 시 둘 다 반영.

## 2. 화면 흐름
1. 사용자가 사이드바 "스레드" 클릭 -> `GET /threads` -> 카드 목록. 안 읽은 카드는 굵게.
2. 카드 안에서 바로 답글 입력(실습 확인) 또는 카드 클릭 -> 우측에 기존 ThreadPanel 열림 + `POST /threads/:id/read`로 읽음 -> 배지 감소. 카드 헤더의 채널명 클릭 시 해당 채널로 이동.
3. 다른 사용자가 답글 -> `thread:updated` 수신 -> 목록 맨 위로 이동, 안 읽음 증가. 현재 패널이 열려 있으면 즉시 읽음.
4. 답글 작성 시 "채널에도 보내기" 체크 -> 전송 -> 스레드 패널과 채널 본문 둘 다에 표시(채널 쪽은 "스레드에 답글" 라벨 + 부모 발췌).
5. 답글 수정/삭제는 기존 흐름 유지(삭제는 확인 대화상자 후 흔적 없이 제거, 수정은 "(편집됨)" 라벨, 실습 확인). 부모 삭제 시 답글이 있으면 자리표시자를 남기고 답글 유지(실습 확인). 삭제 시 채널에 복사본(`alsoSendToChannel`)도 함께 사라짐.
6. 모아보기 빈 상태: 안내 문구와 일러스트 없이 텍스트만(Slack 에셋 복사 금지).

## 3. 데이터 모델 (schema.prisma)
이미 있음: `Message.threadId`(self relation `MessageThread`), `_count.replies`, `DirectMessage.threadId`, 답글 수 계산, 채널 `/read`는 답글을 제외하고 센다(unreads-threads 테스트 확인).

추가:
```
model ThreadRead {
  id                Int      @id @default(autoincrement())
  userId            Int
  threadId          Int      // 부모 Message.id
  lastReadReplyId   Int?     // 마지막으로 읽은 답글 id (null이면 답글 아직 안 읽음)
  updatedAt         DateTime @updatedAt
  user    User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  thread  Message @relation("ThreadReadParent", fields: [threadId], references: [id], onDelete: Cascade)
  @@unique([userId, threadId])
  @@index([userId, updatedAt])
}
```
Message에 `alsoSendToChannel Boolean @default(false)` 추가. User, Message에 역방향 관계 필드 추가.
참여 스레드 판단은 별도 구독 테이블 없이 "부모 작성자이거나 해당 스레드에 답글을 쓴 사람"으로 쿼리한다(slawk 현재 푸시 로직과 동일 규칙). 구독 해제(뮤트)는 후속 범위(08).

## 4. API / 이벤트
- 신규 `GET /threads?cursor=&limit=` (routes/threads.ts 상단 또는 새 `routes/thread-list.ts`, app.ts에 `/threads` 등록. 주의: 기존 routes/threads.ts는 `/messages` 아래 마운트되어 경로 충돌이 없는지 확인) -> `{ items:[{ parent, channel, replyCount, unreadCount, lastReply, lastActivityAt }], nextCursor }`. 비공개 채널은 멤버만, 삭제된 부모(`deletedAt`)와 보관 채널 제외 규칙 적용. 정렬 기준 마지막 답글 시각. 커서 기반.
- `GET /threads/unread-count` -> `{ count }`
- `POST /threads/:parentId/read` body `{ lastReadReplyId? }` 생략 시 최신 답글. `requireMessageAccess` 사용.
- 브로드캐스트 사후 토글(실습 확인): `POST /messages/:id/broadcast`, `DELETE /messages/:id/broadcast`.
- `POST /messages/:id/reply` body에 `alsoSendToChannel?: boolean` 추가(zod). true면 `alsoSendToChannel=true`로 저장하고 채널 타임라인 쿼리(`GET /channels/:id/messages`)가 `threadId=null OR alsoSendToChannel=true`를 반환하도록 수정. 응답/이벤트에 `parent` 발췌 포함.
- 답글 전송 서비스 로직을 `services/threadService.ts`로 추출(HTTP 답글 경로와 WebSocket 경로가 같이 호출. websocket/index.ts의 message:send가 threadId를 받는 경로가 있는지 확인 후 통일).
- WebSocket: 기존 `message:new`(threadId 포함)는 유지. 신규 `thread:updated { parentId, lastReplyId, replyCount }`를 참여자 `user:<id>` 룸에, `thread:read { parentId }`를 본인의 다른 탭에. Slack 대응 이름: `message_replied`, `thread_marked`. 이벤트는 `docs/architecture/events.md`에 등록.
- DM 스레드(DirectMessage.threadId)는 이번 범위에서 목록 노출만 제외(후속). 01의 `Activity THREAD_REPLY`와 중복 생성되지 않게 같은 서비스 안에서 한 번에 처리.

## 5. 프런트엔드
이미 있음: ThreadPanel.tsx, ThreadIndicator.tsx(답글 수/참여자), MessageToolbar의 스레드 버튼, useMessageStore의 threadCount/threadParticipants 갱신과 삭제 시 감소, MessageArea의 패널 연결.
없음/추가:
- `components/Messages/ThreadsPage.tsx`(AppLayout의 UnreadsPage/LaterPage와 같은 방식으로 뷰 분기 추가), `stores/useThreadStore.ts`(목록, 안 읽음 수, 소켓 구독).
- Sidebar에 "스레드" 항목(SidebarItem 재사용) + 안 읽음 배지(UnreadBadge).
- ThreadPanel 입력창에 "채널에도 보내기" 체크박스, 채널 타임라인에서 `alsoSendToChannel` 메시지에 "스레드에 답글" 라벨.
- 패널 열 때 `POST /threads/:id/read`.

## 6. 완료 기준 (테스트)
- backend jest(`tests/threads-view.test.ts` 신규, 기존 unreads-threads 유지): ① 참여 스레드만 `GET /threads`에 나옴(부모 작성자, 답글 작성자, 비참여자 제외) ② 비공개 채널 비멤버 제외, 삭제/보관 제외 ③ 안 읽음 수와 `read` 후 0 ④ `alsoSendToChannel` 답글이 채널 메시지 목록에 나오고 일반 답글은 안 나옴 ⑤ 답글 삭제 시 채널 쪽에서도 사라짐, 수정 반영 ⑥ `thread:updated`가 참여자에게만 도착 ⑦ 인증 401, 남의 스레드 read 403/404 ⑧ 커서 페이지네이션.
- CRUD 직접 확인: 부모 올리기 -> 답글 -> 채널에도 보내기 답글 -> 수정 -> 삭제 -> 부모 삭제를 로컬 앱에서 반복.
- 프런트: ThreadsPage 렌더, 배지, 체크박스 동작(vitest 또는 수동). 기존 테스트 전부 통과.

## 7. slawk 관련 파일
backend: prisma/schema.prisma, routes/threads.ts, routes/channels.ts(메시지 목록 쿼리), routes/unreads.ts, websocket/index.ts, app.ts, middleware/authorize.ts, tests/unreads-threads.test.ts, 신규 services/threadService.ts
frontend: Layout/AppLayout.tsx, Sidebar/Sidebar.tsx·SidebarItem.tsx·UnreadBadge.tsx, Messages/ThreadPanel.tsx·ThreadIndicator.tsx·MessageArea.tsx·Message.tsx, stores/useMessageStore.ts, lib/types.ts, lib/api.ts

## 8. 충돌 주의
schema.prisma는 01(Activity), 05(User 필드)와 직렬 처리. routes/threads.ts·websocket/index.ts는 01(THREAD_REPLY 활동)과 겹치므로 01 병합 후 진행 권장. Sidebar는 01, 02, 03과 겹침. 답글 푸시 로직은 05의 `shouldNotify`를 거치게 됨.

## 7. 보완 (00b 갭 분석 v2, planner-1)
브라우저 도구가 없어 새 관찰은 하지 못했다(문서 기반). 기존 관찰과 현재 코드를 대조해 추가한 점.
- 현재 main에는 `alsoSendToChannel`, `ThreadRead`, 부모 삭제 자리표시자가 모두 없다(schema.prisma, routes/threads.ts 확인). 삭제 시 부모 `deletedAt` 자리표시자 + 답글 유지는 이 파트의 완료 기준에 반드시 포함한다(현재 `GET /channels/:id/messages`는 `deletedAt:null`만 반환하므로 답글이 남은 삭제 부모가 타임라인에서 통째로 사라진다).
- 07(퍼말링크)이 스레드 답글 링크를 `/c/:id/m/:parentId?reply=:replyId`로 정의한다. 이 파트의 스레드 패널은 `reply` 쿼리로 답글을 강조할 수 있어야 한다(같은 라우트 사용, 07과 중복 구현 금지).
- 10(안 읽음 구분선)과 MessageList.tsx를 함께 건드린다. 채널 본문의 `alsoSendToChannel` 항목은 안 읽음 수에 포함, 스레드 안 일반 답글은 제외(기존 unreads-threads 테스트 규칙 유지).
- 02에서 DMGroup이 생겼으므로 그룹 DM 스레드도 목록에 노출할지 결정이 필요하다: 이번 범위는 채널 스레드만, 그룹 DM·DM 스레드는 후속으로 명시.
