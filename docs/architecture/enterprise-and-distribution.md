# 엔터프라이즈 기능과 배포 구조 (웹 + 데스크톱 exe)

## 1. 전체 구조 (모노레포)
```
slack/
  app/backend/     Express + Socket.io + Prisma API 서버 (웹 프런트 정적 파일도 서빙)
  app/frontend/    React SPA (웹에서 동작, 데스크톱 앱도 같은 화면을 띄움)
  app/desktop/     Electron 셸 (새로 만듦, D1)
  .github/workflows/  ci.yml (PR 테스트), release.yml (태그 시 빌드와 업로드)
  docs/
```
- **웹**: 사용자가 브라우저로 서버 주소에 접속한다. 배포는 `app/Dockerfile` 하나(프런트 빌드 결과를 백엔드가 서빙)로 한다.
- **데스크톱**: Slack 데스크톱 앱과 같은 방식으로, 설치 파일 안에 서버를 넣지 않고 **서버 주소(워크스페이스 URL)를 띄우는 Electron 셸**로 만든다. 처음 실행하면 서버 주소를 입력받고, 이후에는 기억한다. 화면 코드는 웹과 100% 공유한다.
  - 장점: 기능을 추가하면 웹과 데스크톱에 한 번에 반영되고, 앱을 다시 배포할 필요가 적다.
  - 데스크톱에서만 하는 일은 preload의 `window.desktop` API로 노출한다: 네이티브 알림, 작업 표시줄과 독 배지 숫자, 트레이, 딥링크(`teammessenger://`), 자동 업데이트, 시작 시 실행.

## 2. 데스크톱 빌드와 업로드
| 대상 | 산출물 | 빌드 위치 |
|---|---|---|
| Windows | NSIS 설치 파일 `TeamMessenger-Setup-x.y.z.exe`, 포터블 `TeamMessenger-x.y.z-portable.exe` | GitHub Actions `windows-latest` |
| macOS | `.dmg` (arm64, x64) | `macos-latest` (로컬 M2에서도 가능) |
| Linux | `.AppImage` | `ubuntu-latest` |

