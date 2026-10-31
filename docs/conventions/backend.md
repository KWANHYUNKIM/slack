# 백엔드 규칙 (app/backend)

스택: Node.js 24 · TypeScript(strict, ESM) · Express 5 · Socket.io 4 · Prisma 5 · PostgreSQL 16 · zod · Jest + supertest

## 1. 폴더 구조
```
src/
  app.ts            Express 앱 조립 (미들웨어, 라우트 등록)
  index.ts          서버 시작 (HTTP + Socket.io)
  config.ts         환경변수 읽기와 검증 (다른 곳에서 process.env 직접 읽지 않기)
  db.ts             Prisma 클라이언트 단일 인스턴스
  routes/<자원>.ts   HTTP 라우트. 자원 이름은 복수형 (channels, messages, ...)
  services/<도메인>Service.ts  여러 라우트·소켓 경로가 함께 쓰는 비즈니스 로직
  websocket/        소켓 연결, 인증, 이벤트 핸들러
  middleware/       인증(auth), 인가(authorize), 에러 처리
  utils/            순수 함수 (pagination, params, logger, auditLog)
  tests/<자원>.test.ts
prisma/schema.prisma, prisma/migrations/
```
- 지금 slawk는 로직 대부분이 라우트 안에 있다. **새로 만들거나 크게 바꾸는 로직은 `services/`로 뺀다.** HTTP와 WebSocket 두 경로에서 같은 동작을 해야 하는 로직(메시지 전송, 멘션, 알림)은 반드시 서비스 하나를 같이 호출한다.

## 2. API 설계
- REST 형태로 만든다. `GET /channels`, `POST /channels/:id/messages`, `PATCH /messages/:id`, `DELETE /messages/:id`
- **쓰기는 HTTP, 실시간 알림은 Socket.io.** DB에 커밋한 뒤 해당 room에 이벤트를 보낸다(`docs/research/slack-architecture.md` 3절).
- 응답 형식
  - 성공: 자원 객체 그대로, 목록은 `{ items, nextCursor }`
  - 실패: `{ error: string, details?: unknown }`와 알맞은 상태 코드(400 검증, 401 인증, 403 권한, 404 없음, 409 충돌, 429 제한)
- 목록은 커서 기반 페이지네이션(`utils/pagination.ts`)을 쓴다. offset은 쓰지 않는다.
- 소켓 이벤트 이름은 `<자원>:<동작>` 형식으로 쓴다(`message:new`, `message:updated`, `message:deleted`, `reaction:added`, `activity:new`). 새 이벤트는 `docs/architecture/events.md`에 등록한다(없으면 처음 쓰는 사람이 만든다).

## 3. 코드 규칙
- 모든 입력(body, query, params, 소켓 payload)은 **zod 스키마로 검증**한다. 숫자 id는 `parseIntParam`을 쓴다.
- 인증은 `authMiddleware`, 인가는 `middleware/authorize.ts`의 `requireChannelMember`, `requireMessageAccess` 같은 미들웨어로 한다. 라우트마다 직접 권한 체크 코드를 새로 짜지 않는다.
- 에러는 `try/catch`에서 `logError`로 남기고 `errorHandler`에 맡긴다. 스택 트레이스를 응답에 넣지 않는다.
- 여러 테이블을 함께 바꾸면 `prisma.$transaction`을 쓴다.
- `$queryRaw`/`$executeRaw`는 꼭 필요할 때만 태그드 템플릿으로 쓴다. `$queryRawUnsafe`는 금지한다.
- 이름 규칙: 파일과 변수는 camelCase, 타입은 PascalCase, 상수는 UPPER_SNAKE, DB 모델은 단수 PascalCase(`Message`)
- 주석은 기존 코드처럼 "왜"를 설명할 때만 짧게 단다.

## 4. DB (Prisma)
- 스키마 변경은 `npx prisma migrate dev --name <설명>`으로 마이그레이션을 만들고, 마이그레이션 SQL도 커밋한다.
- **schema.prisma를 바꾸는 파트는 동시에 진행하지 않는다**(총괄이 순서대로 배정).
- 새 테이블에는 `createdAt`을 넣고, 조회 패턴에 맞는 `@@index`를 둔다. 나중에 멀티 워크스페이스(엔터프라이즈)를 하려면 `workspaceId`가 필요하니 설계할 때 염두에 둔다.
- 삭제 정책: 사용자 콘텐츠(메시지, 파일)는 소프트 삭제(`deletedAt`)가 기본이다. 감사 로그와 법적 보존(legal hold)과 연결된다.

## 5. 테스트
- 라우트마다 `tests/<자원>.test.ts`에 supertest로 **CRUD 전체 흐름**(생성, 조회, 수정, 삭제, 그리고 삭제 후 조회 실패)과 권한 실패 케이스를 넣는다.
- 소켓 이벤트는 `socket.io-client`로 수신까지 확인한다.
- 테스트 DB는 5434 포트의 `slackclone-db`만 쓴다(CLAUDE.md 4장).
- 실행: `cd app/backend && npm test -- --forceExit` (특정 파일: `npm test -- src/tests/x.test.ts`)
