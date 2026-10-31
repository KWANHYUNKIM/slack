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
| `channel:updated` | 서버 -> 클라이언트 | 공개 채널은 채널이 보이는 워크스페이스의 `ws:<id>`(E1c, 전체 방송 없음), 비공개 채널은 멤버 각자의 `user:<id>` | `{ id, name, topic, description, workspaceIds }` | `PATCH /channels/:id` 또는 `PATCH /admin/channels/:id`로 이름·주제·설명·공개 여부가 바뀌었을 때(변경 없으면 보내지 않음) |
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
| `dm:updated` / `dm:deleted` | 서버 -> 클라이언트 | 보낸 사람 본인을 포함한 멤버 전원의 `user:<id>`(보낸 사람의 다른 탭·기기도 갱신. 클라이언트가 id로 교체·제거하므로 중복 수신해도 같다) | `dm:deleted`는 `{ dmId, fromUserId, toUserId, groupId, threadId }`(1:1은 `toUserId`가 상대, 그룹은 null이고 `groupId`가 있음. `threadId`는 최상위면 null) | 그룹 메시지 편집·삭제·핀. 1:1과 나와의 대화(self-DM)도 같은 규칙 |
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

## 리마인더 - 파트 09

모두 서버 -> 클라이언트, 대상은 `user:<본인>`(모든 탭)뿐이다. payload의 `reminder`는 `GET /reminders` 항목과 같은 모양이다(`message`는 본인이 볼 수 있을 때만, 아니면 null이고 `messageDeleted: true`).

| 이벤트 | payload | 시점 |
|---|---|---|
| `reminder:due` | `{ reminder }` | 스케줄러(30초 틱)가 시각이 지난 리마인더를 발송했을 때. 같은 때 `activity:new`(type `REMINDER`)도 간다 |
| `reminder:updated` | `{ reminder }` | `POST /reminders`, `PATCH /reminders/:id`(스누즈, 완료, 되돌리기) |
| `reminder:removed` | `{ id }` | `DELETE /reminders/:id` |

## 조직·워크스페이스 - 파트 E1b

모두 서버 -> 클라이언트. 소켓은 연결할 때 활성 워크스페이스마다 `ws:<workspaceId>` room에 들어가고, 멤버십이 바뀌면 서버가 그 사용자의 모든 소켓을 room에 넣거나 뺀다(`io.in('user:<id>').socketsJoin/socketsLeave`). 대상이 `user:<id>`와 `ws:<id>` 둘이면 배열로 보내 본인은 한 번만 받는다. 공유 채널 이벤트(`channel:shared`/`channel:unshared`)는 E1g, 채널 이벤트의 `workspaceIds`와 `io.emit` 제거는 아래 E1c 절(`docs/specs/E1-multi-workspace.md` 5.4).

| 이벤트 | 대상 room | payload | 시점 |
|---|---|---|---|
| `workspace:member:added` | `user:<대상>`, `ws:<id>` | `{ workspaceId, userId, role }` | 배정(`POST /workspaces/:id/members`), 초대 수락(`POST /auth/invite/:code/accept`), 공개 워크스페이스 참여(`POST /workspaces/:id/join`), 워크스페이스를 만든 사람(`POST /org/workspaces`, 본인에게만). 대상 소켓은 먼저 `ws:<id>`에 들어간다 |
| `workspace:member:updated` | `user:<대상>`, `ws:<id>` | `{ workspaceId, userId, role }` | 역할 변경(`PATCH /workspaces/:id/members/:userId`). 기본 워크스페이스(역할이 User.role이라 socket.user.role이 바뀜)일 때만 보낸 뒤 대상의 소켓을 끊는다(`error` `{ message: 'Workspace membership changed' }`, `/admin` 역할 변경과 같은 규칙). 다른 워크스페이스는 이벤트만 보내고 연결은 유지한다 |
| `workspace:member:removed` | `user:<대상>`, `ws:<id>` | `{ workspaceId, userId }` | 제거(`DELETE /workspaces/:id/members/:userId`), 나가기(`POST /workspaces/:id/leave`). 보낸 뒤 서버가 대상 소켓을 `ws:<id>` room에서 뺀다(연결은 유지). 기본 워크스페이스는 이 API로 나가거나 뺄 수 없다(계정 비활성화로만). 클라이언트는 그 워크스페이스를 전환기에서 뺀다 |
| `workspace:updated` | `ws:<id>` | `{ id, slug, name, icon, description, discoverability }` | `PATCH /org/workspaces/:id` |
| `workspace:archived` | `ws:<id>` | `{ id }` | `POST /org/workspaces/:id/archive`(기본 워크스페이스는 보관 불가). 보낸 뒤 room을 비운다. 이후 그 워크스페이스 API는 404 |
| `workspace:unarchived` | `ws:<id>` | `{ id }` | `POST /org/workspaces/:id/unarchive`. 남아 있던 활성 멤버의 소켓을 room에 다시 넣은 뒤 보낸다 |

### 채널 이벤트의 워크스페이스 범위 - 파트 E1c

`io.emit` 전체 방송을 없앴다. 채널 이벤트는 바뀐 뒤(삭제는 바뀌기 전) 상태로 대상을 정한다: 공개 채널은 `ChannelWorkspace`의 워크스페이스마다 `ws:<id>`(배열 대상이라 여러 워크스페이스 멤버도 한 번만 받는다), 비공개 채널은 멤버 각자의 `user:<id>`. payload에 `workspaceIds: number[]`(채널이 보이는 워크스페이스)를 붙인다. 클라이언트는 현재 워크스페이스가 아니면 사이드바 목록만 갱신한다.

| 이벤트 | 대상 room | payload | 시점 |
|---|---|---|---|
| `channel:updated` | 위 규칙 | `{ id, name, topic, description, workspaceIds }` | `PATCH /channels/:id`, `PATCH /admin/channels/:id` |
| `channel:archived` / `channel:unarchived` | 위 규칙 | `{ channelId, name, workspaceIds }` | `POST /admin/channels/:id/archive`·`unarchive` |
| `channel:deleted` | 위 규칙(삭제 전 계산) | `{ channelId, workspaceIds }` | `DELETE /admin/channels/:id`. 보낸 뒤 `channel:<id>` room을 비운다 |
| `channel:member-left` | `channel:<id>` | `{ channelId, userId, memberCount }` | 기존 시점에 더해 워크스페이스 제거·나가기로 그 워크스페이스에만 보이던 채널의 멤버십을 잃었을 때(채널마다 하나). 대상 소켓은 `channel:<id>` room에서 빠진다 |

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
