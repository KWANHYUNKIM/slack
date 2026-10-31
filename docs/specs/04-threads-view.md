# 04. "스레드" 모아보기, 스레드 읽음 상태, 채널에도 보내기

우선순위 P0 / 추천 모델 sonnet / 예상 2h / 스키마 변경 있음(ThreadRead 추가, 01·05와 schema.prisma 직렬)

## 1. 기능 설명
관찰(Claude in Chrome, 읽기 전용): 사이드바 상단에 "스레드" 항목이 있고(채널 목록 위, 허들/디렉터리와 같은 묶음), 클릭하면 주소가 채널 없는 `/client/<워크스페이스>`로 바뀌고 제목이 "스레드"가 된다. 참여한 스레드가 없으면 빈 화면 안내("스레드 관리하기", 설명 문구)가 나온다. 참여 스레드는 최신 답글 순 카드로 쌓이고 새 답글이 있으면 굵게/점으로 표시된다고 문서와 UI 구조에서 추정(미확인: 이 워크스페이스에 스레드가 없음).
- Slack 구조(리서치 문서 기준): 웹앱에 `subscriptions.thread.add`, `thread_marked`, `message_replied` 이름이 존재. 즉 "스레드 구독" 개념이 있고 읽음은 스레드 단위(`thread_marked`)로 기록된다고 추정.

기능
1. 스레드 모아보기: 내가 참여한 스레드(부모 작성자 또는 답글 작성자) 목록을 마지막 활동 순으로. 각 항목은 부모 메시지, 마지막 답글 몇 개, 채널명, 새 답글 수.
2. 스레드 읽음 상태: 스레드마다 마지막으로 읽은 답글 id를 저장해 안 읽은 답글 수 계산. 스레드 패널을 열면 읽음 처리. 사이드바 "스레드" 항목에 안 읽은 스레드 수 점/숫자.
3. 채널에도 보내기: 답글 입력창의 체크박스. 켜면 답글이 스레드 안에 들어가면서 채널 본문 타임라인에도 "스레드에 답글" 표시와 함께 나타난다. 수정/삭제 시 둘 다 반영.

## 2. 화면 흐름
1. 사용자가 사이드바 "스레드" 클릭 -> `GET /threads` -> 카드 목록. 안 읽은 카드는 굵게.
2. 카드 클릭 -> 우측에 기존 ThreadPanel 열림 + `POST /threads/:id/read`로 읽음 -> 배지 감소. 카드 헤더의 채널명 클릭 시 해당 채널로 이동.
3. 다른 사용자가 답글 -> `thread:updated` 수신 -> 목록 맨 위로 이동, 안 읽음 증가. 현재 패널이 열려 있으면 즉시 읽음.
4. 답글 작성 시 "채널에도 보내기" 체크 -> 전송 -> 스레드 패널과 채널 본문 둘 다에 표시(채널 쪽은 "스레드에 답글" 라벨 + 부모 발췌).
5. 답글 수정/삭제는 기존 흐름 유지. 삭제 시 채널에 복사본(`alsoSendToChannel`)도 함께 사라짐.
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
