# Node.js 보안 가이드

이 문서는 이 프로젝트(Express 5, Socket.io, Prisma, Quill, Electron)에서 **보안 이슈가 날 것으로 예상되는 곳**과 **각각 어떻게 할지**를 정리한다. 총괄은 루프마다 9절 점검을 돌리고, 리뷰할 때 PR 템플릿의 보안 체크를 확인한다.

## 1. 의존성과 공급망 (위험 높음)
**예상되는 문제**: npm 패키지 탈취, 타이포스쿼팅, 악성 install script, 오래된 취약 버전
**대응**
- npm 11의 install script 허용 목록(`allowScripts`, `npm install-scripts approve`)을 유지한다. 새 패키지가 install script를 요구하면 이유를 확인한 뒤에만 승인한다.
- 설치는 `npm ci`로 하고 lockfile을 커밋한다. 루프마다 `npm audit --omit=dev`를 돌려 high 이상은 바로 `security/` 브랜치로 처리한다.
- 새 의존성을 넣을 때는 다운로드 수, 관리 상태, 라이선스를 확인하고 PR에 이유를 적는다. 작은 기능은 직접 짠다.
- GitHub에서 Dependabot alerts와 secret scanning을 켠다(공개 저장소).

## 2. 인증과 세션
**예상되는 문제**: JWT 알고리즘 혼동, 약한 시크릿, 만료 없는 토큰, 소켓 핸드셰이크 인증 누락
**대응**
- `jwt.verify`에 `algorithms: ['HS256']`을 항상 고정한다(slawk는 이미 적용). `JWT_SECRET`은 32바이트 이상 랜덤 값을 쓰고 기본값으로 서버를 띄우지 않는다.
- 토큰 무효화는 `tokenVersion`으로 한다(로그아웃, 비밀번호 변경, 관리자 강제 로그아웃). 엔터프라이즈 세션 관리도 이걸로 만든다.
- 비밀번호는 bcrypt(cost 12 이상)로 저장하고, 로그인과 회원가입에는 rate limit을 건다.
- Socket.io는 핸드셰이크에서 토큰을 검증하고, **room에 join할 때마다 멤버십을 다시 확인한다.** 연결만 됐다고 아무 채널 이벤트나 받게 하면 안 된다.

## 3. 인가 (가장 흔한 실제 버그)
**예상되는 문제**: IDOR. 남의 메시지 id나 채널 id를 넣으면 수정·삭제·조회가 되는 문제
**대응**
- 모든 라우트에 `requireChannelMember`/`requireMessageAccess` 같은 인가 미들웨어를 붙인다. 비공개 채널, DM, 그룹 DM은 멤버만 접근할 수 있다.
- 검색, 활동(Activity), 파일 다운로드, 내보내기처럼 **목록을 돌려주는 API는 결과에 권한 필터를 걸었는지** 따로 테스트한다.
- 테스트에 "다른 사용자 토큰으로 시도하면 403/404"가 나오는 케이스를 CRUD마다 넣는다.

## 4. 입력 검증과 인젝션
**예상되는 문제**: SQL 인젝션(raw 쿼리), NoSQL식 연산자 주입, 프로토타입 오염, ReDoS
**대응**
- 모든 입력은 zod로 검증한다. 스키마는 `.strict()`를 써서 모르는 키를 거부하는 것을 권장한다.
- Prisma는 기본 쿼리가 파라미터 바인딩이라 안전하다. `$queryRawUnsafe`는 금지하고, 전문 검색 같은 raw 쿼리는 태그드 템플릿으로만 쓴다.
- 객체 병합(`Object.assign`, spread)에 사용자 입력을 그대로 넣지 않는다. `__proto__`와 `constructor` 키가 들어오면 프로토타입이 오염될 수 있다.
- 사용자 입력에 적용하는 정규식은 백트래킹이 폭발하지 않는지 확인하고, 입력 길이 상한을 먼저 검사한다(이모지 정규식처럼 `max(32)`로 막는 방식).

