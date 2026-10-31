# 07. 메시지 퍼말링크, 링크 복사, 딥링크 이동

우선순위 P0 / 추천 모델 sonnet / 예상 1.5h / 스키마 변경 없음

## 1. 기능 설명
근거: 메시지 더 보기 메뉴에 "링크 복사(L)" 항목 있음 [R1](호버 툴바 목록 관찰 확인). 링크를 열었을 때의 스크롤·강조 모습과 URL 형식은 미관찰, 공개 문서 기준 추정(Slack 퍼말링크는 `.../archives/<채널>/p<시각>` 형태이고 스레드 답글은 `?thread_ts=` 가 붙는다). 우리는 형식을 자체 설계한다(Slack 형식 복사 아님).
1. 메시지 더 보기 메뉴 "링크 복사": 클립보드에 `<origin>/c/<channelId>/m/<messageId>` (DM: `/d/<userId>/m/<id>`, 그룹 DM: `/g/<groupId>/m/<id>`, 스레드 답글: `/c/<channelId>/m/<parentId>?reply=<replyId>`). 복사 성공 토스트 "링크를 복사했습니다".
2. 링크 열기: 해당 대화로 이동 + 그 메시지 주변을 불러와(기존 `GET /channels/:id/messages?around=` 사용) 스크롤하고 2초간 배경 강조. 답글이면 스레드 패널을 열고 답글을 강조.
3. 링크 접근 불가(삭제됨, 비공개 채널 비멤버): "이 메시지를 찾을 수 없거나 볼 권한이 없습니다" 빈 화면 + 홈으로 가기. 존재 여부를 노출하지 않도록 403과 404를 같은 문구로 처리.
4. 메시지 본문에 우리 퍼말링크를 붙여넣으면 클릭 가능한 링크로 렌더(unfurl 카드는 범위 밖).

## 2. 화면 흐름
1. 호버 -> 더 보기 -> 링크 복사(또는 키 L, 06 이후) -> 토스트.
2. 링크 열기 -> `App.tsx` 라우트 `c/:channelId/m/:messageId` -> RouteSync가 채널 선택 후 `fetchMessages(channelId, messageId)` -> MessageList가 `data-message-id` 요소로 스크롤+강조.
3. 이미 로드된 범위 안이면 재요청 없이 스크롤만. 강조는 CSS 클래스 제거 타이머.
4. 이동 후 "최신으로 이동" 버튼(이미 있으면 재사용)으로 around 모드에서 빠져나옴.

## 3. 데이터 모델
없음. 메시지 ID 자체가 주소. (정책: 서버가 메시지가 해당 채널 소속인지 검증.)

## 4. API / 이벤트
- 기존 `GET /channels/:id/messages?around=<id>`는 이미 있음(routes/messages.ts 110행~). 부족: 대상 메시지가 해당 채널 소속이 아니거나 삭제된 경우 응답이 빈 배열인지 404인지 불명확 -> 대상이 없으면 404 `{ error, code:'MESSAGE_NOT_FOUND' }`로 통일. `around`는 `threadId:null`만 대상이므로 스레드 답글 id가 오면 부모 id로 리다이렉트하도록 `GET /messages/:id/locate` -> `{ channelId | dmUserId | groupId, parentId?, messageId }` 신규(권한 검사 후). 프런트가 링크의 ID만 알 때 대화를 알아내는 용도(교차 대화 링크 대비).
- WebSocket 변경 없음.

## 5. 관련 파일
- 수정: `frontend/src/App.tsx`(라우트 3개 추가, 646~648행 부근), `components/Messages/MessageActionsMenu.tsx`(항목 추가, 현재 markUnread/pin/edit/delete만), `MessageList.tsx`·`DMConversation.tsx`(스크롤+강조, DMConversation 162행에 이미 around 호출이 있으니 재사용), `lib/renderMessageContent.tsx`(자기 도메인 링크는 내부 이동), `backend/src/routes/messages.ts`, `threads.ts`(locate).
- 신규: `frontend/src/lib/permalink.ts`(생성/파싱 순수 함수), 토스트(기존 컴포넌트 있으면 재사용).
- 클립보드: `navigator.clipboard.writeText`, 실패 시 `document.execCommand('copy')` 폴백 없이 오류 토스트(HTTP 로컬 환경 주의).
- i18n 키: `actionsMenu.copyLink`, `permalink.copied`, `permalink.notFound`.
- 충돌: MessageList.tsx를 10(안 읽음 구분선)과 같이 건드림, 순차 진행.

## 6. 완료 기준
- `permalink.ts` 단위 테스트: 채널/DM/그룹/스레드 4종 생성-파싱 왕복.
- 백엔드 테스트: locate가 멤버에게 200, 비멤버(비공개 채널)에게 404, 삭제된 메시지 404, 스레드 답글이면 parentId 포함. around 대상 없음 404.
- 프런트 테스트: 링크 열기 시 대상 메시지가 DOM에 있고 강조 클래스가 붙었다 사라진다. 이미 로드된 경우 재요청 없음.
- 일반 오래된 메시지(로드 범위 밖)로 점프 후 "최신으로 이동"이 동작.
- CRUD 확인: 메시지 생성 -> 링크 복사 -> 새 탭에서 열기 -> 메시지 수정 후 링크 유효 -> 삭제 후 링크가 not found.
