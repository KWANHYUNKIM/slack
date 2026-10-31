# 엔터프라이즈 기능과 배포 구조 (웹 + 데스크톱 exe)

## 1. 전체 구조 (모노레포)
```
slack/
  app/backend/     Express + Socket.io + Prisma API 서버 (웹 프런트 정적 파일도 서빙)
  app/frontend/    React SPA (웹에서 동작, 데스크톱 앱도 같은 화면을 띄움)
  desktop/         Electron 셸 (새로 만듦)
  .github/workflows/  ci.yml (PR 테스트), release.yml (태그 시 빌드와 업로드)
  docs/
```
- **웹**: 사용자가 브라우저로 서버 주소에 접속한다. 배포는 `app/Dockerfile` 하나(프런트 빌드 결과를 백엔드가 서빙)로 한다.
- **데스크톱**: Slack 데스크톱 앱과 같은 방식으로, 설치 파일 안에 서버를 넣지 않고 **서버 주소(워크스페이스 URL)를 띄우는 Electron 셸**로 만든다. 처음 실행하면 서버 주소를 입력받고, 이후에는 기억한다. 화면 코드는 웹과 100% 공유한다.
  - 장점: 기능을 추가하면 웹과 데스크톱에 한 번에 반영되고, 앱을 다시 배포할 필요가 적다.
  - 데스크톱에서만 하는 일은 preload의 `window.desktop` API로 노출한다: 네이티브 알림, 작업 표시줄과 독 배지 숫자, 트레이, 딥링크(`slackclone://`), 자동 업데이트, 시작 시 실행.

## 2. 데스크톱 빌드와 업로드
| 대상 | 산출물 | 빌드 위치 |
|---|---|---|
| Windows | NSIS 설치 파일 `SlackClone-Setup-x.y.z.exe`, 포터블 `.exe` | GitHub Actions `windows-latest` |
| macOS | `.dmg` (arm64, x64) | `macos-latest` (로컬 M2에서도 가능) |
| Linux | `.AppImage` | `ubuntu-latest` |

- 도구: electron-builder, electron-updater
- 흐름: `v*` 태그를 푸시하면 `release.yml`이 세 OS에서 빌드하고, GitHub Releases(https://github.com/KWANHYUNKIM/slack/releases)에 설치 파일과 `latest.yml`(자동 업데이트용)을 올린다.
- 코드 서명: 인증서가 없으면 Windows SmartScreen 경고, macOS Gatekeeper 경고가 뜬다. 처음에는 서명 없이 배포하고, 릴리스 노트에 "추가 정보, 실행"으로 여는 방법을 적는다. 인증서를 구하면 CI 시크릿에 넣는다.
- 로컬 M2 Mac에서 Windows exe를 직접 빌드하지 않는다(wine이 필요하고 메모리를 많이 씀). CI에서 빌드한다.
- 보안 설정은 `docs/security/nodejs-security.md` 9절을 따른다.

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