- 도구: electron-builder, electron-updater
- 흐름: `v*` 태그를 푸시하면 `release.yml`이 세 OS에서 빌드하고, GitHub Releases(https://github.com/KWANHYUNKIM/slack/releases)에 설치 파일과 `latest.yml`(자동 업데이트용)을 올린다.
- 코드 서명: 인증서가 없으면 Windows SmartScreen 경고, macOS Gatekeeper 경고가 뜬다. 처음에는 서명 없이 배포하고, 릴리스 노트에 "추가 정보, 실행"으로 여는 방법을 적는다. 인증서를 구하면 CI 시크릿에 넣는다.
- 로컬 M2 Mac에서 Windows exe를 직접 빌드하지 않는다(wine이 필요하고 메모리를 많이 씀). CI에서 빌드한다.
- 보안 설정은 `docs/security/nodejs-security.md` 9절을 따른다.

### 웹 배포: 빌드와 실행
- 이미지: `app/Dockerfile`은 공개 이미지 `node:24-slim`만 쓰는 3단계 멀티스테이지다. 프런트 빌드, 백엔드 빌드(`npm ci` 한 번, `prisma generate`, `tsc`, `npm prune --omit=dev`), 런타임 순서이고 npm ci, apt, prisma generate는 각각 한 번만 돈다. prisma CLI는 `migrate deploy`를 위해 `dependencies`에 있다. 런타임은 비 root(`node`), `NODE_ENV=production`, dev 의존성 제외, `/health` HEALTHCHECK를 갖는다. 프런트 dist는 `public/`에 넣어 백엔드가 서빙한다. 사설 base 이미지와 GCP 의존은 없다.
- 빌드: `docker build -t slackclone ./app`
- 실행: `cd app && cp .env.example .env`(JWT_SECRET, POSTGRES_PASSWORD 채우기, 생성: `openssl rand -hex 32`) 후 `docker compose up -d --build`. 접속은 `http://localhost:8080`. 업로드와 DB는 named volume(`uploads`, `pgdata`)에 저장된다.
- DB 연결: compose는 `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`를 넘기고, `entrypoint.sh`가 `node dist/ops/cli.js database-url`로 `DATABASE_URL`을 조합한다. 비밀번호의 특수문자는 퍼센트 인코딩된다. `DATABASE_URL`을 직접 주면 그대로 쓴다.
- 마이그레이션: 시작할 때 `prisma migrate deploy`를 실행한다. DB 연결 실패(P1001, P1002, P1017)만 최대 15회 재시도하고, 마이그레이션 오류(P3009, P3018 등)와 그 밖의 오류는 `migrate status`를 출력하고 바로 종료한다. 판정 코드는 `backend/src/ops/migrateErrors.ts`.
- 프록시와 TLS: 운영은 TLS 리버스 프록시(nginx, Caddy 등) 뒤에 두고 `PUBLIC_URL=https://...`, `TRUST_PROXY=1`로 설정하는 것을 권장한다. `TRUST_PROXY`는 프록시 홉 수이며 기본 0(신뢰 안 함)이다. 프록시 없이 직접 열면 0으로 둬야 `X-Forwarded-For` 위조로 rate limit을 피할 수 없다. 프록시 뒤인데 0이면 모든 요청이 프록시 IP 하나로 세어진다. `PUBLIC_URL`이 `http://`이면 HSTS, CSP `upgrade-insecure-requests`, socket.io 쿠키의 secure 속성을 끈다. 이는 LAN 시험용이고 인터넷에 공개하는 용도가 아니다. 기본(비어 있음 또는 https)은 https 전제다.
- 허들 STUN/TURN: 내장 STUN은 기본 켜짐이고 compose가 `3478/udp`를 공개한다. 끄려면 `STUN_ENABLED=false`(포트 공개 줄도 지운다). 원격 접속자가 쓰려면 `STUN_PUBLIC_HOST`에 공인 호스트를, 필요하면 `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`을 설정한다.
- 첫 사용자: 이미지에는 시드(tsx, dev 의존성)가 없고 `RUN_SEED`도 없다. 첫 OWNER는 CLI(`feat/bootstrap-owner` 파트, 별도 PR)로 만든다.
  - 빈 DB로 처음 띄운 뒤 `docker compose exec app node dist/scripts/create-owner.js --email <이메일> --name <이름>`을 실행한다(compose 서비스 이름은 `app`). 비밀번호는 숨김 프롬프트로 입력한다.
  - 사용자가 1명이라도 있으면 거부된다. 그다음 사용자는 OWNER가 관리 화면에서 만든 초대로 가입한다.
  - 비대화형(스크립트)에서는 `docker compose exec -T app ...`에 stdin 파이프를 쓴다. 비밀번호를 환경 변수(`BOOTSTRAP_OWNER_*`)로 넘기면 `docker inspect`에 보이므로 가능하면 비워 두고, 썼다면 `.env`에서 지우고 컨테이너를 다시 만든다.
- GCP 배포 스크립트는 `app/deploy/gcp/`에 선택 사항으로 남겼다(이 저장소를 clone하고 `app/`을 빌드 컨텍스트로 쓴다). 예전 하드코딩 trust proxy 1 값은 그 README와 `cloudbuild.yaml`(`TRUST_PROXY=1`)에 적었다.


## 3. 엔터프라이즈 기능 (Slack Enterprise Grid를 참고해 직접 설계)
slawk에는 이미 역할(OWNER/ADMIN/MEMBER/GUEST), 감사 로그(AuditLog), 초대 링크, 관리자 패널이 있다. 그 위에 쌓는다.

| 기능 | 내용 | 가능 여부 | 선행 파트 | 모델 |
|---|---|---|---|---|
| E1 조직과 멀티 워크스페이스 | Organization 하나에 Workspace 여러 개. 사용자는 조직 계정 하나로 여러 워크스페이스에 참여. 워크스페이스 사이 공유 채널 | 가능(규모가 커서 3루프 이상으로 분할) | 18 | opus |
| E2 SSO | OIDC(Google, Azure AD, Okta) 먼저, 그다음 SAML 2.0. 조직 단위로 SSO 강제 | 가능 | 19 | opus |
| E3 SCIM 2.0 프로비저닝 | `/scim/v2/Users`, `/Groups` CRUD. IdP에서 입사자 생성, 퇴사자 비활성화 | 가능 | E1, E2 | sonnet |
| E4 감사 로그 강화 | 로그인, 권한 변경, 내보내기, 삭제 기록. 조회 UI, 필터, CSV/JSON 내보내기, 보존 기간 | 가능(기존 AuditLog 확장) | 없음 | sonnet |
| E5 데이터 보존 정책 | 채널·워크스페이스별 "N일 후 삭제" 정책과 스케줄러 | 가능 | 소프트 삭제 규칙 | sonnet |
| E6 법적 보존과 eDiscovery | 특정 사용자의 데이터를 보존 정책에서 제외하고 검색해 내보냄 | 가능 | E4, E5 | opus |
| E7 세션 관리 | 기기별 세션 목록, 강제 로그아웃(tokenVersion), 세션 유효 시간 정책, 2FA 강제 | 가능 | 19 | sonnet |
| E8 관리자 역할 세분화 | 조직 소유자, 조직 관리자, 워크스페이스 관리자, 채널 관리자 | 가능 | E1 | sonnet |
| E9 정보 장벽 | 지정한 그룹끼리 DM과 채널 공유를 차단 | 가능(후순위) | E1, 14(사용자 그룹) | opus |
| E10 DLP | 메시지 패턴(카드 번호 등) 탐지와 차단·경고 | 부분적으로 가능(정규식 규칙) | 01 | sonnet |
| E11 EKM(고객 관리 키 암호화) | 고객이 관리하는 키로 메시지 암호화 | 나중에(KMS 연동이 필요하고 검색과 충돌) | - | - |

## 4. 진행 순서 제안
1. P0 메신저 기본 파트(01 → 03 → 02, 04, 05)
2. 기반: CI(`ci.yml`), 기준 테스트 실패 6건 수정, 데스크톱 셸 최소 버전(D1)
3. P1 파트와 E4(감사 로그), E7(세션)을 병행
4. E1 멀티 워크스페이스(가장 큰 스키마 변경이라 단독으로) → E2 → E3 → E5 → E6 → E8
5. 릴리스 자동화(release.yml, release-please)와 첫 데스크톱 릴리스
