# 03. 채널 메타(토픽·설명·이름 변경)와 즐겨찾기·사이드바 섹션

우선순위 P0 / 추천 모델 sonnet / 예상 1.5h / 스키마 변경 있음

## 1. 기능 설명
- 채널에 **토픽**(헤더 한 줄)과 **설명**(채널 소개)을 설정/편집. 채널 첫 화면(빈 상태 및 목록 상단)에 이름·설명·생성 정보·"설명 편집"·"사람 추가" 표시(관찰한 Slack 동작을 참고한 자체 구현).
- 채널 이름 변경(채널 OWNER/MODERATOR 또는 워크스페이스 ADMIN 이상). 이름 변경 시 시스템 안내 메시지는 선택 사항, 최소한 실시간으로 사이드바 반영.
- **즐겨찾기(별표)**: 채널 헤더의 별 아이콘으로 채널/DM을 즐겨찾기에 추가·해제. 사이드바 상단에 "즐겨찾기" 섹션이 생기고 비어 있으면 안내문 표시.
- **사이드바 섹션 접기/펼치기**: 즐겨찾기/채널/다이렉트 메시지 섹션 각각 접기 상태를 사용자별로 저장. (커스텀 섹션 생성/드래그는 후속 파트, 이번 범위 아님.)

## 2. 화면 흐름
1. 채널 헤더 별 클릭 → 즉시 즐겨찾기 섹션으로 이동(낙관적 업데이트), 다시 클릭하면 원래 섹션으로.
2. 채널 헤더의 토픽 영역 클릭(또는 채널 상세) → 편집 모달: 이름, 토픽, 설명. 저장 → 모든 접속자에게 `channel:updated` 브로드캐스트.
3. 권한 없는 사용자는 필드가 읽기 전용.
4. 섹션 헤더 클릭 → 접기/펼치기, 새로고침 후에도 유지.

## 3. 데이터 모델
```
// Channel 추가 컬럼
topic       String? @db.VarChar(250)
description String? @db.VarChar(500)   // 설명
// 이름 변경은 기존 name(@unique) 사용, 충돌 시 409.

model ChannelStar {            // 즐겨찾기 (채널)
  userId    Int
  channelId Int
  createdAt DateTime @default(now())
  @@id([userId, channelId])
}
model DMStar {                 // 즐겨찾기 (1:1 DM 상대). 그룹 DM(02)은 추후 groupId 컬럼 추가
  userId      Int
  otherUserId Int
  createdAt   DateTime @default(now())
  @@id([userId, otherUserId])
}
model SidebarPref {            // 섹션 접기 상태
  userId Int @id
  collapsed Json  // 예: {"starred":false,"channels":true,"dms":false}
}
```
기존 Channel.createdBy를 "만든 사람" 표시에 사용.

## 4. API / 이벤트
- `PATCH /channels/:id` body `{ name?, topic?, description? }` → 권한: 채널 OWNER/MODERATOR 또는 Role ADMIN/OWNER. 검증: name 소문자/숫자/하이픈 등 기존 생성 규칙 재사용(channels.ts POST 규칙 확인), 아카이브 채널은 거부, 이름 중복 409. 감사 로그(auditLog) 기록.
- `GET /channels`, `GET /channels/:id` 응답에 `topic`, `description`, `isStarred` 추가.
- `PUT /channels/:id/star`, `DELETE /channels/:id/star`; `PUT/DELETE /dms/:userId/star`
- `GET /users/me/sidebar`, `PATCH /users/me/sidebar` body `{ collapsed }`
- WebSocket 서버→클라: `channel:updated {id,name,topic,description}`(채널 룸 + 공개 채널은 멤버 `user:<id>`), 별표는 본인 `user:<id>`에 `star:updated`로 다중 탭 동기화.

## 5. 프론트엔드
- `Messages/MessageHeader.tsx`: 별 아이콘, 토픽 표시/편집 진입점.
- 신규 `ChannelDetailsModal.tsx`(이름/토픽/설명 편집). 채널 빈 상태 소개 블록(`MessageArea.tsx` 또는 MessageList 상단).
- `Sidebar/Sidebar.tsx`: 즐겨찾기 섹션, 접기 상태, `ChannelItem`/`DirectMessageItem` 재사용.
- `stores/useChannelStore.ts`: topic/description/isStarred 필드, socket `channel:updated` 구독, `lib/types.ts` 갱신.

## 6. 완료 기준 (테스트)
- jest: ① PATCH로 topic/description 수정, 길이 초과 400 ② 일반 MEMBER 403, 채널 MODERATOR/워크스페이스 ADMIN 허용 ③ 이름 변경 중복 409, 잘못된 형식 400, 아카이브 채널 거부 ④ 비공개 채널 비멤버 접근 불가 ⑤ star 추가/해제 멱등, GET /channels의 isStarred 반영, 타인 별표 영향 없음 ⑥ sidebar 접기 저장/조회 ⑦ `channel:updated` 수신(WebSocket 테스트) ⑧ 감사 로그 기록. 기존 channels.test.ts 통과.
- 프론트: 즐겨찾기 섹션 표시/이동, 새로고침 후 접기 상태 유지(수동 확인 또는 컴포넌트 테스트), tsc 빌드 통과.

## 7. slawk 관련 파일
backend: prisma/schema.prisma, routes/channels.ts, routes/admin.ts(PATCH /channels/:id 규칙 참고), middleware/authorize.ts, routes/users.ts, utils/auditLog.ts, websocket/index.ts, tests/channels.test.ts
frontend: Sidebar/Sidebar.tsx, Sidebar/ChannelItem.tsx, Sidebar/DirectMessageItem.tsx, Messages/MessageHeader.tsx, Messages/MessageArea.tsx, Messages/HeaderTabs.tsx, stores/useChannelStore.ts, lib/types.ts, lib/api.ts

## 8. 충돌 주의
schema.prisma(01, 02와 직렬), channels.ts(01의 /read 수정과 겹치지만 영역 다름), Sidebar.tsx(01, 02, 04와 겹침). 즐겨찾기 섹션은 Sidebar 구조를 바꾸므로 02보다 먼저 병합하면 02의 그룹 DM 항목이 재사용하기 쉽다. 순서 권장: 01 → 03 → 02.
