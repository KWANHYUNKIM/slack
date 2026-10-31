# 릴리스 운영 (D2)

구조: `docs/architecture/enterprise-and-distribution.md` 2절, 규칙: `docs/conventions/git.md` 5절

## 흐름
```
main에 feat/fix 머지 -> release-please.yml이 "chore: release 0.2.0" PR 생성(CHANGELOG.md, 루트 version.txt, app/desktop/package.json 버전)
-> 그 PR을 머지 -> 태그 v0.2.0 + draft GitHub Release 생성 -> release.yml 호출
-> prepare(태그 형식, package.json 버전 일치) -> build(windows, macos, linux) -> publish(draft에 업로드한 뒤 마지막에 공개)
```
- 태그를 직접 푸시해도(`git tag v0.2.0 && git push origin v0.2.0`) `release.yml`이 돈다. package.json의 version이 태그와 같아야 한다(다르면 prepare에서 실패). 이 경로도 draft로 만든 뒤 업로드가 모두 끝나면 공개한다. 업로드가 하나라도 실패하면 공개하지 않는다.
- 버전은 저장소 전체 기준이다(`feat` MINOR, `fix` PATCH, `!` MAJOR). 0.x 특례(`bump-minor-pre-major`)는 쓰지 않으므로 `!` 커밋은 0.x에서도 MAJOR를 올린다.
- 태그 형식은 SemVer 2.0이다(`scripts/release-tag.mjs`). `-` 뒤에 프리릴리스(`v1.2.3-rc.1`)를 붙일 수 있고(숫자 식별자 앞자리 0 금지), 프리릴리스로 올라간다. build metadata(`+build`)는 받지 않는다.
- 첫 실행 범위: `release-please-config.json`의 `bootstrap-sha`가 설정 시점 main HEAD(`e09cc77`)다. 이 커밋 이후의 커밋만 CHANGELOG와 버전 계산에 들어간다. 처음 릴리스 PR이 이상한 범위를 훑으면 이 값부터 확인한다.
- web Docker 이미지 빌드와 게시는 아직 없다(`release.yml`에 `docker` job 자리만 주석으로 남김). docker 파트(dev-5) 이후 후속으로 넣는다.

## 산출물
| OS | 파일 |
|---|---|
| Windows | `TeamMessenger-Setup-x.y.z.exe`(nsis), `TeamMessenger-x.y.z-portable.exe` |
| macOS | `TeamMessenger-x.y.z-arm64.dmg`, `TeamMessenger-x.y.z-x64.dmg` |
| Linux | `TeamMessenger-x.y.z-x64.AppImage` |
| 공통 | `SHA256SUMS.txt` |

업로드 대상은 위 이름 패턴(`TeamMessenger-*`)만이다. `__uninstaller` 같은 내부 산출물은 올리지 않고 체크섬에도 넣지 않는다.

## 서명 시크릿 (이름만 적는다. 값은 저장소 Settings > Secrets and variables > Actions에만 넣는다)
OS별로 따로 판정한다(`scripts/release-sign.mjs`). 한 OS의 키는 다른 OS 빌드에 전달되지 않는다.

| OS | 시크릿 | 용도 | 없을 때 |
|---|---|---|---|
| Windows | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | 코드 서명 인증서(.pfx)의 base64와 비밀번호 | 서명 없이 빌드 |
| macOS | `CSC_LINK`, `CSC_KEY_PASSWORD` | 코드 서명 인증서(.p12)의 base64와 비밀번호 | 서명 없이 빌드 |
| macOS | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization (mac 인증서도 있을 때만) | 서명만 하고 notarization은 건너뜀 |

- 인증서와 비밀번호가 둘 다 있어야 그 OS를 서명한다.
- 서명이 없으면 Windows SmartScreen, macOS Gatekeeper 경고가 뜬다. 릴리스 노트에 여는 방법을 적는다.

## 자동 업데이트를 넣지 않은 이유
electron-updater는 앱이 실행 중에 GitHub Releases(외부 https)의 `latest.yml`과 설치 파일을 받아 온다. 규칙 17의 예외는 웹 푸시뿐이라(`self-contained-assets.md` 2절) 업데이트 피드는 예외가 아니다. 그래서 `electron-builder.yml`의 `publish`는 `null`로 두고 `--publish never`로 빌드한다. 업데이트를 허용하려면 사용자가 예외를 승인한 뒤 `publish: github`, `electron-updater` 의존성, main의 `autoUpdater` 연결을 후속 파트로 추가한다.

## 사용자가 해야 할 일
1. GitHub 결제 문제를 정리한다(정리되기 전에는 모든 워크플로가 실행되지 않는다).
2. Settings > Actions > General에서 "Allow GitHub Actions to create and approve pull requests"를 켠다(release-please PR용).
3. (선택) 서명 인증서를 구해 위 시크릿을 등록한다.
4. 첫 `Release Please` 실행 로그를 확인한다. 릴리스 PR은 GITHUB_TOKEN으로 만들어져 PR 체크(CI)가 자동으로 돌지 않는다. 필요하면 PR에 빈 커밋을 올리거나 PAT를 쓴다.
5. draft 릴리스는 release.yml이 공개한다. build가 실패해 draft로 남았으면 Actions에서 재실행하거나 draft를 지우고 태그를 다시 푼다.
