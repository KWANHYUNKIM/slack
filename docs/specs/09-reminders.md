# 09. 리마인더 (메시지에 리마인더 추가, /remind 기본, 목록)

우선순위 P1 / 추천 모델 sonnet / 예상 1.5h / 스키마 변경 있음(Reminder 추가). 05(스키마 직렬) 이후, 방해금지 억제는 05의 `shouldNotify`를 쓴다.

## 1. 기능 설명
근거: 메시지 더 보기 메뉴에 "리마인더 추가(하위 메뉴)" 항목이 있음 [R1](관찰 확인). 하위 시간 목록의 정확한 값, 알림이 오는 방식(Slackbot DM), `/remind` 구문은 미관찰이며 공개 도움말 기반 추정이다. 검증 필요. 우리는 자체 설계한다(봇 DM 대신 활동 탭 항목 + 푸시).
1. 메시지 리마인더: 더 보기 -> 리마인더 추가 -> 20분 / 1시간 / 3시간 / 내일 / 다음 주 / 사용자 지정(날짜+시각). 선택하면 그 메시지를 가리키는 리마인더가 생기고 시각이 되면 알림.
2. 알림 도착: (a) 내 활동 탭(01)에 `REMINDER` 항목, (b) 웹 푸시(가능하면, 05 DND 중이면 억제하되 활동 항목은 남김), (c) 접속 중이면 소켓 이벤트로 토스트.
3. 목록: 사이드바 "나중에"(LaterPage)에 "리마인더" 탭 추가. 항목: 대상 메시지 발췌, 예정 시각, 완료/삭제 버튼. 완료 처리, 다시 알림(10분/1시간/내일 스누즈).
4. `/remind me <내용> in <숫자> <분|시간|일>` 기본 구문(영어 단위 + 한국어 단위 "분/시간/일 후"). 메시지 입력 시작이 `/remind`이면 서버가 처리하고 채널 메시지로는 저장하지 않는다. 구문 오류 시 에러 응답을 입력창 아래 안내로 표시. 자연어 날짜("내일 오후 3시") 파싱은 범위 밖.
5. 메시지가 삭제되면 리마인더는 유지하되 발췌 대신 "삭제된 메시지" 표시.

## 2. 화면 흐름
1. 메시지 호버 -> 더 보기 -> 리마인더 추가 -> 시간 선택 -> 토스트 "리마인더가 설정되었습니다", 메시지 오른쪽에 작은 종 표시(선택).
2. 시각 도달 -> 서버 스케줄러 -> DB 갱신 + `reminder:due` 소켓 -> 토스트와 활동 탭 배지 증가.
3. "나중에 > 리마인더" 탭: 예정 순 정렬. 완료 -> 사라짐. 삭제 -> 확인 없이 제거(되돌리기 토스트는 범위 밖).
4. 다른 탭/기기에서도 목록 동기화(`reminder:updated`).

## 3. 데이터 모델
```
model Reminder {
  id         Int       @id @default(autoincrement())
  userId     Int
  messageId  Int?      // 채널 메시지 (FK 없음: 삭제돼도 유지)
  dmId       Int?
  channelId  Int?
  text       String?   @db.VarChar(500)   // /remind 로 만든 경우의 본문
  remindAt   DateTime
  firedAt    DateTime?
  completedAt DateTime?
  createdAt  DateTime  @default(now())
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, completedAt, remindAt])
  @@index([remindAt, firedAt])
}
```
`ActivityType`에 `REMINDER` 추가(enum 변경 마이그레이션). User에 역방향 관계.

## 4. API / 이벤트
- `POST /reminders` body `{ messageId? | dmId?, text?, remindAt }`(zod: 현재 이후, 1년 이내, 본인이 볼 수 있는 메시지만 `requireMessageAccess` 규칙) -> 201.
- `GET /reminders?status=pending|done`, `PATCH /reminders/:id`(`{ remindAt }` 스누즈 또는 `{ completed:true }`), `DELETE /reminders/:id`(본인 것만, 아니면 404).
- 한도: 사용자당 미완료 200개.
- `scheduler.ts`에 30초 틱 추가(기존 예약 전송과 같은 루프 재사용, `firedAt IS NULL AND remindAt <= now`를 `take 50`, 중복 발송 방지를 위해 `updateMany ... where firedAt null`로 선점 후 발송).
- WebSocket: `reminder:due { reminder }`, `reminder:updated`를 `user:<id>` 룸에. 이벤트는 `docs/architecture/events.md`에 등록. Slack 대응(추정): 서버 `reminders.add/complete/delete/list` API.
- 슬래시 `/remind`는 기존 메시지 전송 경로(`routes/messages.ts` 31행 POST, websocket message:send)에서 선처리하는 대신 프런트가 `/remind`를 감지해 `POST /reminders`로 보낸다(경로 하나로 통일, 소켓 쓰기 경로 리팩터와 충돌 방지).

## 5. 관련 파일
- 백엔드: `prisma/schema.prisma`+마이그레이션, 신규 `routes/reminders.ts`(app.ts 등록), `scheduler.ts`, `services/activityService`(01에서 만든 위치 확인), `services/pushService.ts`(05의 훅).
- 프런트: `Messages/MessageActionsMenu.tsx`(07과 충돌 가능: 07 먼저), 신규 `Messages/ReminderMenu.tsx`, `Messages/LaterPage.tsx`(탭 추가), `ActivityPage.tsx`(REMINDER 행), 신규 `stores/useReminderStore.ts`, `lib/types.ts`.
- i18n: `reminder.*`.

## 6. 완료 기준
- 백엔드 테스트: 생성 검증(과거 시각 400, 접근 불가 메시지 404), 목록 필터, 스누즈, 완료, 삭제는 본인만(타인 id 404), 한도 초과 400.
- 스케줄러 테스트: 시각이 지난 리마인더가 한 번만 발송(두 번 틱을 돌려도 `firedAt` 선점으로 1회), 소켓 `reminder:due`와 Activity 한 건 생성.
- `/remind me 물 마시기 in 2 분` 파서 단위 테스트(영어/한국어 단위, 잘못된 입력).
- 프런트: 메뉴에서 생성, 탭에서 완료/삭제 컴포넌트 테스트.
- CRUD 확인: 생성 -> 목록에 보임 -> 스누즈 후 시각 변경 -> 완료 -> 삭제, 각 단계 소켓 동기화 확인.
