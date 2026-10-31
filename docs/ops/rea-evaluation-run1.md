# REA 성능 평가 1회차 (Slack 데스크톱 앱 정적 분석)

작성: planner-1 / 2026-10-31 09:13~09:35 (약 22분). 대상: `/Applications/Slack.app` 4.53.276 (Electron 45.1.0, ASAR 9.8MB x2 + 3KB 스텁).
REA: `rea-agents@6.8.0`, Node 24.22.2, M2 8GB RAM(작업 중 여유 메모리 28~30%, 단계 "정상").
분석 결과 문서: `docs/research/rea-slack-desktop.md`.

## 1. 설치·연결 상태
- 스킬 `reverse-engineer-anything`은 정상 로드됨.
- **MCP 서버 `rea`의 도구가 이 서브에이전트 세션에 하나도 노출되지 않았다.** ToolSearch "rea", "+rea analyze_javascript_application" 모두 결과 없음. 원인 미진단(서브에이전트에는 MCP 도구가 전달되지 않는 구성일 가능성, 또는 등록 문제). `rea doctor`는 설정을 바꾸지 않는 진단이지만, 시간 상한 때문에 실행하지 않았다. 총괄 세션에서 `npx -y rea-agents@6.8.0 doctor --client claude_code --json`으로 확인할 것을 권장.
- 대체 수단: CLI `npx -y rea-agents@6.8.0 <command>`. 캐시가 있어 첫 실행도 수 초 안에 시작했다. 전역 `rea` 명령은 설치돼 있지 않다.
- MCP와 CLI의 차이: CLI에는 세션 내 retained Evidence가 없어서 후속 조회마다 97MB Evidence 파일을 다시 읽는다(1회 약 30초).

## 2. 사용한 REA 명령과 결과

| # | 명령 | 대상 | 결과 | 걸린 시간 | 비고 |
|---|---|---|---|---|---|
| 1 | `--help` | - | 성공 | 수 초 | 명령 100개 이상 노출 |
| 2 | `inspect-desktop-application` | Slack.app | 성공 | 9초 | Electron 후보 판정. 그런데 다음 단계로 **3KB 스텁 `app.asar`**를 추천하고 실제 코드인 `app-arm64.asar`는 추천하지 않음 |
| 3 | `inspect-electron-fuses` | Slack.app | 성공 | 12초 | fuse 9개를 슬라이스별로 정확히 해석. 이번 실행에서 가장 쓸모 있었던 결과 |
| 4 | `analyze-javascript-application --detail summary` | app-arm64.asar | **실패** | 3초 | `artifact_integrity_mismatch`: 언팩된 .node 파일의 무결성 해시가 선언과 다름(코드 서명으로 흔히 생김). 오류 메시지가 해결 옵션을 정확히 안내함 |
| 5 | 같은 명령 + `--integrity-policy record-and-continue --max-heap-mb 900` | app-arm64.asar | 부분 성공 | 약 4분 | 파일 790개, JS 534개 파싱, AST 88만 노드, findings 4992. **그러나 핵심인 `dist/main.bundle.cjs`(main 프로세스, 1.7MB)는 900MiB 힙 소진으로 미분석**. `preload.bundle.js`는 결과 예산 초과로 관계 정보 축소. Evidence 97MB |
| 6 | `inspect-analysis-view` (javascript-routes) | #5 Evidence | 성공(빈 결과) | 34초 | 라우트 0건. Electron 셸이라 예상된 결과 |
| 7 | `inspect-analysis-view` (javascript-facts, main.bundle.cjs) | #5 Evidence | 성공 | 29초 | 3행, 파일 인벤토리 수준 정보만(크기, 해시, 파싱 상태 skipped) |
| 8 | `analyze-javascript-application --source-path dist/main.bundle.cjs --max-heap-mb 1800` | main 번들 하나 | **실패** | 약 5분 | 1800MiB 힙도 소진. findings 0. 8GB 기기에서 더 올릴 수 없음 |
| 9 | (REA 아님) Evidence JSON 직접 집계 | #5 Evidence | - | 1분 | endpoint 32, network 14, event 63, listener 23 노드. 대부분 Sentry 계측과 node-pre-gyp 같은 의존성 코드. Slack 고유 동작 단서는 거의 없음 |

