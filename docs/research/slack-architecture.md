# Slack 본체 기술 구조 조사 (공개 기술 문서 기반)

작성: planner-2 / 2026-10-31. 방식: 공개 문서 조사. 출처가 직접 확인된 내용은 [출처 번호]로, 확인 못 한 내용은 **(추정)** 으로 표시한다. 워크스페이스 CRUD 실습은 이번에 수행하지 않았다(12절).

## 1. 백엔드 언어와 런타임
- 2014년 출시 때 백엔드는 PHP 5. 2016년에 HHVM으로 옮겼다. 이유는 "같은 PHP 코드가 더 빨리 돌아서". 이후 HHVM의 언어인 Hack을 계속 쓰게 됐다 [1].
- Hack 채택 이유: 정적 타입 검사(편집 중 즉시 오류), shapes(DB row, JSON 디코드 결과를 키가 정해진 타입 배열로 표현), async/await(스레드 없이 요청 내 동시성), PHP의 "수정 후 새로고침" 흐름 유지. 부분(partial) 모드로 파일 단위로 점진 이전했다 [1].
- HHVM 4.0(2018~2019)이 PHP 지원을 제거해 Slack은 PHP 코드를 전부 걷어냈다 [1].
- 구조: 크고 공유된 Hack 웹앱 코드베이스가 REST/Web API를 처리한다(공식 글은 "모놀리스"라 부르지 않음, 사실상 모놀리스형은 추정). 실시간 계층 핵심 서비스(Channel/Gateway/Admin/Presence)는 Java [2]. 잡 큐 주변 서비스(Kafkagate, JQRelay)는 Go [6].
- 시사점: 언어 자체가 아니라 "타입으로 계약을 강제"한 점이 핵심. 우리는 Node이므로 TypeScript가 대응.

## 2. DB와 샤딩
- 처음부터 전부 MySQL. 워크스페이스(팀) 단위 샤딩: 한 워크스페이스의 모든 데이터가 한 샤드. 샤드마다 서로 다른 데이터센터의 MySQL 2대, 비동기 복제 active-active. 별도로 워크스페이스ID->샤드 매핑 "metadata cluster", 워크스페이스에 속하지 않는 데이터용 "kitchen sink" 클러스터 [3].
- 문제: 큰 고객이 샤드 최대 하드웨어를 초과, 큰 고객 쪽만 핫스팟이고 나머지는 한가함, 샤드 장애 시 그 샤드의 모든 워크스페이스 중단, 샤딩 로직이 앱 코드에 얽힘 [3].
- 해결: Vitess(MySQL 위의 샤딩/운영 자동화 계층) 도입. 2016년 가을 검토 시작, 2017년 첫 프로토타입 이전, 2020년 말 트래픽 약 99% 이전. NoSQL/NewSQL을 배제한 이유는 수천 개 쿼리와 MySQL 고유 기능, 기존 운영 노하우 [3].
- 방향: 메시지 데이터는 워크스페이스 대신 **채널 ID로 샤딩**해 부하를 고르게 [3].
- 효과: 피크 약 230만 QPS(읽기 200만, 쓰기 30만), 중앙값 2ms, p99 11ms [3].
- 시사점: 데이터 모델에서 "워크스페이스 ID"와 "채널 ID"를 모든 테이블에 키로 갖고 있으면 훗날 샤딩이 가능. 지금 PostgreSQL 단일 인스턴스로 충분.

## 3. 실시간 메시징 구조 [2]
구성 요소(모두 Java, 인메모리):
- **Gateway Server(GS)**: 상태 있음. 사용자별 WebSocket 연결과 구독 보유. 클라이언트와 CS 사이 창구. 여러 지역에 배치되어 가까운 곳으로 접속.
- **Channel Server(CS)**: 상태 있음. 채널 ID를 consistent hashing 해서 각 CS가 일부 채널 담당. 채널 이력 일부를 메모리에 보유. 채널 이벤트를 구독 중인 모든 GS로 전달.
- **Admin Server(AS)**: 상태 없음. Webapp 백엔드와 CS 사이. 채널 ID로 담당 CS를 찾아 전달.
- **Presence Server(PS)**: 접속 상태 추적. 사용자 ID로 해시. 클라이언트는 GS를 통해 "화면에 보이는 사용자"만 조회/구독.
- **CHARM(consistent hash ring manager)**: CS 링 관리, 비정상 CS 교체(20초 내 새 CS 준비). Consul로 서비스 디스커버리. Envoy로 엣지 접속.

