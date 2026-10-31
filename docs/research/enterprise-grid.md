# Slack Enterprise Grid(조직과 멀티 워크스페이스) 조사

작성: planner-1, 2026-11-01. 대상 파트: E1 멀티 워크스페이스(`docs/specs/E1-multi-workspace.md`).
분석 수단: 공식 개발자 문서, 공식 도움말, Slack 엔지니어링 블로그. Claude in Chrome이 연결되지 않아 실제 워크스페이스 관찰은 하지 못했다. 관찰이 필요한 항목은 "브라우저 확인 필요"로 표시했다.
Slack의 코드, 디자인, 에셋은 가져오지 않았고 동작과 구조만 요약했다.

## 1. 출처

| # | 출처 | 요약에 쓴 내용 |
|---|---|---|
| R1 | [Enterprise organizations 개요 (docs.slack.dev)](https://docs.slack.dev/enterprise) | 조직은 워크스페이스 2개 이상의 묶음. 워크스페이스마다 자기 ID, 멤버 디렉터리, 채널, 대화, 파일. 사용자는 조직 전체에서 하나의 ID와 프로필 |
| R2 | [Developing apps for Enterprise orgs](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs) | `enterprise_id`, `team_id`, `context_team_id`, `enterprise_user{ id, enterprise_id, is_admin, is_owner, teams[] }`, 조직 단위 설치(`is_enterprise_install`), 일부 메서드는 `team_id` 필수 |
| R3 | [Unified Grid: How We Re-Architected Slack for our Largest Customers (Slack Engineering)](https://slack.engineering/unified-grid-how-we-re-architected-slack-for-our-largest-customers/) | 2017 Grid는 워크스페이스 샤드 + 조직 샤드(공유 채널 등 조직 데이터). 2023~2024 Unified Grid는 조직 단위 부트, 사용자의 모든 워크스페이스에 걸친 권한 헬퍼, 기존 테스트를 조직 컨텍스트로 다시 돌리는 병렬 통합 테스트 |
| R4 | [QCon SF 2024 발표 페이지](https://qconsf.com/presentation/nov2024/unified-grid-how-we-re-architected-slack-our-largest-customers), [InfoQ 발표](https://www.infoq.com/presentations/slack-rearchitecture) | R3와 같은 내용의 발표 |
| R5 | [admin.teams.create](https://docs.slack.dev/reference/methods/admin.teams.create) | 워크스페이스 생성: `team_domain`(21자 이내), `team_name`, `team_description`, `team_discoverability`(open, closed, invite_only, unlisted). 오류 `domain_taken`, `name_taken_in_org`, `not_an_admin` |
| R6 | [admin.users.assign](https://docs.slack.dev/reference/methods/admin.users.assign), [admin.users.remove](https://docs.slack.dev/reference/methods/admin.users.remove) | 조직 사용자를 워크스페이스에 넣고 빼기. `team_id`, `user_id`, `channel_ids`, `is_restricted`(게스트). 제거는 워크스페이스 멤버십만 지우며 조직 계정 비활성과 별개(문서가 계정 처리에 대해 명시하지 않음) |
| R7 | [admin.conversations.create](https://docs.slack.dev/reference/methods/admin.conversations.create) | 채널 생성 시 `team_id` 또는 `org_wide=true` 중 하나 필수(`team_id_or_org_required`). 이름 충돌 `name_taken` |
| R8 | [admin.conversations.setTeams](https://docs.slack.dev/reference/methods/admin.conversations.setTeams) | 채널을 다른 워크스페이스로 공유하거나 해제. `target_team_ids`, `org_channel`. 기본 조직 전체 채널은 해제 불가(`default_org_wide_channel`) |
| R9 | [Manage a workspace on Enterprise Grid (도움말)](https://slack.com/help/articles/115005225987) | 워크스페이스 접근 수준 4가지(Open, By Request, Invite Only, Hidden). 조직 관리자가 잠근 설정은 워크스페이스에서 못 바꾼다. 채널을 워크스페이스 사이로 옮기려면 양쪽 관리자 권한 필요 |
| R10 | [Types of roles in Slack (도움말)](https://slack.com/help/articles/201912948) | 조직 주 소유자(1명, 소유권 이전 가능), 조직 소유자, 조직 관리자. 워크스페이스마다 워크스페이스 소유자·관리자. 조직 소유자가 모든 워크스페이스의 관리자인 것은 아니다 |
| R11 | [Audit Logs API](https://docs.slack.dev/admins/audit-logs-api) | 감사 로그는 조직 전체 단위. 항목의 `context.location.type`은 `workspace` 또는 `enterprise`이고 해당 id·도메인이 붙는다 |
| R12 | [Slack Connect 도움말](https://slack.com/help/articles/115004151203) | 외부 조직과의 채널. 채널을 만든 조직이 소유(초대·제거·게시 권한 관리) |

## 2. 구조 요약

### 2.1 계층
```
Enterprise(조직, E...)  ── 조직 정책(SSO, 2FA, 보존, DLP, eDiscovery, 감사 로그, 앱 허용)
  ├─ Workspace(T...)     ── 자기 채널·멤버 디렉터리·워크스페이스 설정(조직이 잠그지 않은 것)
  ├─ Workspace(T...)
  └─ 조직 데이터           ── 조직 공유 채널, 조직 전체 채널, 사용자 계정
User(W.../U...)          ── 조직에 하나. enterprise_user.teams[]에 속한 워크스페이스 목록
```
- 사용자 ID와 프로필은 조직 전체에서 하나다(R1, R2). 워크스페이스 멤버십은 조직 계정 위의 관계다(R6의 assign/remove).
- 워크스페이스 멤버 목록은 항상 조직 멤버 목록의 부분집합이다(R10).
- 채널은 원래 한 워크스페이스에 속하고, 공유하면 여러 워크스페이스에 동시에 보인다(R8). 조직 전체 채널(`org_channel`)은 모든 워크스페이스에 보인다.

### 2.2 ID와 범위 지정
- 개발자 API에서는 `team_id`로 대상 워크스페이스를 고른다. 조직 단위 토큰이면 일부 메서드에서 필수(R2). 단일 워크스페이스 토큰에 `team_id`를 줘도 무시된다.
- 공유 채널에서 일어난 이벤트는 `context_team_id`(보는 사람의 워크스페이스)와 `source_team`(발생 워크스페이스)로 구분한다(R2).
- 우리 클론에 주는 시사점: 리소스 id(채널, 메시지)는 전역 정수라 리소스로부터 워크스페이스를 역산할 수 있다. 목록·생성처럼 대상이 없는 요청만 "현재 워크스페이스"를 따로 받으면 된다. 이것은 R3의 "워크스페이스 라우팅에 의존하지 않는 엔드포인트는 그대로 동작, 특정 워크스페이스에 쓰는 엔드포인트는 사용자가 선택"과 같은 분류다.

### 2.3 역할
| 단위 | 역할 | 비고 |
|---|---|---|
| 조직 | 주 소유자(1명), 소유자, 관리자 | 조직 정책, 워크스페이스 생성·삭제, 사용자를 워크스페이스에 배정(R5, R6, R10) |
| 워크스페이스 | 소유자, 관리자, 멤버, 게스트(다중·단일 채널) | 자기 워크스페이스의 설정·초대·채널 관리(R9). 게스트 여부는 워크스페이스 배정 시 정한다(R6 `is_restricted`) |
| 채널 | 채널 관리자 | E8 범위 |
- 공유 채널의 관리 권한은 "공유받은 워크스페이스 중 하나의 관리자이거나 조직 관리자"로 계산한다(R3 권한 헬퍼 예시).

### 2.4 공유 채널 두 종류
| 구분 | 조직 내부 공유 채널(멀티 워크스페이스 채널) | Slack Connect |
|---|---|---|
| 범위 | 같은 조직의 여러 워크스페이스 | 서로 다른 조직(R12) |
| 저장 | 조직 데이터(조직 샤드, R3) | 소유 조직이 관리, 상대 조직은 참여 |
| 관리 | 조직 관리자 또는 양쪽 워크스페이스 관리자(R8, R9) | 소유 조직만 초대·제거·게시 권한 관리 |
| 우리 범위 | **E1에서 구현** | **범위 밖**(자체 호스팅 서버 사이 연합이 필요. 후속 검토) |

### 2.5 거버넌스는 조직 단위
- 감사 로그는 조직 단위이고, 항목마다 발생 위치(워크스페이스 또는 조직)가 붙는다(R11).
- 조직 관리자가 잠근 설정은 워크스페이스에서 못 바꾼다(R9). 즉 설정은 "조직 기본값 + 잠금 여부 + 워크스페이스 재정의" 구조다.
- DLP, eDiscovery, 법적 보존은 조직 단위 기능으로 소개된다(도움말 요금제 비교, R1). 상세 범위는 "브라우저 확인 필요"(관리 콘솔 화면을 보지 못했다).

### 2.6 클라이언트
- 2017 Grid 클라이언트는 워크스페이스마다 별도 데이터 저장소와 로그인 세션을 두고 전환했다. Unified Grid는 조직 단위로 한 번 부트하고 모든 워크스페이스의 채널을 한 화면에 보여 준다(R3).
- 우리 클론은 한 서버에 한 번 로그인하고(조직 계정), 왼쪽 워크스페이스 전환기로 "현재 워크스페이스"를 바꾸는 방식을 택한다. 소켓 연결은 하나이고 이벤트에 워크스페이스 id를 실어 클라이언트가 거른다. 웹 URL의 실제 모양(`/client/<team_id>/<channel_id>`)은 분석 대상 URL `app.slack.com/client/T0757A9TZUJ/C0CDUKV338U`에서 확인된다: 경로에 워크스페이스 id가 먼저 오고 그 뒤에 채널 id가 온다.

## 3. CRUD 흐름 추적(공식 API 예시 기반, 브라우저 실습 대체)
쓰기 실습은 이번에 하지 않았다. 아래는 공식 메서드 문서의 요청·응답으로 추적한 흐름이다.

| 단계 | 메서드(근거) | 요청 핵심 | 응답·오류 | 클론에 반영 |
|---|---|---|---|---|
| 워크스페이스 C | `admin.teams.create`(R5) | `team_domain`, `team_name`, `team_discoverability` | `{ ok, team }`, `domain_taken`, `name_taken_in_org`, `not_an_admin` | `POST /org/workspaces` slug·이름 조직 내 유일, 조직 관리자만 |
| 워크스페이스 R | `admin.teams.list`, `team.info` | (`team_id`) | 이름, 도메인, 접근 수준 | `GET /workspaces`(내 것), `GET /org/workspaces`(관리) |
| 워크스페이스 U | `admin.teams.settings.setName` 등 | `team_id`, 값 | | `PATCH /org/workspaces/:id` |
| 워크스페이스 D | 공개 API에 삭제 메서드 없음(브라우저 확인 필요) | | | 하드 삭제 대신 보관(`archivedAt`). 데이터는 보존 |
| 멤버 C | `admin.users.assign`(R6) | `team_id`, `user_id`, `is_restricted`, `channel_ids` | `user_already_team_member`, `team_not_found` | `POST /workspaces/:id/members` 역할·기본 채널 지정 |
| 멤버 U | `admin.users.setAdmin`/`setRegular`/`setOwner` | `team_id`, `user_id` | | `PATCH /workspaces/:id/members/:userId` |
| 멤버 D | `admin.users.remove`(R6) | `team_id`, `user_id` | `cannot_modify_primary_owner` | `DELETE /workspaces/:id/members/:userId`: 그 워크스페이스 채널에서만 빠지고 조직 계정은 유지 |
| 채널 C | `admin.conversations.create`(R7) | `name`, `is_private`, `team_id` 또는 `org_wide` | `team_id_or_org_required`, `name_taken` | `POST /channels`는 현재 워크스페이스에 생성. 이름은 워크스페이스 안에서 유일 |
| 채널 공유 U | `admin.conversations.setTeams`(R8) | `channel_id`, `target_team_ids`, `org_channel` | `default_org_wide_channel` | `PUT /channels/:id/workspaces` |
| 채널 공유 D | `setTeams`에서 대상 제외 | | | 제외된 워크스페이스에서만 사라지고 메시지는 남음 |

## 4. 확인하지 못한 것(브라우저 확인 필요)
- 공유 채널을 해제할 때 그 워크스페이스에만 속한 멤버가 채널에서 자동으로 빠지는지, 남아서 읽기만 되는지.
- 워크스페이스에서 제거된 사용자가 그 워크스페이스 사람들과 나눈 DM을 계속 볼 수 있는지(Unified Grid 이후 DM은 조직 단위로 보인다는 추정만 있다).
- 검색 기본 범위(현재 워크스페이스 vs 모든 워크스페이스)와 전환 UI.
- 워크스페이스 전환기에서 각 워크스페이스의 안 읽음 표시 방식.
