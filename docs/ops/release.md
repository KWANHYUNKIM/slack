# 릴리스 운영 (D2)

구조: `docs/architecture/enterprise-and-distribution.md` 2절, 규칙: `docs/conventions/git.md` 5절

## 흐름
```
main에 feat/fix 머지 -> release-please.yml이 "chore: release 0.2.0" PR 생성(app/desktop/package.json 버전 + CHANGELOG)
-> 그 PR을 머지 -> 태그 v0.2.0 + GitHub Release 생성 -> release.yml 호출
-> prepare(태그 형식, package.json 버전 일치) -> build(windows, macos, linux) -> publish(Releases에 업로드)
```
- 태그를 직접 푸시해도(`git tag v0.2.0 && git push origin v0.2.0`) `release.yml`이 돈다. 이때 package.json의 version이 태그와 같아야 한다(다르면 prepare에서 실패).
- `v1.2.3-rc.1`처럼 `-`가 붙은 태그는 프리릴리스로 올라간다.

## 산출물
| OS | 파일 |
|---|---|
| Windows | `TeamMessenger-Setup-x.y.z.exe`(nsis), `TeamMessenger-x.y.z-portable.exe` |
| macOS | `TeamMessenger-x.y.z-arm64.dmg`, `TeamMessenger-x.y.z-x64.dmg` |
| Linux | `TeamMessenger-x.y.z-x64.AppImage` |
| 공통 | `SHA256SUMS.txt` |

## 서명 시크릿 (이름만 적는다. 값은 저장소 Settings > Secrets and variables > Actions에만 넣는다)
| 시크릿 | 용도 | 없을 때 |
|---|---|---|
| `CSC_LINK` | 코드 서명 인증서(.p12/.pfx)의 base64 | 서명 없이 빌드 |
| `CSC_KEY_PASSWORD` | 위 인증서 비밀번호 | 서명 없이 빌드 |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization | 서명만 하고 notarization은 건너뜀 |

- `CSC_LINK`와 `CSC_KEY_PASSWORD`가 둘 다 있어야 서명한다. mac과 Windows는 인증서가 서로 다르므로, 둘 다 서명하려면 OS별 environment(secret 분리)로 나누도록 이 워크플로를 고쳐야 한다(지금은 한 인증서를 두 OS에 쓰는 구조이고, 현재는 서명 없이 배포한다).
- 서명이 없으면 Windows SmartScreen, macOS Gatekeeper 경고가 뜬다. 릴리스 노트에 여는 방법을 적는다.

## 자동 업데이트를 넣지 않은 이유
electron-updater는 앱이 실행 중에 GitHub Releases(외부 https)의 `latest.yml`과 설치 파일을 받아 온다. 규칙 17의 예외는 웹 푸시뿐이라(`self-contained-assets.md` 2절) 업데이트 피드는 예외가 아니다. 그래서 `electron-builder.yml`의 `publish`는 `null`로 두고 `--publish never`로 빌드한다. 업데이트를 허용하려면 사용자가 예외를 승인한 뒤 `publish: github`, `electron-updater` 의존성, main의 `autoUpdater` 연결을 후속 파트로 추가한다.

## 사용자가 해야 할 일
1. GitHub 결제 문제를 정리한다(정리되기 전에는 모든 워크플로가 실행되지 않는다).
2. Settings > Actions > General에서 "Allow GitHub Actions to create and approve pull requests"를 켠다(release-please PR용).
3. (선택) 서명 인증서를 구해 위 시크릿을 등록한다.
4. 첫 릴리스 전에 Actions 탭에서 `Release Please`의 첫 실행 로그를 확인한다. 릴리스 PR은 GITHUB_TOKEN으로 만들어져 PR 체크(CI)가 자동으로 돌지 않는다. 필요하면 PR에 빈 커밋을 올리거나 PAT를 쓴다.
