# 02. 그룹 DM (멀티파티 다이렉트 메시지)

우선순위 P0 / 추천 모델 opus(스키마 변경이 DM 전체에 영향, 실시간 룸 설계) / 예상 2h / 01 병합 후 진행 권장

## 1. 기능 설명
- 본인 포함 3~9명이 참여하는 비공개 대화. 이름은 참여자 이름 나열(수정 가능한 별도 이름은 선택). 1:1 DM과 동일하게 메시지, 편집/삭제, 스레드, 리액션, 핀, 파일, 읽음, 타이핑 표시 지원.
- 같은 참여자 집합으로 새로 만들면 기존 그룹 DM을 재사용(중복 생성 방지).
- 참여자 추가 가능(기존 기록은 새 참여자에게 보이지 않거나 보이는 정책 중 택일: **보이는 정책** 채택해 단순화). 나가기 가능. 1:1 DM에서 사람 추가 시 새 그룹 DM이 생성되고 1:1은 유지.
- 사이드바 DM 섹션에 그룹 DM이 참여자 아바타 겹침 + 이름 목록으로 표시.

## 2. 화면 흐름
1. 사이드바 "새 메시지"(또는 DM 섹션 +) → 수신자 선택 다이얼로그에서 여러 명 선택 → 1명이면 기존 1:1, 2명 이상이면 그룹 DM.
2. 그룹 DM 열기 → 헤더에 참여자 목록/인원 수, 멤버 패널에서 추가/나가기.
3. 메시지 전송 → 모든 참여자에게 실시간 반영, 비활성 참여자에게 미읽음 배지/푸시.
4. 읽음 처리는 사용자별 마지막 읽은 메시지 id 방식.

## 3. 데이터 모델
기존 `DirectMessage`(from/to 쌍)를 최대한 유지하기 위해 **그룹 대화 전용 모델 추가 + DirectMessage 확장**을 택한다.
```
model DMGroup {
  id        Int      @id @default(autoincrement())
  name      String?  @db.VarChar(100)
  memberKey String   @unique   // 정렬된 userId를 '-'로 연결(중복 방지)
  createdBy Int
  createdAt DateTime @default(now())
  members   DMGroupMember[]
  messages  DirectMessage[]
}
model DMGroupMember {
  groupId          Int
  userId           Int
  lastReadDmId     Int?
  joinedAt         DateTime @default(now())
  @@id([groupId, userId])
}
// DirectMessage 변경
//   toUserId Int?   (그룹 메시지는 null)
//   groupId  Int?   + relation DMGroup, @@index([groupId, createdAt])
// DMReaction, File.dmId는 그대로 DirectMessage.id를 참조하므로 재사용.
```
주의: `toUserId`를 nullable로 바꾸면 dms.ts 곳곳의 `where` 조건과 `requireDmAccess`(authorize.ts)가 영향을 받는다. 접근 판정은 "groupId가 있으면 그룹 멤버 여부, 없으면 기존 from/to 판정"으로 분기한다. 기존 1:1 테스트가 모두 통과해야 한다.

## 4. API / 이벤트
- `POST /dms/groups` body `{ userIds:number[] }` (2~8명 + 본인) → `{ group }` (기존 있으면 200으로 반환)
- `GET /dms/groups` 또는 `GET /dms` 응답에 그룹 포함(`type:'group'`, members, lastMessage, unreadCount)
- `GET /dms/groups/:id/messages?cursor=`, `POST /dms/groups/:id/messages`
- `POST /dms/groups/:id/members` (추가), `DELETE /dms/groups/:id/members/me` (나가기), `POST /dms/groups/:id/read`
- 기존 메시지 단위 엔드포인트(`/dms/messages/:id` PATCH/DELETE, reply, thread, reactions, pin)는 그룹 메시지에도 동작하도록 접근 판정만 확장.
- WebSocket: 룸 `dmgroup:<id>`. 이벤트 `dmgroup:join`/`dmgroup:leave`, `dmgroup:send`, 서버→클라 `dm:new`(payload에 `groupId`), `dm:updated`, `dm:deleted`, `dm:reaction:*`는 payload에 groupId 포함, `dmgroup:typing:start|stop`, `dmgroup:member:added|removed`. 개인 룸 `user:<id>`로 푸시 방식인 기존 `dm:new` 패턴과 일관되게, 멤버 전원 `user:<id>`로 emit해도 무방(룸 관리 단순).
- 푸시/활동(01)과 연동: 그룹 DM 새 메시지는 푸시 대상. 멘션 서비스는 그룹 멤버 한정.

## 5. 프론트엔드
- `useDMStore.ts`: 대화 키를 `userId` 단일에서 `{type:'user'|'group', id}`로 일반화.
- `Sidebar/DirectMessageItem.tsx`: 그룹 항목 표시. `Sidebar.tsx` 새 메시지 다이얼로그에 다중 선택.
- `Messages/DMConversation.tsx`: groupId 분기, 헤더/멤버 패널.
- `lib/socket.ts`, `lib/types.ts`, `lib/api.ts` 타입/함수 추가.

## 6. 완료 기준 (테스트)
- jest: ① 그룹 생성(2~8명), 1명/9명 초과/중복/비활성 사용자 거부 ② 동일 멤버 집합 재생성 시 기존 반환 ③ 멤버만 조회/전송 가능, 비멤버 403 ④ 메시지 편집/삭제는 작성자만 ⑤ 스레드·리액션·핀·파일 첨부 동작 ⑥ 멤버 추가/나가기, 마지막 1명 남으면 정책에 따라 처리(2명 남으면 유지) ⑦ 읽음/미읽음 카운트 ⑧ WebSocket: 전송 시 멤버 전원 수신, 비멤버 미수신, 타이핑 이벤트 ⑨ 기존 1:1 DM 테스트(dms.test.ts, multi-user.test.ts, security.test.ts) 전부 통과.
- 마이그레이션이 기존 데이터에 무해(기존 행 groupId=null).
- 프론트 빌드(tsc) 통과.

## 7. slawk 관련 파일
backend: prisma/schema.prisma, routes/dms.ts(871줄, 핵심), middleware/authorize.ts(requireDmAccess/requireDmOwnership), websocket/index.ts(dm:*, 룸/타이핑), routes/files.ts(dmId 접근 검사), routes/search.ts(DM 검색 범위), routes/unreads.ts, services/pushService.ts, tests/dms.test.ts
frontend: stores/useDMStore.ts, Sidebar/Sidebar.tsx, Sidebar/DirectMessageItem.tsx, Messages/DMConversation.tsx, lib/socket.ts, lib/api.ts, lib/types.ts, Messages/MembersPanel.tsx

## 8. 충돌 주의
dms.ts, websocket/index.ts, authorize.ts, schema.prisma, Sidebar는 01·03·04와 겹친다. 02는 단독 배정하고 병합 후 다른 파트가 재베이스.