## 5. XSS와 콘텐츠 렌더링 (위험 높음)
**예상되는 문제**: 메시지, 프로필, 채널 토픽, 링크 미리보기에 들어간 스크립트가 실행되는 문제. 토큰이 `localStorage`에 있어서 XSS가 나면 바로 계정 탈취로 이어진다.
**대응**
- 렌더링은 `renderMessageContent.tsx`에서만 하고 `dangerouslySetInnerHTML`은 금지한다.
- helmet CSP를 유지하고, `script-src`에 `unsafe-inline`과 `unsafe-eval`을 넣지 않는다.
- 링크는 `http`/`https`/`mailto`만 허용한다.
- 장기 과제: 토큰을 httpOnly + SameSite 쿠키로 옮기고 CSRF 토큰을 도입할지 검토한다(데스크톱 앱과 같이 결정).

## 6. 파일 업로드
**예상되는 문제**: 경로 조작, 실행 파일과 HTML 업로드로 생기는 XSS, 압축 폭탄(이미지), 용량으로 서비스 거부
**대응**
- 저장 파일 이름은 서버가 만든 랜덤 이름만 쓴다. 원래 이름은 DB에만 저장한다.
- MIME은 `file-type`으로 실제 내용을 보고 판정한다. 다운로드 응답에 `Content-Disposition: attachment`와 `X-Content-Type-Options: nosniff`를 붙인다.
- `sharp`에 `limitInputPixels`를 걸고, multer `limits.fileSize`를 둔다(`MAX_FILE_SIZE_MB`).
- 파일을 서빙하는 경로는 `path.resolve` 후 업로드 루트 안에 있는지 확인한다.

## 7. 서비스 거부와 SSRF
- Express body 제한(`100kb`)을 유지한다. 소켓 payload에도 `maxHttpBufferSize`를 둔다.
- rate limit의 `keyGenerator`가 IPv6를 처리하는지 확인한다(`ipKeyGenerator`). 기준 테스트에서 express-rate-limit의 `ERR_ERL_KEY_GEN_IPV6` 경고가 나왔다.
- 링크 미리보기(파트 13)나 웹훅처럼 **서버가 외부 URL을 요청하는 기능은 SSRF를 막아야 한다**: 사설·루프백·링크로컬 IP 차단(DNS를 풀어 본 뒤 검사), 리다이렉트 횟수 제한, 응답 크기와 시간 제한.
- 처리 안 된 Promise reject 때문에 프로세스가 죽지 않게 `process.on('unhandledRejection')`에서 로그를 남긴다. 컨테이너가 재시작하게 해 둔다.

## 8. 비밀 정보와 로그
- `.env`는 커밋하지 않는다(.gitignore 처리됨). 운영 비밀은 환경변수나 시크릿 매니저에 둔다.
- 로그에 토큰, 비밀번호, 메시지 본문, 이메일을 남기지 않는다. 감사 로그(AuditLog)에는 행위자, 대상 id, 동작만 남긴다.
- 웹훅 토큰을 비교할 때는 `crypto.timingSafeEqual`을 쓴다.

## 9. 데스크톱 앱 (Electron)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`를 켠다. preload는 `contextBridge`로 꼭 필요한 함수만 노출한다.
- 앱 안 탐색은 우리 서버 origin으로 제한하고(`will-navigate`, `setWindowOpenHandler`), 외부 링크는 `shell.openExternal`로 브라우저에서 열되 `http`/`https`만 허용한다.
- 딥링크(`slackclone://`) 인자는 화이트리스트로 검증한다.
- 자동 업데이트는 서명을 검증하는 electron-updater + GitHub Releases로 한다. 코드 서명 인증서가 없으면 Windows SmartScreen 경고가 뜬다는 점을 릴리스 노트에 적는다.
- Electron은 최신 안정 버전을 유지한다. 크로미움 취약점 패치를 바로 따라간다.

## 10. 루프마다 할 점검 (총괄)
```bash
cd app/backend && npm audit --omit=dev --audit-level=high
cd app/frontend && npm audit --omit=dev --audit-level=high
git -C /Users/kwanhyun/Desktop/slack ls-files | grep -E '\.env$|\.pem$|\.key$'   # 아무것도 안 나와야 함
```
결과는 `docs/ops/command-log.md`에 남기고, 문제가 있으면 보드에 `security/` 파트로 올린다.