총 REA 실행 시간 약 11분, 그중 9분이 #5와 #8.

REA 요약 통계의 Electron 항목(#5): `browser_windows 0`, `preload_entrypoints 0`, `main_handlers 0`, `literal_channels 0`. 실제로는 BrowserWindow 생성 3곳, preload 4개, `redux-action` 같은 리터럴 IPC 채널이 있다(grep으로 확인). main 번들을 못 읽었고, 압축된(minified) 코드에서 별칭을 통한 Electron API 호출을 놓쳤기 때문이다. REA는 이를 "결과 없음은 부재가 아님"이라고 정직하게 표시한다.

## 3. REA 없이(grep/파일 읽기) 같은 걸 알 수 있었나

기준선 방법: ASAR 헤더를 읽어 파일을 꺼내는 30줄짜리 Python 스크립트(1초) + grep. 웹앱 관련은 Claude in Chrome 읽기 전용 관찰.

| 항목 | REA로 얻음 | grep/읽기로 얻음 | 비교 |
|---|---|---|---|
| Electron 판정 | 예 | 예 (Frameworks 폴더, Info.plist) | 동등 |
| Electron 버전 | 아니오 | 예 (Info.plist) | grep 우세 |
| Electron fuse 상태 | **예, 정확** | 어려움 (바이너리 sentinel 위치를 알아야 함) | **REA 우세** |
| 스텁 ASAR -> 아키텍처별 ASAR 분기 | 아니오 (오히려 스텁을 추천) | 예 (index.js 30줄 읽기) | grep 우세 |
| 파일 인벤토리, preload/HTML 목록 | 예 | 예 | 동등 |
| 네이티브 애드온 목록 | 예 (무결성 경고로 간접) | 예 (package.json) | 동등 |
| contextBridge 노출 이름 | 개수만 (2/3) | 이름까지 (`slackPlatform`, `desktop` 등) | grep 우세 |
| main 프로세스 창/IPC/딥링크/업데이트/알림/트레이 | **실패** (힙 소진) | 예 (이름 수준 전부) | grep 우세 |
| WebSocket 사용 여부(셸) | 예 ("request 추출 결과에 없음", 단 부재 증명은 아님) | 예 | 동등 |
| WebSocket 이벤트명, API 메서드, Flannel | 범위 밖 (웹앱이 원격) | Chrome 관찰로 확보 | REA 대상 아님 |
| 무결성 불일치 탐지 | **예** (서명된 .node 8개) | 직접 해시 계산해야 함 | REA 우세 (이번 질문엔 무관) |

## 4. 질문별 달성도

| 질문 | REA 단독 | 전체(REA+grep+Chrome) | 메모 |
|---|---|---|---|
| 1. 앱 구성 | 부분 | 완전 | REA는 fuse, 인벤토리, 렌더러 HTML 제공. 버전, 스텁 분기, 원격 웹앱 판단은 grep |
| 2. 실시간 | 실패 | 부분 | 셸에 소켓 없음은 REA도 시사. 이벤트명/호스트는 Chrome에서 이름 수준으로만. 프레임/페이로드 미관찰 |
| 3. 클라이언트 API | 실패 | 완전(이름 수준) | 셸 API 몇 개는 grep, 부트 호출과 Flannel은 Chrome |
| 4. 데스크톱 전용 기능 | 실패 | 완전(이름 수준) | main 번들 분석 실패로 REA 기여 없음 |
| 5. 설계 시사점 | 부분 | 완전 | 기존 문서의 "BrowserView 전환"을 현행 기준으로 반박한 근거는 grep |

## 5. 막힌 점과 에러
1. MCP 도구 미노출 (위 1절). 같은 문제가 반복되면 스킬 안내대로 `doctor` -> 재시작 순서로 진단해야 한다.
2. `artifact_integrity_mismatch` (Slack처럼 언팩 네이티브 모듈을 서명하는 앱은 항상 걸림). 해결: `--integrity-policy record-and-continue`. 메시지가 친절해서 1회 만에 해결.
3. `Owned JavaScript worker exhausted its 900 MiB V8 old-space heap ... dist/main.bundle.cjs` 및 1800MiB 재시도도 같은 오류. **1.7MB 압축 번들 하나를 8GB 기기에서 분석할 수 없다**는 것이 이번 평가의 가장 큰 한계.
4. 결과 예산 초과(`preload.bundle.js`): 관계 정보가 파일 노드에 축소 보관됨.
5. 출력이 매우 크고 장황하다(Evidence 97MB, 요약도 24KB 대부분이 limitations/unknowns). 필요한 이름을 찾으려면 결국 JSON을 직접 뒤져야 했다.
6. CLI 모드는 후속 뷰마다 Evidence 파일을 다시 검증해 30초씩 걸린다.
7. `trace-application-feature --schema`가 입력 형식을 보여 주지 않아(인자 하나 "inputJson"만) 시도하지 않았다.

## 6. 총평
**계속 쓸 가치: 낮음** (이 프로젝트 기준).

이유:
- 이 프로젝트가 알고 싶은 것(메시지 이벤트, API, 부트 흐름)은 데스크톱 셸이 아니라 원격 웹앱에 있다. REA의 JavaScript 분석은 로컬 ASAR만 대상으로 하므로 질문 2, 3에 구조적으로 닿지 못한다. 이 부분은 Chrome 관찰이 훨씬 빠르고 정확했다.
- 셸 분석에서도 핵심 파일(main 번들)을 8GB RAM에서 처리하지 못했다. 같은 정보를 30줄 스크립트 + grep이 2분 안에 이름 수준으로 다 찾았다.
- 확실히 나은 점은 fuse 해석, 무결성 검사, "관찰/추정/미확인"을 구분하는 Evidence 규율이다. 보안 점검용이면 의미가 있지만, 클론 구현에는 기여가 작다.
- 자원 비용이 크다: 분석 1회에 Node 워커 1~1.8GB 메모리, 9분, 디스크 110MB.

권장:
- 기본 분석 수단에서 REA를 빼고, Chrome 관찰 + 공식 문서 + 필요 시 grep으로 간다.
- 남겨 둘 경우 용도를 "Electron 보안 설정(fuse) 확인"이나 "버전 간 비교(`compare-application-versions`)"처럼 좁히고, 16GB 이상 기기에서만 전체 분석을 돌린다.
- 빼기 전에 한 번 더 확인할 것: 총괄 세션에서 MCP 경로(`analyze_javascript_application` + `inspect_analysis_view` retained 참조)가 CLI보다 빠른지. 힙 한계는 같을 것으로 예상(추정).

## 7. 기타
- CRUD 실습: 하지 않음. 메시지 전송은 사용자 본인의 채팅 승인이 필요한 동작으로 판단해 총괄 지시만으로 진행하지 않았다. Chrome에서는 페이지 로드와 리소스/스크립트 이름 집계만 했고, 쓰기 동작은 없었다(웹앱 자체가 로드 시 보내는 자동 요청은 제외).
- 스크래치패드 산출물(프로젝트 밖): `/private/tmp/claude-501/-Users-kwanhyun-Desktop-slack/a367a4c3-8550-465c-9b6f-b0850361386a/scratchpad/rea/out/` (Evidence JSON들), `/private/tmp/claude-501/-Users-kwanhyun-Desktop-slack/a367a4c3-8550-465c-9b6f-b0850361386a/scratchpad/rea/extract/` (ASAR 추출본). 프로젝트 폴더로 복사하지 않았다.
