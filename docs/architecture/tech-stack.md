# 기술 스택 분석: 무엇을 썼고 왜 썼는가

총괄이 직접 분석했다. slawk 쪽은 `app/`의 package.json, 설정 파일, 코드를 근거로 했고, Slack 쪽은 `docs/research/slack-architecture.md`(planner-2 조사, 출처 포함)를 근거로 했다. "이유"는 문서로 확인된 것과 코드에서 유추한 것을 구분해 적는다. REA 분석 결과(`docs/research/rea-slack-desktop.md`)가 나오면 갱신한다.

## 1. 프런트엔드
| 항목 | Slack | slawk (우리 기반) | 왜 그렇게 했나 | 우리 결정 |
|---|---|---|---|---|
| UI 프레임워크 | React (jQuery 클라이언트를 점진적으로 재작성, 2019년 배포) | React 19 | Slack: 거대한 레거시를 컴포넌트 단위로 바꾸려고(문서 확인). slawk: 가장 흔하고 Claude Code가 가장 잘 다루는 생태계(유추) | 유지 |
| 빌드 | (비공개) | Vite | 개발 서버가 빠르고 설정이 거의 없음(유추) | 유지 |
| 상태 관리 | Redux, 워크스페이스별 store | Zustand (스토어 11개) | Zustand는 보일러플레이트가 적고 소켓 이벤트를 스토어에서 바로 반영하기 쉬움(유추) | 유지. 멀티 워크스페이스는 워크스페이스 단위 슬라이스로 |
| 에디터 | 자체 리치 텍스트 | Quill 2 + Delta를 `<@id\|name>` 형식으로 직렬화 | 멘션과 서식을 Slack 같은 마크업으로 저장하려고(`lib/serializeDelta.ts`에서 확인) | 유지 |
| 스타일 | 자체 디자인 시스템 | Tailwind + cva + tailwind-merge (shadcn 방식) | 빠르게 UI를 찍어 내기 좋음(유추) | 유지. Slack 고유 색과 에셋은 쓰지 않음 |
| 실시간 | WebSocket (자체 Gateway Server) | socket.io-client | 재연결, room, ack가 내장돼 있음(유추) | 유지 |
| 데스크톱 | Electron (BrowserView, 2017년 전환) | 없음 | Slack: 웹 코드를 재사용하려고(문서 확인) | **추가**: Electron 셸 (`desktop/`) |
| E2E 테스트 | (비공개) | Playwright 60여 개 | 작성자가 QA 에이전트로 회귀 테스트를 돌림(`my_prompts/qa_agent.md`) | 유지 |

## 2. 백엔드
| 항목 | Slack | slawk | 왜 그렇게 했나 | 우리 결정 |
|---|---|---|---|---|
| 언어/런타임 | PHP에서 HHVM, Hack으로 전환. 실시간 계층은 Java, 큐 보조는 Go | Node.js + TypeScript(strict, ESM) | Slack: 성능(HHVM)과 타입 안정성(Hack) 때문에(문서 확인). slawk: 프런트와 언어를 하나로 맞추고 Socket.io를 같은 프로세스에서 돌리려고(유추) | 유지 |
| 웹 프레임워크 | 자체 | Express 5 | 익숙하고 미들웨어가 많음. 5에서 async 에러 처리가 개선됨(유추) | 유지 |
| 구조 | 웹앱(쓰기) + Channel/Gateway/Admin/Presence 서버(실시간) 분리 | 프로세스 하나(HTTP와 Socket.io가 같은 서버) | 작은 규모에서는 분리할 이유가 없음 | 유지. 원칙만 따른다: 쓰기는 HTTP, 알림은 소켓 |
| 검증 | (비공개) | zod 4 | 타입과 런타임 검증을 한 번에 함 | 유지, 모든 입력에 강제 |
| 인증 | 세션 쿠키, 엔터프라이즈는 SAML SSO | JWT(HS256) + tokenVersion, bcrypt | 웹과 소켓을 같은 토큰으로 인증하려고(코드 확인) | 유지. 엔터프라이즈 단계에서 OIDC/SAML 추가 |
| 큐/비동기 | Redis 큐 앞에 Kafka 버퍼 | `scheduler.ts`(프로세스 내부) | 규모가 작음 | 유지. 필요하면 PostgreSQL 기반 큐 |
| 파일 | 오브젝트 스토리지(추정) | 로컬 디스크 또는 GCS, sharp로 썸네일 | Cloud Run에 배포하려고(작성자 배포 스크립트 확인) | 유지. 로컬 디스크가 기본 |
| 푸시 | 모바일/데스크톱 푸시 | web-push(VAPID) | 브라우저 푸시 표준 | 유지. 데스크톱은 Electron Notification |

## 3. DB
| 항목 | Slack | slawk | 왜 그렇게 했나 | 우리 결정 |
|---|---|---|---|---|
| DB | MySQL. 워크스페이스 단위 샤딩에서 Vitess(채널 단위 샤딩)로 이전 | PostgreSQL 16 단일 | Slack: 큰 워크스페이스에 부하가 몰리고 샤드 하나가 죽으면 영향이 커서(문서 확인). slawk: 관계형이고 무료이며 전문 검색과 JSON을 지원함(유추) | 유지. 샤딩은 하지 않고, 모든 테이블에 workspaceId/channelId 키만 둠 |
| ORM | (비공개) | Prisma 5 (모델 15개) | 스키마 파일 하나로 타입과 마이그레이션을 만들어 줌 | 유지 |
| 메시지 키 | (channel, ts). ts는 채널 안에서 유일 | 자동 증가 Int id | 단순함 | 유지하되, 스레드와 순서용으로 `ts` 같은 정렬 키를 둘지는 01·04 파트에서 결정 |
| 검색 | SolrCloud | PostgreSQL LIKE/검색 라우트 | 규모가 작음 | 06 파트에서 tsvector와 pg_trgm(한국어)으로 개선. Solr와 Elastic은 메모리 때문에 쓰지 않음 |

## 4. 우리 프로젝트가 추가하는 것
- 데스크톱 앱: Electron + electron-builder (Windows exe, macOS dmg, Linux AppImage)
- CI/CD: GitHub Actions (테스트, 빌드, 릴리스), release-please
- 엔터프라이즈: 조직/멀티 워크스페이스, SSO, SCIM, 감사 로그, 보존 정책 (`enterprise-and-distribution.md`)
