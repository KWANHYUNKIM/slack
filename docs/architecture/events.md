# 소켓 이벤트 레지스트리

이름은 `<자원>:<동작>` 형식이다(`docs/conventions/backend.md` 2절). **새 이벤트를 만들면 이 표에 먼저 등록한다.**
쓰기는 HTTP, 알림은 Socket.io다. DB에 커밋한 뒤 room으로 보낸다.

room: `user:<id>`(개인), `channel:<id>`(채널), `dm:<작은id>-<큰id>`(DM 대화)

## 활동(Activity) - 파트 01

| 이벤트 | 방향 | 대상 room | payload | 시점 |
|---|---|---|---|---|
| `activity:new` | 서버 -> 클라이언트 | `user:<받는 사람>` | `{ activity }` (`GET /activity` 항목과 같은 모양) | 멘션, 스레드 답글, 리액션으로 활동이 생겼을 때. 편집으로 멘션이 추가된 경우는 추가분만 |
| `activity:read` | 서버 -> 클라이언트 | `user:<본인>` | `{ ids: number[] }` | `POST /activity/read`, `/channels/:id/read`, `/dms/:userId/read`로 읽음 처리됐을 때(다른 탭 동기화) |
| `activity:removed` | 서버 -> 클라이언트 | `user:<받는 사람>` | `{ ids: number[] }` | 원본 메시지 삭제, 편집으로 멘션 제거, 리액션 취소로 활동이 사라졌을 때 |

## 채널 메타·별표 - 파트 03

| 이벤트 | 방향 | 대상 room | payload | 시점 |
|---|---|---|---|---|
| `channel:updated` | 서버 -> 클라이언트 | 공개 채널은 전체(`io.emit`), 비공개 채널은 멤버 각자의 `user:<id>` | `{ id, name, topic, description }` | `PATCH /channels/:id` 또는 `PATCH /admin/channels/:id`로 이름·주제·설명·공개 여부가 바뀌었을 때(변경 없으면 보내지 않음) |
| `star:updated` | 서버 -> 클라이언트 | `user:<본인>` | `{ type: 'channel' \| 'dm', id, isStarred }` | `PUT/DELETE /channels/:id/star`, `/dms/:userId/star` (다른 탭 동기화) |

## 기존 이벤트 (slawk에서 이어받음)

| 이벤트 | 방향 | 비고 |
|---|---|---|
| `message:send` | 클라이언트 -> 서버 | 채널 메시지 전송(ack 지원) |
| `message:new` / `message:updated` / `message:deleted` | 서버 -> 클라이언트 | `channel:<id>` |
| `message:edit` / `message:delete` | 클라이언트 -> 서버 | 소켓 경로 편집·삭제 |
| `reaction:added` / `reaction:removed` | 서버 -> 클라이언트 | `channel:<id>` |
| `dm:send` | 클라이언트 -> 서버 | DM 전송 |
| `dm:new` / `dm:reply` / `dm:updated` / `dm:deleted` | 서버 -> 클라이언트 | `user:<id>` |
| `dm:reaction:added` / `dm:reaction:removed` | 서버 -> 클라이언트 | `user:<id>` |
| `typing:start` / `typing:stop`, `dm:typing:start` / `dm:typing:stop` | 양방향 | 입력 중 표시 |
| `presence:update` | 서버 -> 클라이언트 | 접속 상태 |
| `channel:joined` / `channel:member-added` / `channel:member-left` / `channel:archived` / `channel:unarchived` / `channel:deleted` | 서버 -> 클라이언트 | 채널 변경 |
| `join:channel` / `leave:channel` / `dm:join` / `dm:leave` | 클라이언트 -> 서버 | room 참여 |
| `huddle:*` | 양방향 | `websocket/huddles.ts` |
| `error` | 서버 -> 클라이언트 | `{ message }` |
