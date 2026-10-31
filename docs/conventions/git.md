# 형상관리 규칙 (Git)

2026년 기준으로 많이 쓰는 방식인 **GitHub Flow + Conventional Commits + Squash Merge + 자동 릴리스**를 따른다.

## 1. 브랜치 전략: GitHub Flow
- `main`은 항상 배포할 수 있는 상태로 둔다. `main`에 직접 커밋하지 않는다(초기 설정 커밋 제외).
- 모든 작업은 `main`에서 브랜치를 따서 PR로 합친다. 오래 사는 `develop` 브랜치는 두지 않는다(Git Flow는 쓰지 않음).
- 브랜치는 짧게 유지한다. 한 파트에 브랜치 하나, 머지 후 삭제.

### 브랜치 이름
`<타입>/<파트번호>-<짧은-설명>` (소문자, 하이픈)

| 타입 | 용도 | 예 |
|---|---|---|
| `feat/` | 새 기능 | `feat/01-mentions-activity` |
| `fix/` | 버그 수정 | `fix/baseline-failing-tests` |
| `refactor/` | 동작 변화 없는 구조 개선 | `refactor/socket-event-names` |
| `perf/` | 성능 개선 | `perf/message-list-virtualize` |
| `security/` | 보안 패치 | `security/rate-limit-ipv6` |
| `docs/` | 문서 | `docs/conventions` |
| `test/` | 테스트만 추가/수정 | `test/websocket-reconnect` |
| `chore/` | 설정, 의존성, 잡일 | `chore/bump-prisma` |
| `ci/`, `build/` | CI, 빌드/패키징 | `build/desktop-electron` |
| `hotfix/` | 릴리스 후 긴급 수정 | `hotfix/login-crash` |

## 2. 커밋 메시지: Conventional Commits 1.0
```
<type>(<scope>): <요약>

<본문: 무엇을 왜 바꿨는지>

<꼬리말: BREAKING CHANGE, Refs #이슈, Co-Authored-By>
```
- `type`: `feat` `fix` `refactor` `perf` `security` `docs` `test` `chore` `ci` `build` `revert`
- `scope`: `backend` `frontend` `desktop` `db` `ws` `auth` `docs` 등
- 요약은 한국어로 쓰고, 명령형으로 짧게(50자 안팎) 쓴다. 마침표는 붙이지 않는다.
- 호환이 깨지는 변경은 `feat(api)!:`처럼 `!`를 붙이고, 꼬리말에 `BREAKING CHANGE:`를 쓴다.

**예전 방식(add/update/fix)과 대응**
| 예전 | 지금 |
|---|---|
| `add: 멘션 기능` | `feat(backend): 서버 멘션 파싱과 Activity 저장` |
| `update: 채널 화면` | 기능 추가면 `feat(frontend): ...`, 구조 변경이면 `refactor(frontend): ...`, 속도 개선이면 `perf: ...` |
| `fix: 로그인 오류` | `fix(auth): 만료 토큰 재발급 실패 수정` |

## 3. PR 규칙
- PR 제목도 Conventional Commits 형식으로 쓴다. squash merge를 하면 PR 제목이 그대로 `main`의 커밋 메시지가 된다.
- 본문은 `.github/pull_request_template.md`를 따른다(관련 스펙, 변경 내용, CRUD 확인 내역, 테스트 결과, 보안 체크).
- 한 PR에는 한 파트만 담는다. 변경이 800줄을 넘으면 쪼갠다(lockfile, 마이그레이션 SQL 제외).
- 머지 방식은 **squash merge만** 쓴다. 머지 후 브랜치는 삭제한다.
- 머지 조건: CI 통과, 총괄 리뷰 승인, 충돌 없음.

## 4. 리뷰 (총괄)
- 개발자가 파트를 끝내면 총괄이 브랜치를 만들어 커밋하고 PR을 연다. 개발자 에이전트는 직접 커밋하거나 푸시하지 않는다.
- 총괄은 PR마다 `/code-review`로 리뷰한다(보통 `medium`, 스키마·보안·인증 변경은 `high`).
- 리뷰 결과는 PR 코멘트로 남긴다. 고칠 것이 있으면 같은 개발자에게 되돌려 수정시킨다.
- 체크 항목: 스펙의 완료 기준 충족, 테스트 통과(실패를 숨기지 않았는지), `docs/security/nodejs-security.md` 체크리스트, 스타일 규칙(`frontend.md`, `backend.md`), 다른 파트 파일 침범 여부.

## 5. 버전과 릴리스
- 버전은 SemVer(`vMAJOR.MINOR.PATCH`)를 따르고, `feat`이면 MINOR, `fix`이면 PATCH, `!`이면 MAJOR를 올린다.
- 릴리스는 release-please로 자동화한다. 커밋 기록으로 CHANGELOG와 릴리스 PR을 만든다.
- `v*` 태그가 붙으면 CI가 웹 Docker 이미지와 데스크톱 설치 파일(Windows `.exe`, macOS `.dmg`, Linux `.AppImage`)을 빌드해 GitHub Releases에 올린다(`docs/architecture/enterprise-and-distribution.md` 참고).

## 6. 금지
- `main`에 force push 금지. 비밀 정보(.env, 키, 토큰) 커밋 금지. 공개 저장소라 한 번 올라가면 회수할 수 없다.
- 생성물(`node_modules`, `dist`, 설치 파일)은 커밋하지 않는다. 설치 파일은 Releases에만 올린다.
