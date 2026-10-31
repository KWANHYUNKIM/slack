# 05. 커스텀 상태, 방해금지(DND), 알림 억제

우선순위 P0 / 추천 모델 sonnet / 예상 1.5h / 스키마 변경 있음(User 필드 추가, 01·04와 직렬)

## 1. 기능 설명
관찰(Claude in Chrome, 읽기 전용, 저장 안 함):
- 프로필 메뉴: 이름 + 프레즌스 점("대기 가능"), "상태 업데이트" 입력칸, "자리 비움으로 설정", "알림" 항목(우측에 켜짐/꺼짐 표시) -> 하위 메뉴: "다음 시간 동안 알림 일시 중지" 30분 / 1시간 / 2시간 / 내일까지 / 다음 주까지 / 사용자 지정, 그 아래 "업무 시간 편집".
- 상태 설정 대화상자: 이모지 선택 + 텍스트 입력, "최근 사용" 목록, 워크스페이스 추천 프리셋(미팅 중 1시간, 출퇴근 중 30분, 병가 모일 등 기간 포함). 텍스트를 입력하면 "기간" 드롭다운(기본값 오늘)과 체크박스 "상태가 지워질 때까지 알림 일시 중지"가 나타남. 저장/취소.
- 데스크톱 이벤트 이름(리서치): `presence_change`, `manual_presence_change`, `dnd_updated_user`, `user_change`, `pref_change`; 부팅 시 `dnd.info`, `users.customStatus.list`. 즉 DND와 상태는 프레즌스와 별개 값이고 별도 이벤트로 전파됨.
- 쓰기 실습(상태 저장, DND 켜기)은 이번에 수행하지 않음(아래 보고 참조). 만료 표시, 상태 이모지가 이름 옆에 붙는 위치는 문서 지식 기준.

기능
1. 커스텀 상태: 이모지(최대 1개) + 텍스트(100자) + 만료(안 함 / 30분 / 1시간 / 오늘 / 이번 주 / 사용자 지정). 만료되면 자동 삭제되고 다른 사용자에게 갱신 전파.
2. 방해금지: 지금부터 N분/내일까지 알림 일시 중지. 켜진 동안 푸시와 활동 알림음/배지 억제(메시지 수신 자체는 정상). 켜기/끄기 토글, 남은 시간 표시. 선택적으로 "알림 시간대"(업무 시간)는 후속(08).
3. 상태와 DND 연동: 상태 설정 시 "상태가 지워질 때까지 알림 일시 중지" 옵션.
4. 프레즌스와 관계: 프레즌스(online/away/busy/offline, 이미 있음)는 소켓 연결과 수동 설정이 만드는 값, 상태/DND는 별개 축. UI에서 DND 중이면 아바타 점 옆에 달 아이콘을 얹되 프레즌스 값은 바꾸지 않는다. 다른 사용자는 DND 여부(켜짐/끝나는 시각)를 볼 수 있고 내용은 볼 수 없음.
5. 푸시/활동 억제: 01의 pushService `shouldNotify(userId)` 훅을 이 파트가 채운다.

## 2. 화면 흐름
1. 아바타 클릭 -> 프로필 메뉴(상태 입력칸, 알림 일시중지 하위메뉴, 현재 상태 표시).
2. "상태 업데이트" -> 대화상자 -> 이모지/텍스트/기간 선택 -> 저장 -> 메뉴와 사이드바 DM 목록, 메시지 작성자 이름 옆, 프로필 모달에 이모지 표시(툴팁에 텍스트와 만료).
3. 상태 수정/지우기: 대화상자 재오픈 -> 수정 또는 "상태 지우기".
4. "알림 일시 중지 30분" 선택 -> 메뉴에 "알림 꺼짐, 12:30까지" + "다시 켜기" 항목. 만료 시 자동 해제.
5. 만료 처리: 서버 스케줄러가 분 단위로 만료 상태/DND를 정리하고 `user:status` 전파. 접속 중 클라이언트는 만료 시각 타이머로 즉시 숨김(낙관적).

## 3. 데이터 모델 (schema.prisma, User에 필드 추가)
이미 있음: `User.status`(`online/away/busy/offline` 프레즌스), `bio`, `lastSeen`. 이 필드는 프레즌스이므로 이름 충돌을 피해 새 필드는 `customStatus*`로 한다.
```
User {
  customStatusEmoji     String?   @db.VarChar(50)
  customStatusText      String?   @db.VarChar(100)
  customStatusExpiresAt DateTime?
  dndUntil              DateTime?   // 이 시각까지 알림 일시중지, null이면 꺼짐
  dndWithStatus         Boolean   @default(false) // 상태가 지워질 때 DND도 해제
}
```
별도 테이블 불필요(최근 사용 목록은 클라이언트 localStorage). 인덱스 `@@index([dndUntil])`, `@@index([customStatusExpiresAt])`(스케줄러용).