메시지 흐름:
1. 클라이언트가 **WebSocket이 아니라 HTTP Web API**(예: chat.postMessage)로 메시지를 보낸다. Hack Webapp이 검증, DB 저장 [2][8].
2. Webapp이 AS에 이벤트를 넘기고, AS가 채널 ID 해시로 담당 CS를 찾는다.
3. CS가 그 채널을 구독한 모든 GS에 전달.
4. 각 GS가 자기 WebSocket 클라이언트들에게 push (전 세계 약 500ms).
- 리액션, 북마크, 멤버 참여도 같은 경로. 타이핑 표시 같은 일시 이벤트는 저장 없이 같은 경로 [2].
- 접속: 부팅 시 Webapp에서 토큰과 WebSocket URL을 받고 가장 가까운 엣지 리전에 연결 -> GS가 사용자의 채널 목록을 로드해 CS들을 구독 [2].
- 순서 보장/재연결: 공식 글에 상세 설명 없음. 공개 API상 단서: 메시지 `ts`가 채널 내 단조 증가 식별자, 재연결 후 `conversations.history`로 `oldest` 이후를 다시 받아 빈 구간을 채우는 모델 (추정, Web API 문서 [8] 구조에서 유추). GS drain으로 장애 리전 사용자를 가장 가까운 정상 리전으로 이동 [2].
- 핵심 설계 원칙: "쓰기는 HTTP(DB가 진실), 읽기 갱신은 WebSocket(push)". 소켓은 알림 전용이므로 소켓이 끊겨도 데이터 손실이 없다.

## 4. 엣지 캐시와 클라이언트 부트 (Flannel) [4]
- 초기에는 `rtm.start`로 워크스페이스 전체 스냅샷(사용자, 채널, 멤버, 최근 메시지)을 받았다. 큰 워크스페이스에서 긴 로딩, 메모리 과다, 재연결 폭주 문제.
- 해결: **lazy loading + Flannel**. Flannel은 엣지 PoP에 있는 애플리케이션 수준 캐시. 사용자/채널/봇 등 팀 데이터를 캐시하고, 클라이언트 질의(퀵 스위처 자동완성 등)에 즉시 응답하며, 메시지에 멘션된 사용자 프로필처럼 곧 필요할 데이터를 선제 push. 같은 팀/리전의 사용자는 consistent hashing으로 같은 Flannel 인스턴스에 연결. Flannel이 본 리전과 WebSocket을 유지해 최신 상태 유지.
- 효과: 부트 페이로드 1.5K명 팀 7배, 32K명 팀 44배 감소. 피크 약 400만 동시 연결. 접속 상태는 pub/sub으로 바꿔 클라이언트가 받는 presence 이벤트 5배 감소 [4].
- 시사점: 클라이언트는 "채널 목록 + 최근 대화"만 먼저 받고 나머지는 필요할 때 요청.

## 5. 프런트엔드와 데스크톱 [5][9]
- 초기 웹 클라이언트(2012경): jQuery, Signals, DOM 직접 조작, 템플릿 수동 갱신. 로그인 시 워크스페이스 전체 데이터 다운로드, 워크스페이스마다 별도 Electron 프로세스 -> 메모리 과다 [5].
- 재작성(점진적): 2017경부터 이모지 피커를 시작으로 사이드바, 메시지 영역 순으로 React 전환. 2019년 7월 고객에게 배포. 규칙: 모든 새 UI는 React, 데이터는 "불완전하고 lazy 로딩된 모델"을 가정. **Redux**로 워크스페이스마다 독립 store(데이터, 연결 상태, WebSocket)를 두어 한 Electron 프로세스에서 다중 워크스페이스 처리. legacy-interop 계층으로 신구 코드 공존 [5]. 메모리 약 50% 감소, 로딩 약 33% 단축은 2차 보도 [9].
- 데스크톱: Electron(2016 macOS 시작). 2017년 Slack 3.0에서 webview -> BrowserView 전환 [9]. 데스크톱 앱은 사실상 웹 클라이언트를 감싼 셸. (REA 분석 결과는 별도.)
- 시사점: 상태 관리는 "워크스페이스 단위 store + 불완전한 데이터 가정". Zustand로 충분히 대응.

