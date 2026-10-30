# 01. 멘션 추적·알림과 내 활동(Activity) 탭

우선순위 P0 / 추천 모델 sonnet / 예상 2h / 스키마 변경 있음(다른 스키마 파트와 직렬)

## 1. 기능 설명
- 메시지에 포함된 `<@id|name>`, `<@here>`, 신규 `<@channel>`을 서버가 파싱해 멘션 대상에게 알림을 보낸다. (현재는 UI 입력/렌더링만 있고 서버는 멘션을 모름.)
- `@here` = 채널 멤버 중 온라인 사용자, `@channel` = 채널의 모든 멤버(채널 멤버 수 5명 초과 시 입력 시 확인 안내는 선택 사항).
- 멘션 받은 사용자의 사이드바 채널/DM에 멘션 카운트 배지(빨간 숫자)가 뜬다. 안 읽음 점(굵게)과 구분.
- 좌측 "내 활동" 탭: 나를 멘션한 메시지, 내 메시지에 달린 스레드 답글, 내 메시지에 달린 리액션을 최신순으로 보여주고 읽음/안 읽음 구분. (Slack의 활동 화면 동작을 참고하되 직접 설계.)
- 브라우저 알림/웹 푸시는 멘션 및 DM에 대해 발송(이미 있는 pushService 재사용).

## 2. 화면 흐름
1. A가 채널에서 B를 멘션해 전송 → 서버가 멘션 행을 저장 → B에게 `mention:new` 이벤트 + 푸시.
2. B 사이드바의 해당 채널에 숫자 배지. B가 채널을 열고 읽음 처리(`/channels/:id/read`) → 해당 채널 멘션이 읽음 처리.
3. B가 "내 활동" 탭 클릭 → 목록(탭: 전체 / 멘션 / 스레드 / 리액션). 항목 클릭 시 해당 채널/스레드로 이동하고 메시지 하이라이트.
4. "모두 읽음 처리" 버튼.
5. 이미 편집된 메시지에서 멘션이 추가/삭제되면 멘션 행 동기화(추가분만 알림).

## 3. 데이터 모델 (schema.prisma 추가)
```
enum ActivityType { MENTION CHANNEL_MENTION HERE_MENTION THREAD_REPLY REACTION }

model Activity {
  id         Int          @id @default(autoincrement())
  userId     Int          // 받는 사람
  actorId    Int          // 행위자
  type       ActivityType
  messageId  Int?         // 채널 메시지
  dmId       Int?         // DM 메시지
  channelId  Int?
  emoji      String?      @db.VarChar(50)
  readAt     DateTime?
  createdAt  DateTime     @default(now())
  user       User @relation("ActivityRecipient", fields: [userId], references: [id], onDelete: Cascade)
  actor      User @relation("ActivityActor", fields: [actorId], references: [id], onDelete: Cascade)
  @@index([userId, readAt, createdAt])
  @@unique([userId, type, messageId, dmId, actorId, emoji])  // 중복 방지(null 처리 주의: 서비스 레이어에서 사전 검사 병행)
}
```
User에 두 역방향 관계 필드를 추가한다. 메시지 삭제 시 Activity는 messageId 기준 정리(서비스에서 삭제 처리).

## 4. API / 이벤트
- 신규 `routes/activity.ts` (app.ts에 `/activity` 등록)
  - `GET /activity?type=&cursor=&limit=` → `{ items:[{id,type,actor,channel,message(발췌),emoji,readAt,createdAt}], nextCursor }`
  - `GET /activity/unread-count` → `{ total, mentions }`
  - `POST /activity/read` body `{ ids?:number[], all?:boolean }`
- `GET /channels`, `GET /dms` 응답에 `mentionCount` 필드 추가(읽음 기준 이후의 미읽은 멘션 수).
- `/channels/:id/read` 호출 시 해당 채널의 Activity(MENTION 계열) readAt 갱신.
- 서비스 `services/mentionService.ts`: `parseMentions(content) -> {userIds:number[], here:boolean, channel:boolean}`와 `createActivitiesForMessage(...)`. 정규식은 프론트 `renderMessageContent.tsx`의 `<@(\d+)\|([^>]+)>`와 동일 규칙. 채널 비멤버/자기 자신/비활성 사용자는 제외, 비공개 채널은 멤버만.
- 호출 지점: `routes/messages.ts` POST, `routes/threads.ts` reply(THREAD_REPLY는 부모 작성자와 스레드 참여자에게), `routes/reactions.ts` POST(메시지 작성자에게 REACTION), `routes/dms.ts` DM 전송/답글, `websocket/index.ts`의 `message:send`/`message:edit`/`dm:send` 경로(WebSocket 전송 경로가 별도 구현이므로 반드시 동일 서비스 호출).
- WebSocket 서버→클라이언트: `activity:new {activity}` (대상 `user:<id>` 룸), `activity:read {ids}`(다른 탭 동기화).
- 푸시: `pushService`에서 멘션/DM에 한해 발송. (05 상태/DND 파트가 이후 억제 로직을 추가하므로 발송 함수에 `shouldNotify(userId)` 훅 자리를 남긴다.)

## 5. 프론트엔드
- 좌측 레일/사이드바에 "내 활동" 항목과 미읽음 배지.
- 신규 `components/Messages/ActivityPage.tsx`, `stores/useActivityStore.ts`(socket 이벤트 구독).
- `lib/serializeDelta.ts`: `<@channel>` 직렬화 추가. `MentionDropdown.tsx`/`useQuillEditor.ts`: @channel 옵션 추가(채널 전용, DM 제외). `renderMessageContent.tsx`: `<@channel>` 렌더, 내가 멘션된 메시지는 배경 강조.
- Sidebar `ChannelItem`/`DirectMessageItem`의 `UnreadBadge`에 mentionCount 표시.

## 6. 완료 기준 (테스트)
- backend jest: ① 멘션 파싱 단위 테스트(여러 멘션, 중복, 잘못된 id, 코드블록 내부는 멘션 아님은 선택) ② 채널 메시지 전송 시 대상에게 Activity 생성, 비멤버/자기 자신/비활성 제외 ③ @here는 온라인 멤버만, @channel은 전체 멤버 ④ 스레드 답글·리액션 Activity 생성 ⑤ `GET /activity`, `unread-count`, `POST /activity/read` 인증·권한 ⑥ `/channels/:id/read`로 멘션 카운트 감소 ⑦ 메시지 삭제 시 Activity 정리 ⑧ WebSocket 경로(`message:send`)에서도 동일 동작 ⑨ `activity:new` 수신.
- 프론트: 활동 페이지 렌더, 배지 표시, 항목 클릭 이동(수동 확인 또는 vitest 컴포넌트 테스트).
- 기존 테스트 전부 통과.

## 7. slawk 관련 파일
backend: prisma/schema.prisma, routes/messages.ts, routes/threads.ts, routes/reactions.ts, routes/dms.ts, routes/channels.ts(/read), routes/unreads.ts, websocket/index.ts, services/pushService.ts, app.ts
frontend: lib/serializeDelta.ts, lib/renderMessageContent.tsx, hooks/useQuillEditor.ts, Messages/MentionDropdown.tsx, Sidebar/*, Layout/AppLayout.tsx, stores/useChannelStore.ts, lib/socket.ts

## 8. 충돌 주의
schema.prisma(타 스키마 파트와 직렬), websocket/index.ts·dms.ts(02 group-dm과 겹침), Sidebar(02, 03, 04 겹침). 02가 DM 전송 경로를 바꾸므로 01 병합 후 02를 진행.