## 4. API / 이벤트
- `PUT /users/me/custom-status` body `{ emoji?, text?, expiresAt?: ISO|null, pauseNotifications?: boolean }` (zod, 텍스트/이모지 길이 제한, 과거 시각 400, 제어문자 제거) -> 사용자 객체. `DELETE /users/me/custom-status`.
- `POST /users/me/dnd` body `{ minutes?: 1..10080, until?: ISO }`, `DELETE /users/me/dnd`. `GET /users/me/dnd` -> `{ active, until }`.
- 기존 `GET /users/:id`, `GET /users`, 프로필 조회 응답에 `customStatus{emoji,text,expiresAt}`, `dnd{active,until}`(타인에겐 active/until만) 추가. 만료된 값은 조회 시점에도 null로 계산(스케줄러 지연 대비).
- 서비스 `services/statusService.ts`: `isDndActive(user)`, `setCustomStatus`, `clearExpired()`(scheduler.ts에서 호출).
- 훅 채우기: `services/pushService.ts`의 `sendPushToUser` 맨 앞에서 `shouldNotify(userId)` 호출(01에서 자리만 남김). 규칙: DND 활성이면 false. 그 외 알림 수준 규칙(채널 뮤트 등)은 08이 확장. 호출 지점(threads.ts, dms.ts, websocket/index.ts, scheduler.ts)은 모두 `sendPushToUser`를 거치므로 변경 불필요. 01의 `activity:new`는 저장과 전송은 하되 클라이언트가 DND 중 소리/브라우저 알림만 억제(Activity 행은 유지).
- WebSocket: `user:status { userId, customStatus, dnd }`를 공유 사용자 룸으로(기존 `presence:update` 브로드캐스트 경로 재사용), 본인 다른 탭도 수신. Slack 대응: `user_change`, `dnd_updated_user`. `docs/architecture/events.md`에 등록.

## 5. 프런트엔드
이미 있음: 프레즌스 점 표시(Sidebar/Avatar의 status prop), `PUT /users/me/status`, ProfileModal.
추가:
- `components/Profile/StatusDialog.tsx`(이모지 피커는 ui/emoji-picker 재사용), 아바타 메뉴에 상태 입력칸과 알림 일시중지 하위메뉴(30분/1시간/2시간/내일까지/사용자 지정).
- `useAuthStore` 또는 `useProfileStore`에 customStatus/dnd 저장, 소켓 `user:status` 구독, 만료 타이머.
- Message 작성자 이름 옆, DM 목록 항목, ProfileModal에 상태 이모지 + 툴팁. DND 중 달 아이콘.
- DND 중 브라우저 Notification/알림음 억제(HeaderNotifications, useNotificationStore).

## 6. 완료 기준 (테스트)
- backend jest(`tests/status-dnd.test.ts`): ① 상태 설정/수정/삭제와 입력 검증(긴 텍스트, 과거 만료, 인증 401) ② 만료 후 조회 시 null, `clearExpired`가 정리 ③ DND 켜기/끄기/남은 시간, 범위 검증 ④ DND 중 `sendPushToUser`가 구독이 있어도 발송하지 않음(web-push 모킹), 해제 후 발송 ⑤ `pauseNotifications` 옵션과 상태 삭제 시 DND 해제 ⑥ 타인 응답에 DND 세부 정보 노출 안 됨 ⑦ `user:status` 이벤트가 공유 사용자와 본인 다른 소켓에 도착.
- CRUD 직접 확인: 상태 설정 -> 조회 -> 수정 -> 삭제, DND 켜기 -> 끄기를 로컬 앱과 API로 반복.
- 프런트: StatusDialog 렌더/저장, DND 아이콘. 기존 테스트 통과(presence.test 포함).

## 7. slawk 관련 파일
backend: prisma/schema.prisma, routes/users.ts(기존 `/me/status` 옆에 추가), services/pushService.ts, scheduler.ts, websocket/index.ts(presence 브로드캐스트와 isUserOnline), app.ts, tests/presence.test.ts·users.test.ts, 신규 services/statusService.ts
frontend: Messages/ProfileModal(프로필 관련), Sidebar/Sidebar.tsx(아바타 영역)·DirectMessageItem.tsx, ui/avatar.tsx, ui/emoji-picker.tsx, Messages/Message.tsx·HeaderNotifications.tsx, stores/useProfileStore.ts·useAuthStore.ts·useNotificationStore.ts, lib/socket.ts

## 8. 충돌 주의
01 선행 필수(`shouldNotify` 자리). schema.prisma는 01, 04와 직렬. users.ts와 websocket/index.ts의 presence 블록은 02(DM) 등과 겹칠 수 있음. 08(알림 설정)이 `shouldNotify`를 이어서 확장하므로 시그니처를 `shouldNotify(userId, ctx?)`로 열어 둔다.