## 6. 검색, 비동기 큐, 파일
- **잡 큐**: Webapp이 Redis에 잡을 넣고 워커 풀이 폴링. 약 2016년 장애: DB 지연 -> 잡 적체 -> Redis 메모리 한계 -> enqueue/dequeue 모두 불능. 해결: **Kafka를 Redis 앞에 버퍼로 추가**(Kafkagate: HTTP->Kafka, JQRelay: Kafka->Redis, 둘 다 Go, 속도 제한 가능). 피크 하루 14억 잡, 초당 33,000 [6].
- **검색**: SolrCloud 기반이며 팀 단위 파티션, 인덱싱은 잡 큐 워커가 수행하고 별도 Java 서비스가 랭킹 (2차 자료 [7], 2016 QCon 자료 및 채용 공고 근거. 세부는 추정).
- **파일 저장**: 공식 자료 미확인. 오브젝트 스토리지(AWS S3) 사용이 일반적 (추정). 메시지에는 파일 ID만 참조.
- 시사점: "메시지 저장은 동기, 부수 효과(검색 인덱싱, 알림, 링크 미리보기)는 비동기 잡"이라는 분리가 핵심.

## 7. 메시지 데이터 모델 단서 (공개 API 문서 [8])
- `message` 이벤트 필드: `type:"message"`, `channel`, `user`, `text`, `ts`, `subtype`(선택), `attachments`, `edited`(`{user, ts}`, 원문은 보관 안 됨), `hidden`.
- **`ts`**: 문자열 "1700000000.000200" 형태(유닉스 초 + 마이크로초 6자리). 문서상 **채널 내에서 유일**한 식별자이자 정렬 키. 즉 (channel, ts)가 메시지 PK. 별도 UUID 없음 [8].
- `thread_ts`: 스레드 부모 메시지의 ts. 답글은 같은 채널 메시지이며 `thread_ts`로 부모를 가리킨다. 부모의 `reply_count`, `reply_users`, `latest_reply` 보유 (공식 문서 일반 내용, 이번 조사에서 해당 페이지는 직접 재확인 안 함 -> 추정 표시).
- 변경/삭제는 별도 이벤트가 아니라 `message` 이벤트의 **subtype**: `message_changed`(새 `message`와 `previous_message` 포함, 추정), `message_deleted`(`deleted_ts`, `event_ts`, `hidden:true`) [8]. 그 외 `channel_join` 등 시스템 메시지도 subtype.
- `event_ts`: 이벤트 발생 시각. `ts`와 별개. `client_msg_id`: 클라이언트가 생성하는 중복 방지 ID(추정).
- 리액션은 `reaction_added`/`reaction_removed` 이벤트, 스레드 답글 알림은 부모 메시지의 `message_changed`로도 반영됨 (추정).
- ID 체계: 접두사 + 영숫자(워크스페이스 `T`, 채널 `C`, 사용자 `U`, DM `D` 등). 분석 워크스페이스 URL의 T0757A9TZUJ, C0754D3UL21이 그 예.

## 8. 우리 클론에 주는 시사점 (8GB RAM 제약 고려)
현재 slawk: React19/Vite/Zustand/Quill, Express5/Socket.io/Prisma, PostgreSQL.

