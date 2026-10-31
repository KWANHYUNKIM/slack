# 외부 https 의존 제거: 모든 리소스를 코드 안에

사용자 지시(2026-10-31 10:25): "import 형식으로 https로 가져오는 기능이 있다면 전부 in code 형식으로 변경"

## 1. 원칙
- 앱이 **실행 중에** 외부 https 주소에서 스크립트, 스타일, 폰트, 이미지, 데이터(JSON), 아이콘을 받아 오지 않는다. 필요한 것은 npm 패키지로 번들하거나 `public/`에 넣어 직접 서빙한다.
- 이렇게 하면 오프라인과 사내망(엔터프라이즈)에서도 동작하고, 데스크톱 exe도 서버만 있으면 된다. 외부 CDN이 털려서 생기는 공급망 위험과, 사용자의 IP가 외부로 새는 문제도 막는다.
- CSP(`helmet`)의 `script-src`, `style-src`, `font-src`, `img-src`, `connect-src`를 `'self'` 위주로 좁혀서, 이 원칙을 브라우저가 강제하게 한다.
- 사용자가 직접 넣은 링크(메시지 본문의 URL)는 콘텐츠이므로 해당하지 않는다. 다만 링크 미리보기 이미지는 서버가 받아서 프록시로 전달한다(13 link-unfurl).

## 2. 조사 결과 (2026-10-31, 총괄 grep)
| 위치 | 외부 주소 | 문제 | 조치 |
|---|---|---|---|
| `emoji-mart` Picker | `cdn.jsdelivr.net/npm/@emoji-mart/data@latest/i18n/<locale>.json` | 로캘이 `en`이 아니면 **실행 중에 CDN에서 번역을 받음**(i18n 작업 후 바로 문제가 됨). `@latest`라 버전도 고정되지 않음 | `@emoji-mart/data/i18n/*.json`을 import해서 `i18n` prop으로 넘김. 이모지 데이터는 이미 번들됨(`data` prop) |
| `emoji-mart` (set이 native가 아닐 때) | `cdn.jsdelivr.net/npm/emoji-datasource-*/img/...png` | 지금은 `native` set이라 요청이 없음 | `set: 'native'`를 고정하고 주석으로 남김. 커스텀 이모지(14)는 서버가 서빙 |
| `useHuddleStore.ts` | `stun:stun.l.google.com:19302`, `stun1...` | 음성 통화를 연결할 때마다 Google STUN 서버에 접속 | 백엔드에 STUN 응답기(UDP, RFC 5389 Binding)를 직접 넣고, ICE 서버 목록을 `/huddles/config`로 받아 옴. 원격 환경용 TURN은 설정으로 추가 |
| `backend/src/app.ts` CSP | `randomuser.me` (개발 모드 img-src) | 개발용 예외 | 제거 |
| `backend/src/app.ts` CSP | `storage.googleapis.com/<bucket>` | GCS 사용 시 브라우저가 직접 받음 | 파일은 서버를 거쳐 스트리밍(이미 다운로드 라우트가 그렇게 함). CSP 예외 제거 |
| `frontend/src/mocks/*.ts` | `i.pravatar.cc` | 어디서도 import하지 않는 죽은 코드 | 파일 삭제 |
| 웹 폰트 | 없음(`/fonts/lato-*.woff2` 로컬) | 정상 | i18n용 CJK·아랍 대체 폰트도 시스템 폰트나 로컬 woff2로 |
| 웹 푸시 | 브라우저 푸시 서비스(FCM, Mozilla, Apple) | 브라우저 표준이라 대체 불가 | 예외로 문서화. 데스크톱은 Electron 네이티브 알림으로 외부 의존 없음 |
| `seed.ts`, 메시지 본문 링크 | github.com 등 | 샘플 데이터의 텍스트 | 해당 없음 |

### 내장 STUN 운영 안내 (feat/builtin-stun)
- 배포 대상은 자체 Docker라 UDP를 쓸 수 있다. 컨테이너에서 `STUN_PORT`(기본 3478/udp)를 열고, 클라이언트에 광고할 공인 호스트를 `STUN_PUBLIC_HOST`로 설정한다. production에서 이 값이 없으면 Host 헤더를 믿지 않고 STUN을 광고하지 않는다(경고 로그). 개발 환경은 요청 Host를 쓴다. 바인드에 실패하면(포트 사용 중 등) STUN은 광고하지 않는다.
- **UDP를 열 수 없는 환경(Cloud Run 등)이나 서로 다른 NAT 뒤의 사용자끼리 통화해야 하면 자체 TURN 서버(coturn 등)를 직접 운영하고 `TURN_URLS`(쉼표 구분), `TURN_USERNAME`, `TURN_CREDENTIAL`로 설정한다.** 외부 공개 STUN/TURN은 규칙 17에 따라 쓰지 않는다.

## 3. 재발 방지
- CI에 검사를 넣는다: `app/frontend/dist`와 `app/backend/src`에서 `https?://` 리터럴을 찾아 허용 목록 밖이면 실패시킨다(`scripts/check-external-urls.sh`).
- 허용 목록은 `scripts/external-urls.allow`(정규식+사유 주석). dist는 번들 라이브러리 주석 오탐 때문에 검사하지 않고 CSP가 막는다.
- 새 의존성을 리뷰할 때 런타임에 원격 fetch를 하는지 확인한다(PR 템플릿 보안 체크에 항목 추가).

## 4. 작업 분할
| 파트 | 내용 | 모델 | 시간 |
|---|---|---|---|
| chore/self-contained-assets | emoji-mart i18n 번들, mocks 삭제, CSP 축소, CI 검사 스크립트 | sonnet | 1.5h |
| feat/builtin-stun | 백엔드 내장 STUN(UDP)과 `/huddles/config`, 허들 연결 테스트 | sonnet | 1.5h |
