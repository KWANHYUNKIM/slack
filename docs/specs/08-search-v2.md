# 08. 검색 v2: 연산자 필터, 탭, 하이라이트, 검색 페이지

우선순위 P0 / 추천 모델 sonnet / 예상 2h / 스키마 변경: 선택(성능용 인덱스 마이그레이션 1건)

## 1. 기능 설명
근거: 첫 분석 [R2]: 최상단 전체 검색창 관찰 확인. 필터 연산자와 결과 탭은 공개 도움말 기반 추정이며 **미관찰, 검증 필요**(이번 루프 브라우저 불가). 현재 우리 구현은 `GET /search?q=&type=&channelId=`: 대소문자 무시 포함 검색, q 2~200자, 채널명·작성자 이름도 매칭(routes/search.ts).
1. 질의 연산자(공백으로 구분, 따옴표 구문 지원):
   - `from:@이름` 또는 `from:이름`, `in:#채널` (복수 허용), `before:2026-10-01`, `after:2026-09-01`, `on:날짜`, `has:file|link|pin|reaction`, `is:thread|saved`
   - 연산자를 뺀 나머지는 본문 키워드(AND). 알 수 없는 연산자는 일반 단어로 취급.
2. 결과 탭: 메시지 / 파일 / 사람 / 채널. 메시지 탭은 일치 부분 `<mark>` 하이라이트, 채널·작성자·시각·스레드 여부 표시, 정렬 "관련도/최신".
3. 검색 페이지 `/search?q=...`: 헤더 검색창에서 Enter -> 이 페이지. 드롭다운 미리보기(현재 HeaderSearch)는 상위 5건 유지. 결과 클릭 -> 07의 퍼말링크로 이동(07 미병합이면 현재의 점프 방식).
4. 최소 길이: 연산자만 있고 키워드가 없는 질의(예 `from:@kim`)는 허용(키워드 길이 2자 제한은 키워드가 있을 때만).
5. 한글 NFC 정규화: 질의와 비교 대상 모두 NFC (보드의 `fix/search-nfc` 항목을 이 파트가 흡수).

## 2. 화면 흐름
1. 검색창에 `from:` 입력 시 사람 자동완성, `in:` 입력 시 채널 자동완성(기존 MentionDropdown 패턴 재사용).
2. Enter -> `/search?q=` 페이지, 상단에 해석된 필터를 칩으로 표시(칩의 x로 제거 -> 질의 재조합).
3. 탭 전환은 같은 질의로 서버 `type` 만 바꿔 재조회. 결과 20개씩 무한 스크롤(커서).
4. 결과 없음 상태 문구와 필터 해제 제안.

## 3. 데이터 모델
- 변경 없음이 기본. 성능이 문제면 `pg_trgm` GIN 인덱스(`Message.content`)를 마이그레이션 SQL로 추가(선택, 확장 설치 권한 확인 필요하므로 실패해도 기능은 동작해야 함).
- 사람/채널 탭은 기존 User, Channel 테이블 조회.

## 4. API
- 확장 `GET /search`: 쿼리 `q`(원문 질의 전체를 서버가 파싱) 또는 파싱된 `from`, `in`, `before`, `after`, `has`, `type=messages|files|people|channels|dms|all`, `cursor`, `limit`(최대 50), `sort=relevance|recent`. 응답에 `highlights`(일치 구간 오프셋 배열) 또는 서버가 만든 안전한 조각 + `parsedFilters`. HTML 반환 금지: 프런트가 오프셋으로 `<mark>`를 만든다(XSS 방지).
- 권한: 지금처럼 멤버인 채널과 내가 참여한 DM·그룹 DM만. `in:`에 비멤버 채널을 넣으면 결과 0건(존재 여부 노출 금지).
- 파일 탭: `File.filename` 포함 검색, 접근 가능한 대화의 파일만.
- 파서는 `backend/src/utils/searchQuery.ts` 순수 함수로 분리해 단위 테스트.
- WebSocket 이벤트 없음. Slack 대응 API(추정): `search.messages`, `search.files`, `search.modules`.

## 5. 관련 파일
- 수정: `backend/src/routes/search.ts`, `frontend/src/components/Messages/HeaderSearch.tsx`, `MobileSearchOverlay.tsx`, `App.tsx`(`/search` 라우트), `lib/api.ts`.
- 신규: `backend/src/utils/searchQuery.ts`, `frontend/src/components/Messages/SearchPage.tsx`, `lib/searchQuery.ts`(프런트 칩용 파서, 가능하면 공유 로직을 한 곳에만).
- 테스트: `backend/src/tests/search.test.ts`(현재 전용 테스트가 tests/ 목록에 없음).
- i18n: `search.*` 키 전체(탭, 칩, 빈 상태, 정렬).

## 6. 완료 기준
- 파서 단위 테스트 15건 이상: 연산자 조합, 따옴표, 알 수 없는 연산자, 한글, 날짜 형식 오류(400이 아니라 일반 단어 처리 또는 명확한 오류 중 하나로 문서화).
- 백엔드 통합 테스트: `from:`, `in:`, `before:`/`after:`, `has:file`, 비멤버 채널과 타인의 DM이 새지 않음, NFD 입력 한글 질의 일치, 결과 페이지네이션.
- 프런트: 칩 표시와 제거, 탭 전환, 하이라이트가 `dangerouslySetInnerHTML` 없이 렌더(린트 규칙 확인).
- 요청 한 번이 500ms 이내(테스트 DB 1천 메시지 기준, 기록만).
- CRUD 확인: 메시지 생성 -> 검색에 나타남 -> 수정 후 새 내용으로 검색됨 -> 삭제 후 사라짐.
