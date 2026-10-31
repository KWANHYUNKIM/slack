# 소켓 이벤트 레지스트리

이름은 `<자원>:<동작>` 형식이다(`docs/conventions/backend.md` 2절). **새 이벤트를 만들면 이 표에 먼저 등록한다.**
쓰기는 HTTP, 알림은 Socket.io다. DB에 커밋한 뒤 room으로 보낸다.

room: `user:<id>`(개인), `channel:<id>`(채널), `dm:<작은id>-<큰id>`(DM 대화). 그룹 DM은 전용 room 없이 `user:<id>`를 쓴다(아래 파트 02).

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

## 그룹 DM - 파트 02

그룹 DM 이벤트는 별도 room 없이 멤버 각자의 `user:<id>`로 보낸다(기존 `dm:*`와 같은 방식, 나가기·추가 때 room 관리가 필요 없다). 서버는 매번 현재 멤버를 DB에서 읽어 보낸다.

| 이벤트 | 방향 | 대상 room | payload | 시점 |
|---|---|---|---|---|
| `dmgroup:send` | 클라이언트 -> 서버 | - | `{ groupId, content, fileIds? }`, ack 지원: 성공 `{ id }`, 실패 `{ error, code? }`(잘못된 fileIds는 `code: 'INVALID_FILE_IDS'`) | 소켓 경로 전송. ack가 없으면 실패를 `error` 이벤트로 보낸다 |
| `dmgroup:typing:start` / `dmgroup:typing:stop` | 양방향 | 나를 뺀 멤버의 `user:<id>` | 보낼 때 `groupId`(number), 받을 때 `{ groupId, userId }` | 입력 중 표시. 멤버가 아니면 무시 |
| `dmgroup:member:added` | 서버 -> 클라이언트 | 추가 후 멤버 전원의 `user:<id>` | `{ groupId, userIds, actorId, group }` | `POST /dms/groups/:id/members` |
| `dmgroup:member:removed` | 서버 -> 클라이언트 | 나가기 전 멤버 전원(나간 사람 포함)의 `user:<id>` | `{ groupId, userId }` | `DELETE /dms/groups/:id/members/me` |
| `dmgroup:updated` | 서버 -> 클라이언트 | 멤버 전원의 `user:<id>` | `{ id, name }` | `PATCH /dms/groups/:id`로 이름이 바뀌었을 때 |
| `dm:new` / `dm:reply` | 서버 -> 클라이언트 | 멤버 전원의 `user:<id>` | DM 객체(`groupId` 있음, `toUserId`는 null) | 그룹 메시지·답글 전송(HTTP, 소켓) |
| `dm:updated` / `dm:deleted` | 서버 -> 클라이언트 | 보낸 사람을 뺀 멤버의 `user:<id>`(핀은 전원) | `dm:deleted`는 `{ dmId, fromUserId, toUserId: null, groupId, threadId }` | 그룹 메시지 편집·삭제·핀 |
| `dm:reaction:added` / `dm:reaction:removed` | 서버 -> 클라이언트 | 멤버 전원의 `user:<id>` | 1:1과 같은 모양 + `groupId` | 그룹 메시지 리액션 |
| `star:updated` | 서버 -> 클라이언트 | `user:<본인>` | `{ type: 'group', id: groupId, isStarred }` | `PUT/DELETE /dms/groups/:id/star` |

## 스레드 모아보기 - 파트 04

채널 스레드만 다룬다(1:1·그룹 DM 스레드는 후속). 참여자 = 부모 작성자 + 삭제되지 않은 답글 작성자 중 지금도 그 채널 멤버인 사람.

| 이벤트 | 방향 | 대상 room | payload | 시점 |
|---|---|---|---|---|
| `thread:updated` | 서버 -> 클라이언트 | 스레드 참여자 각자의 `user:<id>` (작성자 본인 포함) | `{ parentId, channelId, lastReplyId, replyCount, actorId }` | 답글 생성(HTTP 답글, 채널 메시지 POST, 소켓 `message:send`), 답글 삭제 후, 답글이 남은 부모 삭제 후(부모 작성자도 대상). 삭제로 답글이 없어지면 `lastReplyId`는 null |
| `thread:read` | 서버 -> 클라이언트 | `user:<본인>` | `{ parentId }` | `POST /threads/:id/read` (다른 탭 동기화) |
| `message:send` (확장) | 클라이언트 -> 서버 | - | `alsoSendToChannel?: boolean` 추가 (`threadId`가 있을 때만 의미) | 채널에도 보내기 |
| `message:new` / `message:updated` (확장) | 서버 -> 클라이언트 | `channel:<id>` | 스레드 답글에 `alsoSendToChannel`, `parent`(`{ id, content(100자 발췌), deletedAt, user }`) 포함 | `POST/DELETE /messages/:id/broadcast`와 HTTP `PATCH /messages/:id`(소켓 `message:edit`과 같은 payload)는 `message:updated`로 알린다 |

## 커스텀 상태·방해금지 - 파트 05

| 이벤트 | 방향 | 대상 room | payload | 시점 |
|---|---|---|---|---|
| `user:status` | 서버 -> 클라이언트 | 본인(모든 탭)과, 같은 채널·DM·그룹 DM을 쓰는 사용자 각자의 `user:<id>` | `{ userId, customStatus: { emoji, text, expiresAt } \| null, dnd: { active, until } }` | `PUT/DELETE /users/me/custom-status`, `PUT/POST/DELETE /users/me/dnd`, 스케줄러가 만료된 상태·DND를 정리했을 때. 만료된 값은 null/꺼짐으로 계산해 보낸다. 타인에게는 `dnd`가 `{ active, until }`뿐이고, 본인의 모든 탭에는 `dnd.withStatus`(상태에 묶인 방해금지인지)가 더 붙는다. `PUT /users/me/custom-status`에서 `expiresAt`을 빼면 기존 만료를 유지하고 `null`이면 만료를 없앤다 |

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
