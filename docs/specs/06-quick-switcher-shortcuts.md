# 06. 빠른 전환기(Cmd/Ctrl+K)와 전역 키보드 단축키

우선순위 P0 / 추천 모델 sonnet(순수 프런트라 haiku도 가능하나 접근성·포커스 처리 때문에 sonnet) / 예상 1.5h / 스키마 변경 없음 / 백엔드 변경 없음

## 1. 기능 설명
근거: 첫 화면 관찰 [R2](사이드바 "대화 찾기" 입력, 최상단 검색창), 호버 더 보기 메뉴의 단축키 표기 E(편집), U(읽지 않음), L(링크 복사), P(고정) [R1]. 단축키 동작 자체는 미관찰이며 공개 도움말 수준 추정이다. 검증 필요.
1. 빠른 전환기: Cmd+K(Mac) / Ctrl+K(그 외)로 열리는 가운데 모달. 입력창 하나, 결과는 채널·DM·그룹 DM·사람을 섞어 보여준다. 입력이 비어 있으면 "최근 방문" 순서. 위/아래 화살표로 이동, Enter로 선택해 해당 화면으로 이동, Esc로 닫기. 안 읽음이 있는 항목은 굵게+배지. 퍼지 매칭(글자 연속이 아니어도 순서만 맞으면 일치, 앞쪽 일치 가중). 한국어 초성 검색은 범위 밖.
2. 전역 단축키(입력창에 포커스가 없을 때만, 입력 중에는 Esc와 Cmd+K만):
   - Cmd/Ctrl+K 전환기, Esc 패널·모달 닫기(가장 위의 것부터 하나씩), `?` 단축키 도움말 모달
   - Alt+위/아래 이전·다음 채널(사이드바 순서), Alt+Shift+위/아래 이전·다음 안 읽은 채널
   - 메시지 위에 마우스 호버 또는 선택된 상태에서 E 편집(내 메시지), U 안 읽음으로 표시, P 고정 토글, L 링크 복사(07 이후에 연결), 위 화살표로 마지막 내 메시지 선택(관찰: 방금 쓴 메시지에서 위 화살표는 편집이 아니라 선택으로 동작 [R1])
3. 단축키 도움말 모달은 표 형태(i18n 키 필수).

## 2. 화면 흐름
1. Cmd+K -> 모달 열림, 입력창 포커스, "최근 방문" 목록 8개.
2. 글자 입력 -> 즉시 필터(클라이언트만, 이미 로드된 channels/dms/dmGroups/users 스토어 사용) -> 선택 하이라이트 첫 항목.
3. Enter -> `navigate('/c/:id' | '/d/:userId' | '/g/:groupId')` 후 모달 닫힘, 최근 방문에 기록(localStorage 키 한 개, 최대 20개).
4. 모달 밖 클릭 또는 Esc -> 닫힘, 포커스는 열기 전 요소로 복귀.
5. 사이드바 상단 "대화 찾기" 버튼/입력을 눌러도 같은 모달이 열린다.

## 3. 데이터 모델
없음(서버). 클라이언트: `localStorage['recentTargets']` = `[{ kind:'channel'|'dm'|'group', id }]`. 비밀 정보 없음. 사람 검색은 기존 사용자 목록 스토어 사용, 없으면 `GET /users` 기존 API.

## 4. API / 이벤트
추가 없음. 사람 항목을 고르면 DM 열기 규칙은 기존 `d/:userId`. Slack 네트워크 대응(추정): 서버 `search.modules` 계열을 쓰지만 우리는 로컬 필터로 충분.

## 5. 프런트엔드 / 관련 파일 (모두 신규 또는 AppLayout 소폭)
- 신규 `components/QuickSwitcher/QuickSwitcher.tsx`, `lib/fuzzy.ts`(점수 함수, 순수 함수라 단위 테스트), `hooks/useGlobalShortcuts.ts`, `components/Layout/ShortcutsHelpModal.tsx`, `stores/useUIStore.ts` 또는 기존 스토어에 `switcherOpen`.
- 수정: `components/Layout/AppLayout.tsx`(훅 호출과 모달 렌더), `components/Sidebar/Sidebar.tsx`(대화 찾기 버튼), `components/Messages/Message.tsx`·`MessageList.tsx`(선택된 메시지 상태, E/U/P 핸들러는 기존 useMessageActions 재사용).
- i18n: `quickSwitcher.*`, `shortcuts.*` 키를 ko 포함 모든 로캘 파일에 추가(`docs/architecture/i18n.md`).
- 접근성: 모달은 role="dialog" aria-modal, 목록은 role="listbox", 선택 항목 aria-activedescendant. 포커스 트랩.
- 주의: 기존 입력창(Quill)에서 E/U/P 같은 글자가 입력되므로 `event.target`이 input/textarea/contenteditable이면 무시.
- Mac/Windows 표기: `navigator.platform` 대신 `navigator.userAgent` 포함 여부로 Cmd/Ctrl 라벨 선택.

## 6. 완료 기준
- Cmd+K와 Ctrl+K 모두 모달을 연다. Esc로 닫으면 이전 포커스 복귀.
- "gen"을 입력하면 이름에 "general"이 있는 채널이 먼저 온다(퍼지 단위 테스트 5건 이상, 한글 이름 채널 포함).
- Enter로 채널/DM/그룹 DM 각각 올바른 경로로 이동(컴포넌트 테스트 3건).
- 입력창에 포커스가 있을 때 `e` 입력이 편집 단축키를 발동하지 않는다.
- `?`로 도움말 모달이 열리고 번역 키 누락이 없다(ko 100%).
- 프런트 `npm run lint`, `tsc`, 테스트 통과. 외부 https 요청 없음.
- CRUD 확인(개발자): 채널 생성 -> 전환기에서 찾기 -> 이름 변경(03) 후 목록 반영 -> 채널 삭제/보관 후 목록에서 사라짐 확인.
