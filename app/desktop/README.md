# Team Messenger 데스크톱 셸 (Electron)

설치 파일 안에 서버를 넣지 않는다. 처음 실행하면 서버 주소(워크스페이스 URL)를 입력받아 저장하고, 그 주소의 웹 앱을 띄운다. 화면 코드는 `app/frontend`와 100% 공유한다.
구조: `docs/architecture/enterprise-and-distribution.md`, 보안: `docs/security/nodejs-security.md` 9절

## 구성
| 경로 | 내용 |
|---|---|
| `src/main/main.ts` | 진입점: 창, 앱 내부 스킴 `app://setup`, 메뉴, 알림, 배지 |
| `src/main/security.ts` | 새 창·이동·리다이렉트·webview·권한 제한 |
| `src/main/ipc.ts`, `ipcContract.ts` | IPC 화이트리스트, 보낸 화면 확인, 인자 검증 |
| `src/main/policy.ts` | 서버 주소 정규화, 허용 origin 판단 (순수 함수) |
| `src/main/settings.ts` | 서버 주소 저장소 (`userData/settings.json`, 0600) |
| `src/main/messages.ts` | 셸 문구 en/ko |
| `src/preload/preload.ts` | `window.desktop`(서버 페이지), `window.setupApi`(입력 화면) |
| `src/setup/` | 서버 주소 입력 화면 (자체 CSP) |
| `electron-builder.yml` | 제품 이름 Team Messenger(`com.teammessenger.desktop`). Windows nsis·portable, mac dmg, Linux AppImage, Electron Fuses |

## 명령
```bash
npm ci                 # electron 바이너리는 설치 때 받지 않는다(처음 실행할 때 받음)
npm test               # tsc 빌드 + node --test 단위 테스트 + electron-builder 설정 검증
npm start              # 로컬 실행 (Electron 바이너리 다운로드 필요)
npm run dist:mac       # 결과: release/TeamMessenger-x.y.z-arm64.dmg 등. 패키징은 CI(release.yml)에서 한다. 로컬 M2에서 Windows exe는 만들지 않는다.
```

## 서버 주소 규칙
- 스킴이 없으면 내부망 주소(`localhost:3000`, `192.168.0.5`, `nas.local`)는 `http://`, 그 밖은 `https://`를 붙인다. origin만 저장한다(경로·쿼리 버림). 허용 origin은 이것 하나뿐이다.
- `http://`는 내부망(localhost, 127.x, 10.x, 172.16~31.x, 192.168.x, `*.local`)에서만 받는다.
- 저장한 서버를 열 때는 "연결 중" 화면을 먼저 띄우고, 10초 안에 서버가 응답하지 않으면 입력 화면에 실패를 보여 준다.
- "저장한 서버 지우기"는 설정과 그 origin의 저장소(로그인 토큰, 쿠키, 캐시)를 함께 지운다.

## 아이콘
`resources/icon.png`는 `scripts/make-icon.mjs`가 직접 그린 placeholder(둥근 사각형 + 말풍선)다. 외부 이미지나 로고를 쓰지 않았다. 다시 만들려면 `npm run icon`.