| 영역 | Slack | 제안 | 판단 |
|---|---|---|---|
| 백엔드 언어 | Hack(타입 강제) | Node + TypeScript 유지 | 그대로 유지 |
| DB | MySQL + Vitess 샤딩 | PostgreSQL 단일 유지. 모든 테이블에 workspaceId/channelId 키와 인덱스 보유 | 그대로 유지, 샤딩은 나중 |
| 메시지 ID | 채널 내 유일 ts | `(channelId, ts)` 형태를 모델에 도입(현재 slawk 방식은 총괄이 확인). 스레드는 `thread_ts` 대응 컬럼 | 바꿀 것(스키마 정렬) |
| 실시간 | GS/CS/AS/PS 분리 서비스 | Socket.io 단일 프로세스. 채널별 room으로 CS 역할, presence는 인메모리 Map. 다중 서버 필요해지면 Redis adapter | 그대로 유지 + 나중 |
| 쓰기 경로 | HTTP 저장 후 WebSocket push | 같은 원칙: REST로 저장, 커밋 후 room에 emit. 소켓은 알림 전용 | 바꿀 것(미적용이면) |
| 이벤트 이름 | message + subtype(changed, deleted), reaction_added 등 | 이벤트 타입명을 Slack과 맞춰 매핑 | 바꿀 것 |
| 재연결 | history 재조회로 빈 구간 보정 | 재연결 시 마지막 ts 이후 메시지 재요청 | 바꿀 것 |
| 부트 | Flannel + lazy loading | 부트 시 채널 목록과 최근 메시지만, 사용자/멤버는 필요 시 조회 | 나중에 고려(작은 규모에선 불필요) |
| 프런트 상태 | 워크스페이스별 Redux store | Zustand 유지, 워크스페이스 단위 슬라이스 | 그대로 유지 |
| 큐 | Redis + Kafka | 도입하지 않음. 필요 시 프로세스 내 큐 또는 PostgreSQL 기반 큐. Kafka/Redis는 메모리 부담 | 나중에 고려 |
| 검색 | Solr | PostgreSQL 전문 검색(tsvector/GIN, 한국어는 pg_trgm 병행) | 바꿀 것(Solr 금지급 메모리) |
| 파일 | 오브젝트 스토리지 | 로컬 디스크 업로드 + 메타 테이블, 필요 시 S3 호환(MinIO는 메모리 부담이라 보류) | 그대로 + 나중 |
| 데스크톱 | Electron 셸 | 웹 우선. Electron은 마지막 단계 | 나중에 고려 |

상위 5개 제안:
1. 쓰기는 REST, 알림은 Socket.io라는 분리 원칙을 고정하고 소켓 끊김 시 history 재조회로 복구.
2. 메시지 식별을 (channelId, ts)와 thread_ts로 정렬하고 수정/삭제를 message의 subtype 이벤트로 통일.
3. 검색은 PostgreSQL 전문 검색으로, 인덱싱은 쓰기 후 비동기(프로세스 내 큐)로.
4. 부트 시 전체 스냅샷을 피하고 lazy loading(사용자/채널 상세는 요청 시)을 처음부터 가정.
5. Kafka, Redis, Solr, Vitess는 도입하지 않고, 대신 workspaceId/channelId 키 설계로 훗날 확장 여지만 남김.

## 9. 신뢰도 메모
- 공식 확인: 1, 2, 3, 4, 5(재작성 이유), 6(잡 큐), 7의 message 필드/ts 정의.
- 2차 자료 의존: 5의 메모리 50%/로딩 33%, 6의 검색(Solr).
- 추정: 파일 저장소, thread_ts 세부, message_changed 페이로드, client_msg_id, 재연결 순서 보장 방식, 모놀리스 표현.
- 날짜 주의: 공식 글들은 2016~2020년 기준이라 현재 구조는 달라졌을 수 있다.

## 10. 출처
[1] https://slack.engineering/hacklang-at-slack-a-better-php/
[2] https://slack.engineering/real-time-messaging/
[3] https://slack.engineering/scaling-datastores-at-slack-with-vitess/
[4] https://slack.engineering/flannel-an-application-level-edge-cache-to-make-slack-scale/
[5] https://slack.engineering/rebuilding-slack-on-the-desktop/
[6] https://slack.engineering/scaling-slacks-job-queue/
[7] https://hasgeek.com/fifthelephant/2017/sub/search-infrastructure-slack-using-lambda-architect-ECTbWgMBsnyq6jVkBYM28E , https://qconsf.com/sf2018/sf2016/system/files/presentation-slides/how_slack_works_-_qcon_sf_2016.pdf
[8] https://docs.slack.dev/reference/events/message
[9] https://simonwillison.net/2019/Jul/22/when-a-rewrite-isnt-rebuilding-slack-on-the-desktop , https://www.infoq.com/news/2017/11/slack-browser-view-3

## 11. 비고
- 이 문서는 동작 방식 분석이며 Slack 코드나 에셋은 복사하지 않았다. 인증 정보는 기록하지 않았다.

## 12. CRUD 실습
- 수행하지 않음(시간 상한과 문서 조사 우선). 생성한 메시지가 없으므로 정리할 항목도 없다. message_changed, message_deleted의 실제 화면과 이벤트 확인은 후속 관찰 과제로 남긴다.
