# E2 SSO: OIDC 먼저, 그다음 SAML 2.0 (설계 스펙)

작성: planner-1, 2026-11-01. 상위 문서: `docs/architecture/enterprise-and-distribution.md` 3절 E2.
근거 조사: `docs/research/sso.md`(S1~S44는 그 문서의 출처 번호). 선행 스펙: `docs/specs/E1-multi-workspace.md`(D1 조직 1개, E1e `OrganizationSetting`).
이 문서는 설계 스펙이다. 개발은 9절 파트(E2a~E2f) 단위로 배정한다. 총괄 결정이 필요한 항목은 13절에 모았다.
브라우저 도구가 없어 Slack 관리 화면은 직접 관찰하지 못했다. CRUD 흐름은 공식 문서의 요청·응답 예시로 추적했다(5절). 14절에 나중에 확인할 항목을 남긴다.

## 0. 요약
- **우리 서버가 두 역할을 동시에 가진다. 섞지 않는다.**
  | | OAuth 인가 서버(mcp-4, 이미 있음) | SSO(E2, 새로 만듦) |
  |---|---|---|
  | 우리 역할 | 토큰을 **발급**하는 쪽(Authorization Server) | 토큰·Assertion을 **받아 검증**하는 쪽(OIDC Relying Party / SAML Service Provider) |
  | 상대 | claude.ai 같은 MCP 클라이언트 | Google, Entra ID, Okta, 사내 SAML IdP |
  | 비밀 | 클라이언트 비밀을 **해시**로만 저장(우리가 검증) | IdP의 클라이언트 비밀을 **가역 암호화**(우리가 IdP에 보내야 함) |
  | 경로 | `/oauth/*`, `/.well-known/oauth-*` | `/sso/*`, `/auth/sso/*`, `/org/sso/*` |
  | 테이블 | `OAuthClient`, `OAuthCode`, `OAuthToken` | `SsoConnection`, `SsoDomain`, `SsoIdentity`, `SsoAuthRequest`, `SsoLoginTicket`, `SsoReplay` |
  | 코드 | `services/oauthService.ts` | 새 `services/sso/*` (oauthService를 import하지 않는다. PKCE 생성·sha256 같은 공용 함수만 `utils/`로 옮겨 함께 쓴다) |
  두 흐름이 이어지는 곳은 하나뿐이다: SSO가 강제된 사용자가 OAuth 동의 화면(`/oauth-consent`)에 오면, 로그인 단계가 SSO로 바뀔 뿐 동의·토큰 발급은 그대로다(6.6).
- **조직 단위 설정**(D1 조직 1개). IdP 구성(`SsoConnection`)은 여러 개, 이메일 도메인은 구성 하나에만 속한다. 강제 수준은 `OrganizationSetting.ssoMode`(OFF/OPTIONAL/REQUIRED).
- **사용자 식별은 (구성, 외부 subject)**. 이메일은 처음 연결할 때만 쓰고, 기존 계정과의 연결은 **기존 비밀번호(+2FA) 확인을 거쳐야** 한다(nOAuth류 계정 탈취 방지, S32).
- **브라우저 토큰 전달**: 콜백은 1회용 티켓을 URL **조각(#)**으로 SPA에 넘기고, SPA가 `POST /auth/sso/exchange`로 기존 로그인 응답과 같은 `{ user, token }`을 받는다. 세션은 E7의 `Session` 행(새 컬럼 `authMethod='sso'`, `ssoConnectionId`).
- **SSO 로그인은 로컬 2FA를 건너뛴다**(MFA는 IdP 책임, S44). 소유자 우회·제외 사용자의 비밀번호 로그인에는 기존 2FA 정책이 그대로 걸린다.
- **SLO 없음, 세션 길이는 우리 설정**(S41). 구성을 끄거나 지우면 그 구성으로 만든 세션을 폐기한다(S42).
- **규칙 17 예외**: 서버→IdP 백채널(디스커버리, JWKS, 토큰 엔드포인트)만 허용하고, 브라우저는 IdP로 **최상위 이동(리다이렉트)**만 한다. IdP의 스크립트·이미지·폰트를 우리 페이지에 싣지 않는다(8절).
- **라이브러리**: OIDC는 `jose`(이미 하위 의존성으로 설치됨)를 직접 의존성으로 올리고 흐름은 직접 구현. SAML은 XML 서명을 직접 구현하지 않고 `@node-saml/node-saml`(xml-crypto ≥ 6.0.1 고정)을 쓰되 우리 쪽 추가 검사를 덧댄다(7절).
- **JIT는 구성별 선택(기본 꺼짐)**. 퇴사자 비활성화 같은 수명 주기는 E3 SCIM의 몫이다.

## 1. 기능 설명

### 1.1 사용자 관점
1. 로그인 화면에 이메일을 넣으면 그 도메인이 SSO 도메인인지 서버가 알려 준다(홈 영역 발견). SSO 도메인이면 "회사 계정으로 계속" 버튼이 나오고, 강제(REQUIRED)면 비밀번호 칸이 사라진다. 구성에 `showOnLoginPage`가 켜져 있으면 이메일 없이도 버튼이 보인다.
2. 버튼을 누르면 IdP 로그인 화면으로 이동했다가 돌아와 바로 앱이 열린다. 처음이면:
   - 같은 이메일의 기존 계정이 있으면 "기존 계정에 연결" 화면에서 **현재 비밀번호(2FA 사용자는 코드까지)**를 한 번 넣는다. 이후로는 SSO만으로 들어온다.
   - 계정이 없고 JIT가 켜져 있으면 바로 계정이 만들어지고 지정된 워크스페이스에 MEMBER로 들어간다.
   - 계정이 없고 JIT가 꺼져 있으면, 초대 링크로 시작한 경우에만 그 초대로 가입된다. 아니면 "관리자에게 초대를 요청하세요" 오류.
3. 프로필 > 보안에서 연결된 SSO 계정(구성 이름, 연결 시각, 마지막 사용)을 본다. 강제 중이면 사용자가 직접 연결을 끊을 수 없다.
4. 데스크톱 앱에서는 SSO 버튼이 **시스템 브라우저**를 열고, 로그인 후 앱으로 돌아온다(S6, 6.7).
5. 로그아웃은 우리 앱에서만 된다(IdP 세션은 그대로, S41).

### 1.2 관리자 관점(조직 소유자·관리자)
1. 조직 관리 > 보안 > SSO에서 구성을 만든다. 프리셋: Google Workspace, Microsoft Entra ID, Okta, 일반 OIDC, SAML 2.0.
2. 화면이 IdP에 넣을 값(OIDC 리다이렉트 URI, SAML ACS URL·SP Entity ID·SP 메타데이터 XML)을 복사할 수 있게 보여 준다.
3. IdP 값(issuer·client id·secret 또는 IdP 메타데이터 XML), 이메일 도메인, JIT·프로필 동기화 옵션을 넣고 저장한다. 비밀은 다시 보여 주지 않는다(교체만 가능).
4. **구성 테스트**: 관리자 본인이 IdP 로그인을 한 번 끝까지 해야 `testedAt`이 찍히고, 그래야 켤 수 있다(S40). 테스트는 세션을 만들지 않고 결과(받은 클레임 요약, 오류 code)만 보여 준다.
5. 조직 설정에서 강제 수준을 고른다: 끔 / 선택 / 필수(+ 게스트 제외, 소유자 우회). 필수로 바꿀 때 "비밀번호로 로그인한 기존 세션 종료" 체크박스(기본 꺼짐 — Slack은 기존 세션 유지, S40).
6. 사용자별 SSO 제외(`ssoExempt`, S42의 멤버 제외), 연결 해제(사용자가 다음 로그인 때 다시 연결).
7. 모든 변경과 로그인 결과는 감사 로그에 남는다(10절).

## 2. 현재 코드 분석(이미 구현 / 부족 / 없음)
| 영역 | 상태 | 근거 파일 | E2에서 할 일 |
|---|---|---|---|
| 비밀번호 로그인·잠금·2FA 2단계(`mfaToken`) | 구현 | `routes/auth.ts`, `services/mfaService.ts` | 강제 검사 추가, `sendLoginSuccess`를 SSO 교환에서도 재사용(내보내기 또는 `services/loginResponse.ts`로 이동) |
| 세션(sid·tokenVersion·유휴/최대 수명) | 구현 | `services/sessionService.ts`, `middleware/auth.ts` | `createSessionToken`에 `{ authMethod, ssoConnectionId, maxAgeMs }` 옵션, 세션 캐시에 `authMethod` |
| 비밀 암호화 | 구현(TOTP용) | `utils/secretBox.ts`(AES-256-GCM, aad), `config.getTotpEncryptionKey` | 그대로 재사용. 키는 13절 D3 |
| 조직 정책 캐시 | 구현(id=1 행) | `services/settingsCache.ts` | E1e 이후 `OrganizationSetting`에 `ssoMode` 등 추가, 캐시 키 확장 |
| 감사 로그 | 구현 | `utils/auditLog.ts`, `services/auditLogService.ts` | `sso.*` 액션 추가(10절) |
| 1회용 대기 토큰 패턴 | 구현 | `MfaChallenge`(해시 id, TTL, 원자적 소비) | 같은 패턴으로 `SsoLoginTicket` |
| PKCE 검증 | 구현(인가 서버 쪽) | `services/oauthService.ts` | 생성 함수(`verifier`, `S256 challenge`)를 `utils/pkce.ts`로 분리해 공유 |
| 공개 출처(PUBLIC_URL) | 구현 | `oauthService.configuredOrigin/publicOrigin` | `utils/publicOrigin.ts`로 옮겨 공유. SSO는 **운영에서 PUBLIC_URL 필수**(리다이렉트 URI·ACS가 고정돼야 함) |
| 쿠키 | **없음**(Bearer 토큰만, cookie-parser 없음) | `app.ts` | SSO 브라우저 묶음 쿠키 1개만 직접 파싱(6.3). 새 의존성 없이 `utils/cookies.ts` |
| x-www-form-urlencoded 본문 | `/oauth` 라우터에만 | `routes/oauth.ts` | SAML ACS 라우터에만 `express.urlencoded({ limit: '300kb' })` |
| 데스크톱 외부 이동 | 서버 출처 밖 이동은 시스템 브라우저로 | `desktop/src/main/policy.ts`, `security.ts` | 사용자 정의 스킴 딥링크 수신(6.7) |
| 관리 화면 보안 탭 | 있음(2FA 강제, OAuth 허용) | `frontend/src/components/Admin/AdminSecurityTab.tsx` | SSO 섹션은 새 컴포넌트(E1h의 `/org/admin` 분리와 충돌 주의) |
| IdP 클라이언트(OIDC RP / SAML SP) | **없음** | - | 전부 새로 |
| 외부 subject ↔ User 연결 | **없음** | - | `SsoIdentity` |
| SSO 강제·제외·우회 | **없음** | - | 6.5 |

## 3. 데이터 모델

### 3.1 새 모델(Prisma 초안, 마이그레이션 `20261103010000_add_sso`)
```prisma
enum SsoProtocol { OIDC SAML }
enum SsoMode { OFF OPTIONAL REQUIRED }

// IdP 구성. 조직에 여러 개. publicId는 URL에 쓰는 추측 불가 id(정수 id를 노출하지 않는다).
model SsoConnection {
  id               Int         @id @default(autoincrement())
  organizationId   Int
  publicId         String      @unique @db.VarChar(24)   // "ssoc_" + 16자 base64url
  name             String      @db.VarChar(100)          // 로그인 버튼 문구(사용자 입력이라 번역 대상 아님)
  protocol         SsoProtocol
  preset           String      @db.VarChar(20)           // google|entra|okta|oidc|saml (화면 안내용)
  enabled          Boolean     @default(false)
  showOnLoginPage  Boolean     @default(false)

  // OIDC
  oidcIssuer             String?   @db.VarChar(500)      // 정확 일치 비교 대상. https만(테스트 루프백 예외)
  oidcClientId           String?   @db.VarChar(255)
  oidcClientSecretSealed String?   @db.VarChar(2000)     // secretBox v1, aad = "sso:conn:<id>:oidc"
  oidcTokenAuthMethod    String    @default("client_secret_basic") @db.VarChar(30) // |client_secret_post
  oidcScopes             String    @default("openid email profile") @db.VarChar(300)
  oidcMetadata           Json?     // 디스커버리에서 쓰는 필드만: authorization_endpoint, token_endpoint, jwks_uri, id_token_signing_alg_values_supported
  oidcJwks               Json?     // 공개키 캐시
  oidcMetadataFetchedAt  DateTime?
  oidcJwksFetchedAt      DateTime?
  googleHostedDomain     String?   @db.VarChar(255)      // 프리셋 google: 응답 hd 클레임 일치 요구

  // SAML(E2e에서 사용, 스키마는 E2a에서 한 번에)
  samlIdpEntityId        String?   @db.VarChar(500)
  samlSsoUrl             String?   @db.VarChar(1000)     // HTTP-Redirect 바인딩 SSO 엔드포인트
  samlIdpCertificates    String[]  // PEM. 최대 2개(회전 기간 겹침)
  samlEmailAttribute     String    @default("email") @db.VarChar(200)
  samlNameAttribute      String?   @db.VarChar(200)
  samlAllowIdpInitiated  Boolean   @default(false)

  // 공통 정책
  requireVerifiedEmail   Boolean   @default(true)        // OIDC email_verified, Entra xms_edov(있으면)
  jitEnabled             Boolean   @default(false)
  jitWorkspaceId         Int?                             // null이면 기본 워크스페이스
  syncProfileName        Boolean   @default(true)
  syncEmail              Boolean   @default(false)       // 13절 D7

  testedAt         DateTime?   // 마지막 성공 테스트. 보안 필드가 바뀌면 null로
  testedBy         Int?
  lastLoginAt      DateTime?
  lastErrorCode    String?     @db.VarChar(50)
  lastErrorAt      DateTime?
  createdBy        Int?
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @default(now()) @updatedAt

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  domains      SsoDomain[]
  identities   SsoIdentity[]

  @@unique([organizationId, name])
  @@index([organizationId, enabled])
}

// 구성이 책임지는 이메일 도메인. 도메인 하나는 구성 하나에만(홈 영역 발견이 모호하지 않게).
model SsoDomain {
  domain       String   @id @db.VarChar(253)  // 소문자, IDN은 punycode(ASCII)로 정규화
  connectionId Int
  createdBy    Int?
  createdAt    DateTime @default(now())

  connection SsoConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  @@index([connectionId])
}

// 외부 계정 ↔ 사용자. 한 사용자는 구성마다 하나, 한 subject는 한 사용자.
model SsoIdentity {
  id           Int       @id @default(autoincrement())
  connectionId Int
  subject      String    @db.VarChar(255)  // OIDC sub / SAML persistent NameID. 대소문자 그대로 비교
  userId       Int
  emailAtLink  String    @db.VarChar(255)
  linkedVia    String    @db.VarChar(16)   // password_confirm|jit|invite|admin_test
  linkedAt     DateTime  @default(now())
  lastLoginAt  DateTime?

  connection SsoConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  user       User          @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([connectionId, subject])
  @@unique([connectionId, userId])
  @@index([userId])
}

// 진행 중인 로그인 요청(10분, 1회용). id = sha256(state). 브라우저 묶음 쿠키의 해시를 함께 둔다.
model SsoAuthRequest {
  id                String    @id @db.Char(64)
  connectionId      Int
  purpose           String    @db.VarChar(10)  // login|test
  browserBinding    String    @db.Char(64)     // sha256(쿠키 값)
  nonce             String?   @db.VarChar(64)  // OIDC
  codeVerifier      String?   @db.VarChar(128) // OIDC PKCE. 10분 수명이라 평문(코드 없이는 쓸모없음)
  samlRequestId     String?   @db.VarChar(64)  // SAML InResponseTo 대조
  client            String    @db.VarChar(10)  // web|desktop
  desktopChallenge  String?   @db.VarChar(64)  // 6.7. S256(desktopVerifier)
  returnTo          String?   @db.VarChar(500) // 같은 출처 상대 경로만
  inviteCode        String?   @db.VarChar(64)
  actorId           Int?      // purpose=test일 때 테스트한 관리자
  expiresAt         DateTime
  usedAt            DateTime?
  createdAt         DateTime  @default(now())

  @@index([expiresAt])
}

// IdP 검증을 마친 뒤 SPA로 넘기는 1회용 티켓(60초). id = sha256(ticket). kind=login이면 세션 발급, link면 비밀번호 확인 대기.
model SsoLoginTicket {
  id               String    @id @db.Char(64)
  kind             String    @db.VarChar(10)   // login|link|test
  connectionId     Int
  userId           Int?      // login, link
  subject          String    @db.VarChar(255)
  email            String    @db.VarChar(255)
  displayName      String?   @db.VarChar(100)
  client           String    @db.VarChar(10)
  desktopChallenge String?   @db.VarChar(64)
  testResult       Json?     // kind=test: 클레임 요약(이메일 마스킹)
  attempts         Int       @default(0)       // link 비밀번호 시도(최대 5)
  expiresAt        DateTime
  usedAt           DateTime?
  createdAt        DateTime  @default(now())

  @@index([expiresAt])
}

// SAML Assertion ID 재사용 방지(S9). NotOnOrAfter까지 보관.
model SsoReplay {
  connectionId Int
  assertionId  String   @db.VarChar(128)
  expiresAt    DateTime

  @@id([connectionId, assertionId])
  @@index([expiresAt])
}
```

### 3.2 기존 모델 변경(같은 마이그레이션)
| 모델 | 변경 | 이유 |
|---|---|---|
| `OrganizationSetting`(E1e) | `ssoMode SsoMode @default(OFF)`, `ssoExemptGuests Boolean @default(true)`, `ssoOwnerBypass Boolean @default(true)`, `ssoSessionMaxHours Int?`(null이면 전역 `SESSION_MAX_AGE_DAYS`) | 조직 단위 강제(S40, S43), 세션 길이(S41) |
| `User` | `ssoExempt Boolean @default(false)` | 개별 제외(S42) |
| `Session` | `authMethod String @default("password") @db.VarChar(16)`(password\|sso\|register\|rotate), `ssoConnectionId Int?`(FK 없음, 인덱스 `@@index([ssoConnectionId, revokedAt])`) | SSO 세션만 골라 폐기, 2FA 정책 면제 판단, PAT 발급 조건 |

- `User.password`는 NOT NULL을 유지한다. JIT 사용자는 32바이트 난수의 bcrypt 해시를 넣어 비밀번호 로그인이 사실상 불가능하게 한다(스키마·로그인 코드 변경 없음). `change-password`는 SSO 강제 사용자에게 막는다(6.5).
- **마이그레이션 순서**: 현재 최신 `20261102020000`(E1c 진행 중) → E1d `20261102030000` → E1e `20261102040000`, `20261102050000` → (E1h `20261102060000`) → **E2a `20261103010000_add_sso`**. E2의 다른 파트는 스키마를 바꾸지 않는다(E2e에서 SAML 컬럼이 더 필요하면 `20261103020000_sso_saml_extras`).
- E1e가 늦어지면: `OrganizationSetting` 대신 기존 `WorkspaceSetting`(id=1)에 SSO 컬럼을 넣는 방안이 있으나, E1e의 이전 SQL이 복잡해지므로 **권장하지 않는다**(13절 D1).

## 4. 화면 흐름

### 4.1 로그인(웹)
```
LoginPage
 ├ 이메일 입력 → (디바운스 400ms 또는 "계속") POST /auth/sso/discover { email }
 │    ├ { sso: null }                    → 기존 비밀번호 폼
 │    ├ { sso: { id, name, mode: OPTIONAL } } → 비밀번호 폼 + "회사 계정으로 계속"
 │    └ { sso: { id, name, mode: REQUIRED } } → "회사 계정으로 계속"만, 아래에 작은 "관리자 로그인"(소유자 우회) 링크
 ├ "회사 계정으로 계속" → location.assign(`/sso/${id}/start?client=web&loginHint=<email>&returnTo=<현재 경로>`)
 │    → 302 IdP → 사용자 인증 → 302 /sso/oidc/callback  (SAML은 POST /sso/saml/:id/acs)
 │    → 302 /sso/complete#ticket=<t>   또는   302 /login?ssoError=<CODE>
 ├ /sso/complete: 조각에서 ticket을 읽고 history.replaceState로 즉시 지운 뒤 POST /auth/sso/exchange
 │    ├ 200 { user, token }               → 로그인 완료, returnTo로 이동
 │    └ 200 { linkRequired: true, linkTicket, email, connectionName } → /sso/link
 └ /sso/link: "기존 계정 비밀번호" (+ 2FA 사용자는 코드) → POST /auth/sso/link → { user, token }
```
- 로그인 화면은 `?ssoError=` 를 번역 키 `errors.<CODE>`로 보여 준다(원문 메시지를 URL에 싣지 않는다).
- 초대 가입 화면(RegisterPage)도 같은 발견 호출을 하고, SSO 도메인이면 `invite=<code>`를 붙여 시작한다.

### 4.2 관리자: 구성 CRUD
```
조직 관리 > 보안 > SSO
 ├ 목록: 이름, 프로토콜, 도메인, 상태(켜짐/꺼짐/테스트 필요), 마지막 로그인, 마지막 오류
 ├ [새 구성] → 프리셋 선택 → 안내 단계(우리 값 복사) → IdP 값 입력 → 저장(꺼진 상태)
 ├ 상세: 편집(비밀은 "설정됨"/교체), 도메인 추가·삭제, [메타데이터 새로고침](OIDC)
 │       [구성 테스트] → 새 탭으로 /sso/:id/start?purpose=test → 결과 페이지 /sso/test-result#ticket=..
 │       [켜기] (testedAt 있어야 활성), [끄기], [삭제](확인 대화상자: "이 구성으로 로그인한 세션 N개가 종료됩니다")
 ├ 연결된 사용자 탭: 이메일, 연결 방식, 마지막 로그인, [연결 해제]
 └ 강제 수준(조직 설정 카드): 끔 / 선택 / 필수, 게스트 제외, 소유자 우회, SSO 세션 최대 시간, [비밀번호 세션 종료]
```

### 4.3 상태 변화 요약
| 상태 | 비밀번호 로그인 | SSO 로그인 | 2FA(로컬) | 새 PAT |
|---|---|---|---|---|
| ssoMode OFF | 가능 | 켜진 구성이 있어도 시작 불가(`SSO_DISABLED`) | 정책대로 | 가능 |
| OPTIONAL | 가능 | 가능 | 비밀번호 세션만 정책 적용 | 가능 |
| REQUIRED, 대상 사용자 | 비밀번호가 맞으면 403 `AUTH_SSO_REQUIRED` | 가능 | SSO 세션 면제 | SSO 세션에서만(13절 D6) |
| REQUIRED, 소유자 우회·제외·(옵션)게스트 | 가능 | 가능 | 비밀번호 세션에 정책 적용. **소유자 우회는 2FA가 켜져 있어야** 한다(D5) | 가능 |

## 5. CRUD 추적(공식 문서 예시 기반)
브라우저가 없어 실제 워크스페이스에서 만들고 지워 보지 못했다. 대신 문서(S1·S2·S9·S10·S30·S31)의 요청·응답 예시를 우리 API에 대입해 한 사이클을 추적했다. 개발자는 아래를 그대로 통합 테스트 시나리오로 옮긴다.

**C — IdP 등록(Entra 프리셋)**
```
POST /org/sso/connections
{ "protocol":"OIDC", "preset":"entra", "name":"Contoso Entra",
  "oidcIssuer":"https://login.microsoftonline.com/<tenantId>/v2.0",
  "oidcClientId":"<app-id>", "oidcClientSecret":"<secret>", "domains":["contoso.com"] }
→ 서버: GET <issuer>/.well-known/openid-configuration (백채널) → issuer 정확 일치 확인 → GET jwks_uri
→ 201 { "connection": { "id":"ssoc_…", "enabled":false, "testedAt":null, "oidcClientSecretSet":true,
        "redirectUri":"https://chat.example.com/sso/oidc/callback", "metadataStatus":"ok", "domains":["contoso.com"] } }
```
- `/common`·`/organizations`가 들어간 issuer는 400 `SSO_ISSUER_INVALID`(S31 자리표시자). 디스커버리 실패는 저장은 하되 `metadataStatus:"error"`, `lastErrorCode:"SSO_METADATA_FETCH_FAILED"`.
- 다른 구성이 이미 가진 도메인은 409 `SSO_DOMAIN_TAKEN`.

**R — 조회**: `GET /org/sso/connections`, `GET /org/sso/connections/:id` → 비밀 원문·봉인값은 절대 내보내지 않는다(`oidcClientSecretSet: true`만). 일반 사용자는 403. `GET /auth/sso/providers`(공개)는 `enabled && showOnLoginPage`인 구성의 `{id, name, protocol}`만.

**테스트 → 켜기**
```
POST /org/sso/connections/ssoc_…/test → { "startUrl": "/sso/ssoc_…/start?purpose=test" }
(관리자 브라우저) GET /sso/ssoc_…/start?purpose=test
→ 302 https://login.microsoftonline.com/<tenantId>/oauth2/v2.0/authorize?response_type=code&client_id=…
       &redirect_uri=https%3A%2F%2Fchat.example.com%2Fsso%2Foidc%2Fcallback&scope=openid%20email%20profile
       &state=<256bit>&nonce=<256bit>&code_challenge=<S256>&code_challenge_method=S256
   Set-Cookie: __Host-sso_tx=<random>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600
(IdP) 302 /sso/oidc/callback?code=…&state=…  (Entra는 iss 파라미터를 보내지 않을 수 있음 — 있으면 비교)
→ 서버: POST token_endpoint (Basic client_id:secret, grant_type=authorization_code, code, redirect_uri, code_verifier)
   ← { "id_token":"eyJ…", "access_token":"…", "token_type":"Bearer" }  (access_token은 쓰지 않고 버린다)
   → id_token 검증(6.2) → purpose=test이므로 세션 없이 test 티켓 → 302 /sso/test-result#ticket=…
POST /org/sso/connections/ssoc_…/test-result { ticket } → { ok:true, claims:{ sub:"…", email:"a***@contoso.com", emailVerified:true, name:"…" } }
   → testedAt 기록, 감사 sso.connection_tested
PATCH /org/sso/connections/ssoc_… { "enabled": true } → 200 (testedAt 없으면 409 SSO_TEST_REQUIRED)
```

**U — 수정**: `PATCH`로 issuer·client id·secret·인증서·도메인을 바꾸면 `testedAt=null`. 이미 켜진 구성은 켜진 채로 두고(소유자 우회가 있으니 잠기지 않음) 화면에 "재테스트 필요" 표시. 비밀 교체는 `oidcClientSecret` 필드를 보낼 때만, 빈 문자열은 400.

**D — 삭제**: `DELETE /org/sso/connections/ssoc_…` → 한 트랜잭션에서 그 구성의 `Session(ssoConnectionId)` 폐기 → `kickSession` → 구성 삭제(SsoDomain·SsoIdentity cascade) → 감사 `sso.connection_deleted`(폐기 세션 수). `ssoMode=REQUIRED`인데 마지막 켜진 구성이면 409 `SSO_LAST_CONNECTION`.

**연결 해제**: `DELETE /org/sso/identities/:id` → 그 사용자·그 구성의 SSO 세션 폐기, 다음 SSO 로그인은 다시 연결 확인(6.4). 사용자 본인 `DELETE /users/me/sso-identities/:id`는 `ssoMode != REQUIRED`이거나 본인이 제외 대상일 때만.

**반복 확인 항목**(테스트로 남김): 만들기→테스트→켜기→로그인→연결 해제→재연결→끄기(세션 폐기)→다시 켜기→삭제를 두 번 돌려도 고아 행(`SsoAuthRequest`, `SsoLoginTicket`, 세션)이 남지 않고, 두 번째 사이클의 로그인 결과가 첫 번째와 같다.

## 6. 동작 상세

### 6.1 OIDC 시작 `GET /sso/:publicId/start`
1. `PUBLIC_URL` 없으면(운영) 503 `SSO_NOT_CONFIGURED`. 구성이 없거나 꺼졌거나 `ssoMode=OFF`면 `/login?ssoError=SSO_CONNECTION_NOT_FOUND|SSO_DISABLED`(purpose=test는 관리자 인증 필요, 꺼진 구성도 허용).
   - purpose=test는 Bearer가 없는 최상위 이동이라 인증할 수 없다. 그래서 `POST /org/sso/connections/:id/test`(인증됨)가 **1회용 test 시작 토큰**을 만들어 `startUrl`에 붙이고, start는 그 토큰을 소비해 `actorId`를 얻는다.
2. state, nonce(각 32바이트 base64url), PKCE verifier 생성. `SsoAuthRequest` 저장(10분).
3. 브라우저 묶음 쿠키 `__Host-sso_tx`(난수, HttpOnly, Secure, SameSite=Lax, Path=/, 10분). 개발 http에서는 `__Host-` 접두를 못 쓰므로 `sso_tx`(Secure 없음).
4. `returnTo`는 `/`로 시작하고 `//`·`\`를 포함하지 않는 상대 경로만(오픈 리다이렉트 방지). `loginHint`는 이메일 형식만 통과시켜 `login_hint`로, Google 프리셋은 `hd`, Entra는 `domain_hint`를 붙인다.
5. 시작 요청은 IP당 분당 30회 제한(`express-rate-limit`).

### 6.2 OIDC 콜백 `GET /sso/oidc/callback`(리다이렉트 URI는 하나)
검증 순서(어느 단계든 실패하면 `SsoAuthRequest`를 소비하고 `/login?ssoError=<code>`, 감사 `sso.login_failed`):
1. `state`로 요청을 찾는다(없음·만료·사용됨 → `SSO_STATE_INVALID`). **쿠키 해시 일치**(로그인 CSRF·세션 고정 방지) → 불일치 `SSO_STATE_INVALID`. 원자적 소비(`updateMany where usedAt null`).
2. `error` 파라미터가 있으면 `SSO_IDP_ERROR`(IdP의 error 값은 감사 details에만, 화면엔 code만).
3. `iss` 파라미터가 있으면 구성 issuer와 일치(S5). 콜백이 하나뿐이어도 state가 구성을 고정하므로 mix-up은 막히지만, 있으면 확인한다.
4. 토큰 교환(백채널 8절 규칙): `client_secret_basic`(기본) 또는 `_post`, `code_verifier`, 정확히 같은 `redirect_uri`. 5초 타임아웃, 응답 1MB 상한, 리다이렉트 따르지 않음. 실패는 `SSO_IDP_UNREACHABLE` 또는 `SSO_TOKEN_EXCHANGE_FAILED`.
5. `id_token` 검증(`jose.jwtVerify`, S1 3.1.3.7):
   - 알고리즘 허용 목록 `RS256, PS256, ES256`(디스커버리의 지원 목록과 교집합). `none`·`HS*` 거부(HS는 client secret을 키로 쓰는 방식이라 비밀이 서명 키가 되는 것을 피한다).
   - `iss` 정확 일치, `aud`에 client_id, `aud`가 여럿이면 `azp == client_id`, `exp`, `iat`(미래 120초 넘으면 거부, 10분보다 오래되면 거부), `nonce` 일치, 시계 오차 허용 120초.
   - 키: `createLocalJWKSet(oidcJwks)`. `kid`를 못 찾으면(`ERR_JWKS_NO_MATCHING_KEY`) JWKS를 **한 번** 다시 받고(구성별 60초 쿨다운) 재시도 — 키 회전 대응(S7). 캐시 수명 24시간.
6. 클레임: `sub`(필수, 255자 이하), `email`(소문자화), `email_verified`, `name`. 프리셋별:
   - Google: `requireVerifiedEmail`이면 `email_verified === true`. `googleHostedDomain`이 있으면 `hd` 클레임 일치.
   - Entra: `email_verified`가 없다. 테넌트 고정 issuer가 이미 보장하는 범위 + `xms_edov`가 **있고 false면 거부**, 없으면 도메인 규칙(7)만으로 판단(S32). 관리자 안내에 `xms_edov` 선택 클레임 추가를 권장.
   - Okta·일반: `email_verified === true` 요구(`requireVerifiedEmail=false`로만 완화).
7. 이메일 도메인이 **이 구성의 `SsoDomain`** 에 있어야 한다(`SSO_EMAIL_DOMAIN_NOT_ALLOWED`). 다른 구성의 도메인 이메일로 들어오는 것도 거부.
8. 사용자 해석(6.4) → 결과에 따라 `SsoLoginTicket`(60초) 생성 → `302 /sso/complete#ticket=…`(데스크톱은 6.7).
9. 응답 헤더 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, 묶음 쿠키 삭제.

### 6.3 브라우저 묶음 쿠키를 쓰는 이유
- 우리 앱은 쿠키 세션이 없다(Bearer). 그래서 state만 있으면 공격자가 **자기 계정으로 시작한 IdP 링크**를 피해자에게 보내 피해자를 공격자 계정으로 로그인시키는 로그인 CSRF가 가능하다. 시작한 브라우저에만 있는 쿠키로 콜백을 묶어 막는다(S4).
- SAML ACS는 IdP 출처에서 오는 **교차 사이트 POST**라 SameSite=Lax 쿠키가 실리지 않는다. SAML 시작은 별도 쿠키 `__Host-sso_tx_saml`(SameSite=None; Secure)를 쓴다. 개발 http에서는 SameSite=None이 불가하므로 SAML 묶음 검사는 `NODE_ENV=development`에서만 끄고 경고 로그(운영에서는 항상 검사).

### 6.4 사용자 해석과 계정 연결(계정 탈취 방지 규칙)
```
identity = SsoIdentity(connectionId, subject)
if identity:
    user = identity.user
    if user.deactivatedAt → SSO_ACCOUNT_DEACTIVATED
    프로필 동기화(syncProfileName이면 name 갱신, syncEmail이면 13절 D7 규칙)
    → login 티켓
else:
    existing = User(email)
    if existing:
        if existing.deactivatedAt → SSO_ACCOUNT_DEACTIVATED
        if existing가 이 구성에 이미 다른 subject로 연결됨 → SSO_IDENTITY_CONFLICT (IdP 재발급 계정. 관리자가 해제 후 재연결)
        → link 티켓(사용자 비밀번호 확인 필요)        ← 자동 연결 금지(D4)
    elif inviteCode 유효(가입과 같은 원자적 소비) → 초대로 계정 생성 + SsoIdentity(linkedVia=invite) → login
    elif connection.jitEnabled → 계정 생성(jitWorkspaceId, MEMBER, 기본 채널) + SsoIdentity(linkedVia=jit) → login
    else → SSO_NO_ACCOUNT
```
- **link 확인** `POST /auth/sso/link { linkTicket, password, code? }`: 비밀번호 잠금 카운터(`loginAttempts`, 이메일 기준)를 공유한다. 2FA 사용자는 `code`(TOTP·복구 코드) 필수. 티켓당 5회. 성공 시 `SsoIdentity(linkedVia=password_confirm)` + 세션(authMethod=sso) + 감사 `sso.identity_linked`.
- 자기 비밀번호를 모르는 사용자(예: 비밀번호를 잊음)는 관리자에게 요청 → 관리자는 연결을 대신 만들 수 없다(D4). 대신 비밀번호 재설정 흐름(현재 없음)이나 계정 삭제 후 JIT. 이 공백은 13절 D4에 적었다.
- 왜 이메일 자동 연결을 하지 않나: 조직 관리자가 아무 도메인(`gmail.com` 등)을 SSO 도메인으로 등록하고 자기가 통제하는 IdP를 붙이면 그 도메인의 기존 사용자로 로그인할 수 있다. 서버당 조직 1개(D1)라 관리자는 이미 강한 권한을 갖지만, **다른 사람으로 로그인하는 권한은 지금 어디에도 없으므로** SSO가 그것을 새로 만들면 안 된다. Slack도 기존 사용자에게 직접 bind하게 한다(S40).
- JIT로 만든 계정 이메일이 이미 다른 사용자 것이면(경합) P2002 → `SSO_NO_ACCOUNT`가 아니라 link 흐름으로 다시 판단.

### 6.5 SSO 강제(REQUIRED) 시 처리
대상 판단 `isSsoForced(user)`: `ssoMode == REQUIRED` 이고, 켜진 구성이 하나 이상이며, 다음에 해당하지 않음 — `user.ssoExempt`, (`ssoExemptGuests` && 모든 워크스페이스 역할이 GUEST), (`ssoOwnerBypass` && `orgRole == OWNER`).

| 지점 | 처리 |
|---|---|
| `POST /auth/login` | 비밀번호 검사는 그대로(타이밍·잠금 동일). 맞고 대상이면 403 `{ code: AUTH_SSO_REQUIRED, sso: { id, name } }`(사용자의 이메일 도메인 구성, 없으면 첫 켜진 구성). 틀리면 기존 401 — 비밀번호를 모르는 사람에게 SSO 대상 여부를 알려 주지 않는다 |
| `POST /auth/login/2fa` | 1단계를 통과한 뒤에 정책이 바뀐 경우 대비해 같은 검사 |
| `POST /auth/register`(초대) | 이메일 도메인이 SSO 도메인이고 REQUIRED면 400 `AUTH_SSO_REQUIRED`(SSO로 시작하라는 뜻, 초대 코드는 소비하지 않음) |
| `POST /auth/change-password` | 대상이면 403 `SSO_PASSWORD_DISABLED` |
| 2FA 필수 정책(`isMfaPolicyEnforced`) | 세션 `authMethod=sso`면 등록 요구 표시를 하지 않는다(`validateAccessToken`이 세션 캐시의 authMethod를 본다) |
| 2FA 켜기·끄기 | 막지 않는다(우회 로그인 대비로 켜 두는 것은 유용) |
| PAT 발급 `POST /users/me/tokens` | 대상이면 현재 세션이 `authMethod=sso`여야(D6). 기존 PAT는 유지 |
| OAuth 앱 | 동의 화면 로그인 단계만 SSO. 기존 토큰 유지. 별도 처리 없음 |
| 기존 세션 | 유지(S40). 관리자가 "비밀번호 세션 종료"를 누르면 대상 사용자의 `authMethod != 'sso'` 세션 폐기 + `kickSession` |
| 소켓 | JWT 그대로라 변경 없음 |

### 6.6 세션 수명과 로그아웃
- SSO 세션 최대 수명 = `ssoSessionMaxHours`(있으면) 아니면 전역. 유휴 만료는 전역 그대로. `createSessionToken(user, req, { authMethod:'sso', ssoConnectionId, maxAgeMs })`.
- `rotateSessions`(비밀번호 변경·2FA 변경)로 새로 받은 토큰은 기존 세션의 authMethod를 이어받는다(SSO 세션에서 2FA를 켜도 SSO 세션).
- 로그아웃은 로컬만. IdP `end_session_endpoint`(RP 시작 로그아웃)는 후속(D10).
- 구성 끄기(`enabled=false`)·삭제·연결 해제 → 해당 SSO 세션 폐기. 사용자 비활성화는 기존 규칙(tokenVersion).
- 스케줄러: `SsoAuthRequest`·`SsoLoginTicket`(만료·사용됨), `SsoReplay`(만료)를 기존 `purgeMfaChallenges`와 같은 주기로 정리.

### 6.7 데스크톱(RFC 8252 패턴)
- Electron 창은 서버 출처만 열고 외부 출처 이동은 시스템 브라우저로 보낸다(`policy.ts`). 내장 웹뷰 로그인은 Google이 막고(S6, `disallowed_useragent`) 피싱 구분도 안 되므로 쓰지 않는다.
- 흐름: 렌더러가 preload API `desktop.startSso(publicId)` 호출 → 메인 프로세스가 `desktopVerifier`(32바이트) 생성, `challenge=S256(verifier)` → `shell.openExternal(<server>/sso/<id>/start?client=desktop&dc=<challenge>)` → 시스템 브라우저에서 IdP 로그인 → 콜백이 `302 teammessenger://sso-complete?ticket=…`(스킴 이름은 D8) → OS가 앱으로 넘김(`open-url`/`second-instance`) → 메인이 `ticket` + 보관한 `verifier`를 렌더러에 전달 → `POST /auth/sso/exchange { ticket, desktopVerifier }` → 서버는 `S256(verifier) == ticket.desktopChallenge` 확인.
- 다른 앱이 같은 스킴을 가로채도 verifier가 없어 티켓을 못 쓴다(S6 8.1). verifier는 메모리에만, 5분 만료.
- link 티켓이면 브라우저 쪽에서 비밀번호를 받지 않고 앱으로 넘겨 앱 안의 `/sso/link` 화면에서 확인한다.

### 6.8 SAML(E2e)
- **SP 시작만 기본**. AuthnRequest를 HTTP-Redirect 바인딩으로 보낸다(서명 안 함, 후속 옵션). `RelayState`는 우리 state(43자, 80바이트 한도 안, S10). ID는 `_` + 32자 hex, `SsoAuthRequest.samlRequestId`.
- ACS `POST /sso/saml/:publicId/acs`(urlencoded, 300KB 상한) → 검증(7.2) → 6.2의 7~9단계와 같은 처리.
- SP 메타데이터 `GET /sso/saml/:publicId/metadata`(XML, entityID=`<origin>/sso/saml/<publicId>`, ACS, NameIDFormat persistent). 인증서 없음(요청 서명·암호화 미사용).
- IdP 정보는 **관리자가 IdP 메타데이터 XML을 붙여 넣거나 파일로 올린다**. 메타데이터 URL 자동 갱신은 하지 않는다(백채널조차 없음 → 규칙 17에 가장 안전). 파싱해서 entityID, SSO URL(Redirect 바인딩), 서명 인증서(최대 2개)를 뽑는다.
- IdP 시작(`samlAllowIdpInitiated`) 기본 꺼짐. 켜면 InResponseTo 없는 응답을 받되 묶음 쿠키 검사가 불가능하므로 재사용 방지와 3분 창만으로 막는다(D9). 꺼져 있으면 `SSO_IDP_INITIATED_DISABLED`.

## 7. 라이브러리 판단

### 7.1 OIDC: `jose` 직접 의존 + 흐름 직접 구현(권장)
| 안 | 장점 | 단점 |
|---|---|---|
| **A. `jose`만(권장)** | 의존성 0개, 이미 lockfile에 v6.2.14(MCP SDK 하위). ESM·Node 24 지원. JWKS 캐시를 우리가 통제(`createLocalJWKSet`) → 백채널 규칙(8절)과 가짜 IdP 테스트가 쉽다. 오류를 우리 code로 정확히 매핑 | 디스커버리·토큰 교환·클레임 검사를 직접 짜야 한다(약 300줄). 검증 순서 실수 위험 → 6.2를 체크리스트로 테스트 |
| B. `openid-client` v6 | 검증 로직이 라이브러리에 있음 | `oauth4webapi` 추가, 추상화가 커서 커스텀 fetch·오류 매핑·테넌트 규칙을 끼우기 번거롭다 |
| C. Node `crypto`만 | 새 의존 없음 | JWK→KeyObject, JWS 파싱, ES256 서명 형식 변환까지 직접 → 버그 위험이 이득보다 큼 |
- `package.json`에 `"jose": "^6.2.14"`를 직접 추가(하위 의존성 버전에 기대지 않는다). `createRemoteJWKSet`은 쓰지 않는다(내부 fetch가 8절 규칙을 우회).

### 7.2 SAML: `@node-saml/node-saml` + 우리 쪽 추가 검사(권장)
- XML 서명(정규화 C14N, Reference, Transform)은 직접 구현하면 안 된다(S12, S23~S26 — 성숙한 라이브러리도 반복해서 뚫렸다).
| 안 | 판단 |
|---|---|
| **A. `@node-saml/node-saml` ^5(권장)** | 가장 널리 쓰이고(passport-saml 코어) 패치가 빠르다. `xml-crypto >= 6.0.1`(SAMLStorm 수정)을 `overrides`로 고정. 의존: xml-crypto, @xmldom/xmldom, xml-encryption, xmlbuilder — 모두 런타임 원격 요청 없음(규칙 17 OK) |
| B. `samlify` | 스키마 검증기를 별도로 골라야 하고 SAMLStorm 영향도 같았다. 이득 없음 |
| C. 직접 구현 | 금지 |
- 우리 쪽 2중 방어(라이브러리를 통과해도 다시 확인, `services/sso/samlGuards.ts`):
  1. 입력 300KB 상한, base64 디코드 후 `<!DOCTYPE`·`<!ENTITY` 있으면 거부(XXE·엔티티 폭탄).
  2. `Assertion`과 `EncryptedAssertion` 개수: Assertion 정확히 1개, EncryptedAssertion 0개(암호화는 후속). `Signature` 요소가 Response 직계 또는 Assertion 직계에만 있고, 서명 Reference URI가 그 부모의 `ID`와 같아야 한다(XSW 1~8, S12).
  3. 인증서는 구성에 저장된 것만(`idpCert` 배열). KeyInfo 인증서 무시(S24). 서명 알고리즘 SHA-256 이상만(`rsa-sha1` 거부, D11).
  4. 값은 라이브러리가 **서명 검증한 노드에서 돌려준 프로필**에서만 읽는다(S26). NameID에 주석 노드가 섞이면 거부(S25 — 텍스트 노드가 2개 이상이면 거부).
  5. `Issuer`(Response·Assertion 둘 다 있으면 둘 다) == `samlIdpEntityId`, `Destination` == ACS, `SubjectConfirmationData@Recipient` == ACS, `InResponseTo` == 저장된 요청 ID, `Audience` 에 우리 SP entityID, `NotBefore`/`NotOnOrAfter` 시계 오차 180초, `StatusCode` Success.
  6. Assertion `ID`를 `SsoReplay`에 넣는다(P2002면 `SSO_REPLAY`).
  7. NameID 형식: persistent 권장. `emailAddress` 형식이면 subject = 소문자 이메일로 받고 관리 화면에 경고(IdP 이메일 변경 시 다른 사람으로 인식).
- 의존성 추가는 `docs/security/nodejs-security.md`의 새 의존성 점검(설치 스크립트, 원격 fetch, 유지 상태, `npm audit`)을 PR에 적는다.

## 8. 규칙 17(외부 https 의존 금지) 예외 — 범위와 조건
SSO는 IdP와 통신하지 않으면 성립하지 않는다. 그래서 웹 푸시처럼 **문서화한 예외**로 둔다. `docs/architecture/self-contained-assets.md`에 "예외 2: SSO 백채널" 절을 E2a에서 추가한다(내용은 아래 그대로).

| 허용 | 조건 |
|---|---|
| 서버 → IdP: OIDC 디스커버리, JWKS, 토큰 엔드포인트 | ① 조직 관리자가 저장한 issuer와 그 디스커버리 문서가 준 엔드포인트만(요청 값으로 주소를 만들지 않는다). ② `https:`만. 예외: `NODE_ENV=test`에서 `127.0.0.1`/`localhost` http(가짜 IdP). ③ 리다이렉트 따르지 않음(`redirect: 'manual'` → 3xx는 실패). ④ 타임아웃 5초, 응답 1MB, `Content-Type` JSON 확인. ⑤ 대상 IP 검사: 루프백·링크로컬(169.254.0.0/16, fe80::/10, 클라우드 메타데이터)·0.0.0.0은 운영에서 거부. 사설망(10/8, 172.16/12, 192.168/16, fc00::/7)은 사내 IdP(Keycloak, ADFS)를 위해 `SSO_ALLOW_PRIVATE_IDP=true`일 때만 허용. DNS 재바인딩을 피하려고 조회한 IP로 연결(`lookup` 옵션 고정). ⑥ 캐시: 디스커버리·JWKS 24시간(DB 컬럼), kid 미스 시 60초 쿨다운 재조회. 요청마다 외부를 치지 않는다 |
| 브라우저 → IdP: 최상위 이동(302) | 우리 페이지에 IdP의 스크립트·스타일·이미지·폰트·iframe을 넣지 않는다. 로그인 버튼 아이콘은 번들의 일반 아이콘(IdP 로고 사용 금지 — 브랜드 에셋 규칙 5장). CSP는 바꾸지 않는다(이동은 CSP 대상이 아니고, SAML AuthnRequest는 Redirect 바인딩이라 `form-action`도 해당 없음) |
| IdP → 브라우저 → 우리: 콜백 GET / ACS POST | 우리 출처로 들어오는 요청이라 예외 아님 |
| SAML 메타데이터 | URL로 받지 않고 관리자가 XML을 붙여 넣는다(백채널 0) |
| 허용하지 않음 | userinfo 엔드포인트(필요한 클레임은 id_token으로), IdP 아바타 URL(프로필 사진 동기화 안 함), 프리셋 issuer 외 하드코딩 URL |
- 백채널 코드는 `services/sso/ssoHttp.ts` 한 곳에만 둔다. `scripts/check-external-urls.sh`의 허용 목록에는 프리셋 issuer 리터럴(`https://accounts.google.com`, `https://login.microsoftonline.com/`) 두 줄만 추가하고, Okta는 조직마다 달라 리터럴이 없다.
- 데스크톱의 시스템 브라우저 열기는 이미 있는 `shell.openExternal` 정책 범위 안이다.

## 9. 파트 분할

### 9.1 파트 표
schema.prisma를 바꾸는 파트(E2a)는 E1의 스키마 파트와 동시에 열지 않는다. E2a 이후 E2 파트는 스키마를 바꾸지 않는다.

| 파트 | 범위 | 선행 | 마이그레이션 | 예상 | 모델 | 충돌 위험 파일 |
|---|---|---|---|---|---|---|
| **E2a 스키마·구성 CRUD·백채널** | 3절 전체 스키마, `services/sso/connectionService.ts`(CRUD, 도메인 정규화·유일, 비밀 봉인 aad `sso:conn:<id>:oidc`, 보안 필드 변경 시 testedAt 초기화), `services/sso/ssoHttp.ts`(8절 규칙 전부), `services/sso/oidcMetadata.ts`(디스커버리·JWKS 캐시·issuer 정확 일치·Entra `/common` 거부), `routes/orgSso.ts`(`/org/sso/connections` CRUD, `refresh-metadata`, 식별 목록·해제 — 해제의 세션 폐기는 E2c에서 연결), `GET /auth/sso/providers`, `POST /auth/sso/discover`, `OrganizationSetting` SSO 필드 읽기·쓰기(`/org/settings` 확장, REQUIRED 전환 전제 조건 검사), 감사 액션, 오류 code·`ko`/`en` 번역, `self-contained-assets.md` 예외 절, `utils/publicOrigin.ts`·`utils/pkce.ts` 분리 | **E1e 머지** | `20261103010000_add_sso` | 2h | **opus** | `schema.prisma`, `routes/org.ts`, `services/settingsCache.ts`, `services/oauthService.ts`(함수 이동만), `utils/errorCodes.ts`, `locales/*/errors.json` |
| **E2b OIDC 로그인 흐름** | `GET /sso/:id/start`, `GET /sso/oidc/callback`, 묶음 쿠키(`utils/cookies.ts`), `services/sso/oidcLogin.ts`(6.2 검증 전부, `jose` 직접 의존 추가), 6.4 해석(identity·link·invite·JIT 분기 중 **JIT 제외**), `SsoLoginTicket`, `POST /auth/sso/exchange`, `POST /auth/sso/link`, test 흐름(`/org/sso/connections/:id/test`, `test-result`, 켜기 조건), `sendLoginSuccess` 공유화, `createSessionToken` 옵션(authMethod·ssoConnectionId), 가짜 OIDC IdP 테스트 도우미 | E2a | 없음 | 2h | **opus** | `routes/auth.ts`, `services/sessionService.ts`, `app.ts`(라우터 마운트) |
| **E2c 강제·정책·JIT·세션** | 6.5 표 전부(`isSsoForced`, 로그인·2FA·가입·비밀번호 변경·PAT), 2FA 정책 면제(`validateAccessToken`·세션 캐시 authMethod), 소유자 우회·게스트 제외·`ssoExempt` API(`PATCH /org/users/:id/sso-exempt`), "비밀번호 세션 종료", 구성 끄기·삭제·연결 해제 시 세션 폐기+`kickSession`, `ssoSessionMaxHours`, `rotateSessions` authMethod 계승, JIT 생성(기본 채널·워크스페이스, 난수 비밀번호 해시), 프로필 동기화, 정리 스케줄러 | E2b | 없음 | 2h | **opus** | `routes/auth.ts`, `middleware/auth.ts`, `services/sessionService.ts`, `services/sessionRotation.ts`, `services/mfaService.ts`, `routes/tokens.ts`, 스케줄러 |
| **E2d 프런트(웹)** | LoginPage 발견·SSO 버튼·`AUTH_SSO_REQUIRED` 처리, `/sso/complete`(조각 읽고 즉시 지움), `/sso/link`, `/sso/test-result`, RegisterPage 초대+SSO, 관리 화면 SSO 섹션(구성 목록·만들기 마법사·상세·도메인·테스트·켜기/끄기·삭제 확인·연결 사용자·강제 수준 카드), 프로필 보안의 연결 목록, `spaRoutes`에 새 경로, 번역 키(ko 누락 0, en, 나머지는 i18n 절차) | E2b(API), E2c 권장 | 없음 | 2h | sonnet | `components/Auth/LoginPage.tsx`, `RegisterPage.tsx`, `App.tsx`, `components/Admin/*`(E1h와 충돌 — 순서 조정), `stores/useAuthStore.ts`, `locales/*` |
| **E2e SAML SP** | `@node-saml/node-saml` 추가(+`xml-crypto` overrides), IdP 메타데이터 XML 파싱·저장, AuthnRequest(Redirect), ACS, SP 메타데이터, 7.2 추가 검사 전부, `SsoReplay`, SAML 묶음 쿠키(SameSite=None), IdP 시작 옵션, test 흐름 공유, 관리 화면에 SAML 입력 필드(작은 변경), 가짜 SAML IdP와 XSW 픽스처 | E2c(E2d와 병렬 가능하나 관리 화면 SAML 필드는 E2d 뒤) | 없음(필요 시 `20261103020000_sso_saml_extras`) | 2h | **opus** | `services/sso/*`, `routes/sso.ts`, `package.json`, `package-lock.json` |
| **E2f 데스크톱 SSO** | 사용자 정의 스킴 등록(`setAsDefaultProtocolClient`, mac `open-url`, win `second-instance` argv), preload `startSso`, verifier 보관·전달, 서버의 `client=desktop` 분기와 `desktopChallenge` 검증, 딥링크 URL 검사(`policy.ts`에 순수 함수 + 테스트), electron-builder 프로토콜 선언 | E2b | 없음 | 1.5h | sonnet(실패 2회면 opus) | `desktop/src/main/*`, `desktop/src/preload/*`, `electron-builder.yml`, `routes/sso.ts`(작은 분기) |

- 병렬: E2a → E2b → E2c 직렬(같은 인증 파일). E2c 뒤 E2d(프런트)·E2e(백엔드 SAML)·E2f(데스크톱)는 파일이 거의 겹치지 않아 자원이 허락하면 동시 가능. 단 E2e의 관리 화면 필드는 E2d 머지 뒤.
- 총 예상 11.5h(6파트). 감속 단계면 직렬 4루프.
- E3 SCIM과의 경계: SCIM이 만든 사용자는 `SsoIdentity`가 없다. SCIM `externalId`/`userName`과 SSO subject를 맞추는 것은 E3에서 정한다(E3는 E2c 뒤). JIT는 생성만 하고 비활성화·삭제는 하지 않는다.

### 9.2 테스트 전략(외부 접속 없이)
- **가짜 OIDC IdP**(`tests/helpers/fakeOidcIdp.ts`, E2b): 테스트 안에서 `http.createServer`를 `127.0.0.1:0`에 띄운다. `jose.generateKeyPair('RS256')`로 키를 만들고 `/.well-known/openid-configuration`, `/jwks`, `/authorize`(바로 code와 state를 붙여 302), `/token`(code→id_token 서명)을 제공한다. 조작 스위치: 잘못된 iss·aud·nonce, 만료, `alg: none`/HS256, 다른 키 서명, kid 회전(첫 JWKS에 없는 kid), email_verified false, Entra식 `xms_edov:false`, 응답 지연(타임아웃), 3xx 리다이렉트, 2MB 응답. `ssoHttp`는 `NODE_ENV=test`에서만 루프백 http를 허용한다.
- **흐름 구동**: supertest로 `start` → `Location`의 IdP URL을 가짜 IdP에 요청 → 돌아온 콜백 URL을 쿠키와 함께 우리 앱에 요청 → `#ticket` 추출 → `exchange`.
- **가짜 SAML IdP**(`tests/helpers/fakeSamlIdp.ts`, E2e): HTTP 서버가 필요 없다(Redirect·POST만). 테스트 전용 RSA 키·자체 서명 인증서를 `tests/fixtures/saml/`에 둔다(**테스트 전용이라고 파일 첫 줄과 README에 명시**, 저장소 비밀 스캔 허용 목록에 경로 추가 — 운영 키 아님). Assertion은 `xml-crypto`의 `SignedXml`로 서명. 픽스처: 정상, 서명 없음, 다른 키, XSW 1~8 변형, NameID 주석 주입, DOCTYPE, Assertion 2개, 만료·미래, 잘못된 Audience·Recipient·Destination·InResponseTo, 재사용(같은 ID 두 번), rsa-sha1.
- **CRUD 반복 테스트**(5절 마지막 항목)와 **세션 폐기 테스트**(끄기·삭제·해제 후 기존 토큰 401, 소켓 끊김).
- **계정 탈취 회귀**: 같은 이메일 기존 사용자 → link 없이 세션이 나오지 않음, 다른 구성 도메인 이메일 거부, `email_verified:false` 거부, 비활성 사용자 거부.
- DB: 개발자 전용 `slackclone_test_devN`(CLAUDE.md 4장). 테스트 시간을 줄이려고 가짜 IdP는 `beforeAll`에서 한 번 띄운다.
- 실제 Google·Entra·Okta 연결 확인은 자동 테스트가 아니라 총괄의 수동 점검 목록(14절)으로 둔다.

## 10. API·이벤트·감사·오류

### 10.1 API
| 메서드·경로 | 인증 | 설명 | 파트 |
|---|---|---|---|
| `POST /auth/sso/discover` `{email}` | 없음(IP 분당 20) | `{ sso: null \| {id, name, protocol, mode} }`. 사용자 존재 여부와 무관하게 도메인만 본다 | E2a |
| `GET /auth/sso/providers` | 없음 | 로그인 화면 버튼용 | E2a |
| `GET /sso/:publicId/start` | 없음(test는 1회용 시작 토큰) | 6.1 | E2b |
| `GET /sso/oidc/callback` | 없음 | 6.2 | E2b |
| `POST /auth/sso/exchange` `{ticket, desktopVerifier?}` | 없음 | `{user, token}` 또는 `{linkRequired, linkTicket, email, connectionName}` | E2b |
| `POST /auth/sso/link` `{linkTicket, password, code?}` | 없음 | 6.4 | E2b |
| `GET/POST /org/sso/connections`, `GET/PATCH/DELETE /org/sso/connections/:id` | 조직 관리자 | 5절 | E2a(삭제 세션 폐기는 E2c) |
| `POST /org/sso/connections/:id/refresh-metadata` | 조직 관리자 | OIDC 디스커버리·JWKS 재조회 | E2a |
| `POST /org/sso/connections/:id/test`, `POST .../test-result` | 조직 관리자 | 구성 테스트 | E2b |
| `GET /org/sso/connections/:id/identities`, `DELETE /org/sso/identities/:id` | 조직 관리자 | 연결 목록·해제 | E2a/E2c |
| `GET /org/settings`, `PATCH /org/settings` | 조직 관리자(ssoMode 변경은 소유자) | SSO 필드 추가 | E2a |
| `POST /org/sso/end-password-sessions` | 조직 소유자 | 6.5 | E2c |
| `PATCH /org/users/:id/sso-exempt` `{exempt}` | 조직 관리자 | 개별 제외 | E2c |
| `GET /users/me/sso-identities`, `DELETE /users/me/sso-identities/:id` | 본인 | 프로필 보안 | E2c |
| `POST /sso/saml/:publicId/acs`, `GET /sso/saml/:publicId/metadata` | 없음 | 6.8 | E2e |

- 소켓 이벤트: 새 이벤트 없음. 세션 폐기는 기존 `kickSession`. (관리 화면 실시간 갱신은 필요 없음.) `docs/architecture/events.md` 변경 없음.
- REQUIRED 전환 전제 조건(`PATCH /org/settings`): 켜진 구성 ≥ 1, 그중 하나 이상 `testedAt` 있음, `ssoOwnerBypass=false`로 바꿀 때는 요청한 소유자 본인이 SSO 연결을 가지고 있어야 함(자기 잠금 방지) → 아니면 409 `SSO_ENFORCE_PRECONDITION`.

### 10.2 감사 로그 액션(details에 비밀·토큰·코드·전체 이메일 금지, 이메일은 `hashEmailForAudit`)
`sso.connection_created`, `sso.connection_updated`(바뀐 필드 이름만), `sso.connection_secret_rotated`, `sso.connection_tested`(ok/code), `sso.connection_enabled`, `sso.connection_disabled`(폐기 세션 수), `sso.connection_deleted`, `sso.domain_added`, `sso.domain_removed`, `sso.mode_changed`(from→to), `sso.user_exempt_changed`, `sso.password_sessions_ended`(수), `sso.login`(connection, linkedVia 첫 로그인 여부), `sso.login_failed`(code, connection, emailHash — 같은 키 15분 스로틀은 기존 `throttleUnknownLogin` 재사용), `sso.identity_linked`, `sso.identity_unlinked`(by self/admin), `sso.jit_user_created`, `sso.email_synced`, `sso.owner_bypass_login`(소유자가 REQUIRED 중 비밀번호로 로그인).

### 10.3 오류 code(번역 키 `errors.<CODE>`, ko·en 필수)
| code | HTTP/위치 | 의미 |
|---|---|---|
| `SSO_NOT_CONFIGURED` | 503 | PUBLIC_URL 없음 또는 암호화 키 없음 |
| `SSO_DISABLED` | 리다이렉트 | ssoMode OFF |
| `SSO_CONNECTION_NOT_FOUND` | 404/리다이렉트 | 없음·꺼짐 |
| `SSO_ISSUER_INVALID` | 400 | https 아님, 자리표시자 issuer, 디스커버리 issuer 불일치 |
| `SSO_METADATA_FETCH_FAILED` | 400/저장 상태 | 디스커버리·JWKS 실패 |
| `SSO_IDP_UNREACHABLE` | 리다이렉트 | 백채널 타임아웃·연결 실패·허용 안 된 IP |
| `SSO_STATE_INVALID` | 리다이렉트 | state 없음·만료·쿠키 불일치 |
| `SSO_IDP_ERROR` | 리다이렉트 | IdP가 error를 돌려줌(사용자 취소 포함) |
| `SSO_TOKEN_EXCHANGE_FAILED` | 리다이렉트 | 토큰 엔드포인트 오류 |
| `SSO_TOKEN_INVALID` | 리다이렉트 | id_token·Assertion 검증 실패(세부 사유는 감사 details에만) |
| `SSO_REPLAY` | 리다이렉트 | Assertion 재사용 |
| `SSO_IDP_INITIATED_DISABLED` | 리다이렉트 | IdP 시작 SAML 꺼짐 |
| `SSO_EMAIL_UNVERIFIED` | 리다이렉트 | email_verified false, xms_edov false |
| `SSO_EMAIL_DOMAIN_NOT_ALLOWED` | 리다이렉트 | 구성 도메인 밖 |
| `SSO_NO_ACCOUNT` | 리다이렉트 | 계정 없음, JIT 꺼짐, 초대 없음 |
| `SSO_ACCOUNT_DEACTIVATED` | 리다이렉트 | 비활성 계정(일반 로그인과 달리 숨기지 않는 이유: IdP 인증을 이미 통과한 본인이다) |
| `SSO_IDENTITY_CONFLICT` | 리다이렉트 | 사용자에게 같은 구성의 다른 subject가 연결돼 있음 |
| `SSO_TICKET_INVALID` | 401 | 교환·link 티켓 없음·만료·사용됨·desktop verifier 불일치 |
| `SSO_DOMAIN_TAKEN` | 409 | 다른 구성의 도메인 |
| `SSO_DOMAIN_INVALID` | 400 | 형식 오류, 공용 메일 도메인 경고는 화면에서만 |
| `SSO_TEST_REQUIRED` | 409 | 테스트 없이 켜기 |
| `SSO_LAST_CONNECTION` | 409 | REQUIRED 중 마지막 구성 끄기·삭제 |
| `SSO_ENFORCE_PRECONDITION` | 409 | REQUIRED 전환 조건 미충족 |
| `SSO_PASSWORD_DISABLED` | 403 | 강제 대상의 비밀번호 변경 |
| `SSO_SESSION_REQUIRED` | 403 | 강제 대상이 비밀번호 세션으로 PAT 발급(D6) |
| `AUTH_SSO_REQUIRED` | 403/400 | 강제 대상의 비밀번호 로그인·가입 |
- 리다이렉트 오류는 `/login?ssoError=<CODE>`(값은 위 목록 화이트리스트, 프런트는 목록 밖이면 일반 오류).

## 11. 완료 기준(E2 전체)
1. Google·Entra·Okta 프리셋과 일반 OIDC로 구성 CRUD를 두 사이클 반복해도 고아 행이 없고, 비밀 원문이 어떤 응답·로그·감사에도 나오지 않는다.
2. 가짜 OIDC IdP로 신규(JIT)·초대·기존 계정 연결(비밀번호+2FA)·재로그인이 모두 통과하고, 6.2의 검증 항목마다 실패 테스트가 하나씩 있다.
3. 같은 이메일 기존 사용자에게 link 확인 없이 세션이 발급되는 경로가 없다(테스트).
4. REQUIRED에서 6.5 표의 각 지점이 테스트로 확인된다(소유자 우회, 게스트 제외, 개별 제외 포함).
5. 구성 끄기·삭제·연결 해제 후 그 SSO 세션 토큰이 401이고 소켓이 끊긴다.
6. SAML: 정상 1건 통과, 9.2의 공격 픽스처 전부 거부, 재사용 거부.
7. 데스크톱: 시스템 브라우저 → 딥링크 → 로그인, verifier 없는 티켓 교환 거부.
8. 실행 중 외부 접속은 `ssoHttp.ts`의 백채널뿐이고(테스트에서 다른 경로의 fetch 호출 0), `self-contained-assets.md`에 예외가 적혀 있다.
9. 새 UI 문자열은 전부 번역 키, ko 누락 0. 오류 code 전부 `errors.json`에 있다.
10. `docs/security/nodejs-security.md` 10절 점검과 새 의존성(jose, node-saml) 점검 결과가 PR에 있다.

## 12. 관련 파일(slawk 기준)
- 인증·세션: `app/backend/src/routes/auth.ts`, `app/backend/src/middleware/auth.ts`, `app/backend/src/services/sessionService.ts`, `sessionRotation.ts`, `mfaService.ts`, `settingsCache.ts`, `app/backend/src/routes/tokens.ts`, `sessions.ts`
- 비밀·감사·오류: `app/backend/src/utils/secretBox.ts`, `auditLog.ts`, `errorCodes.ts`, `attemptLimiter.ts`, `app/backend/src/config.ts`
- OAuth 인가 서버(역할 구분, 공용 함수 이동만): `app/backend/src/services/oauthService.ts`, `app/backend/src/routes/oauth.ts`, `wellKnown.ts`
- 조직: `app/backend/src/routes/org.ts`, `app/backend/src/services/workspaceService.ts`, `workspaceMemberService.ts`, `defaultChannelService.ts`
- 새 파일: `app/backend/src/services/sso/{connectionService,ssoHttp,oidcMetadata,oidcLogin,identityService,samlLogin,samlGuards}.ts`, `app/backend/src/routes/{sso,orgSso}.ts`, `app/backend/src/utils/{cookies,pkce,publicOrigin}.ts`, `app/backend/src/tests/helpers/{fakeOidcIdp,fakeSamlIdp}.ts`, `app/backend/src/tests/sso-*.test.ts`
- 스키마: `app/backend/prisma/schema.prisma`, `app/backend/prisma/migrations/20261103010000_add_sso/`
- 프런트: `app/frontend/src/components/Auth/LoginPage.tsx`, `RegisterPage.tsx`, 새 `SsoCompletePage.tsx`·`SsoLinkPage.tsx`·`SsoTestResultPage.tsx`, `app/frontend/src/components/Admin/AdminSecurityTab.tsx`(또는 E1h의 조직 관리 화면), 새 `AdminSsoSection.tsx`, `app/frontend/src/stores/useAuthStore.ts`, `app/frontend/src/lib/api.ts`, `app/frontend/src/App.tsx`, `app/frontend/src/locales/*/errors.json` 등
- 데스크톱: `app/desktop/src/main/main.ts`, `policy.ts`, `security.ts`, `app/desktop/src/preload/*`, `app/desktop/electron-builder.yml`
- 문서: `docs/architecture/self-contained-assets.md`(예외 2), `docs/security/nodejs-security.md`(SSO 점검 항목), `scripts/external-urls.allow`

## 13. 총괄 결정 요청
| # | 쟁점 | 제안 | 대안 |
|---|---|---|---|
| D1 | E2a 선행 | **E1e 머지 후 시작**(`OrganizationSetting`에 SSO 필드) | E1e 전에 `WorkspaceSetting`(id=1)에 넣고 E1e가 옮김 — E1e 이전 SQL이 커짐 |
| D2 | OIDC 라이브러리 | **`jose` 직접 의존 + 흐름 직접 구현** | `openid-client` v6 |
| D3 | IdP 비밀 암호화 키 | **새 환경 변수 `SSO_ENCRYPTION_KEY`(32바이트)**. 없으면 OIDC 구성 저장 불가(503 `SSO_NOT_CONFIGURED`). TOTP 키와 분리해 한쪽 유출·교체가 다른 쪽에 번지지 않게 | `TOTP_ENCRYPTION_KEY`를 aad만 달리해 재사용(설정 하나 줄음) |
| D4 | 기존 계정 연결 | **비밀번호(+2FA) 확인 필수, 자동 연결 없음**. 비밀번호를 모르는 사용자는 당분간 관리자 도움 불가(비밀번호 재설정 기능이 생기면 해소) | 조직 설정 "IdP 이메일로 자동 연결" 옵션(기본 꺼짐) 추가 — 관리자가 사용자로 로그인할 수 있는 길이 생김 |
| D5 | 소유자 우회 | **켬 기본, 우회 비밀번호 로그인은 2FA가 켜진 소유자만**, 감사 `sso.owner_bypass_login` | 2FA 조건 없이 우회(Slack 방식, S40) |
| D6 | 강제 대상의 새 PAT | **SSO 세션에서만 발급**, 기존 PAT 유지 | 제한 없음 / REQUIRED 전환 시 PAT 일괄 폐기 |
| D7 | IdP 이메일 변경 동기화 | **기본 꺼짐**. 켜면 새 이메일이 같은 구성 도메인이고 다른 사용자와 겹치지 않을 때만 바꾸고 tokenVersion은 올리지 않음 | 항상 동기화 / 동기화 안 함(옵션 자체 없음) |
| D8 | 데스크톱 딥링크 스킴 이름 | `slackclone-desktop`(브랜드 이름 회피, 프로젝트 정식 이름이 정해지면 교체) | 루프백 리다이렉트(앱이 127.0.0.1 임시 포트를 열어 받음 — 방화벽 경고 가능) |
| D9 | SAML IdP 시작 흐름 | **기본 꺼짐, 구성별 옵션**. 켜면 3분 창 + 재사용 방지만으로 받음 | 지원 안 함 |
| D10 | 로그아웃 | **로컬만**(S41과 같음). RP 시작 로그아웃·백채널 로그아웃은 후속 | E2c에 OIDC `end_session_endpoint` 리다이렉트 포함 |
| D11 | SAML 서명 요구 | **Assertion 서명 필수(Response 서명은 있으면 검증)**, SHA-1 거부 | Response 서명 필수(Slack 방식, S41) — Entra 기본값과 다를 수 있음 |
| D12 | SSO 세션 수명 | `ssoSessionMaxHours` 조직 설정(없으면 전역) | 전역 설정만 |
| D13 | 사설망 IdP | **`SSO_ALLOW_PRIVATE_IDP=true`일 때만** 허용, 루프백·링크로컬은 운영에서 항상 거부 | 사설망 항상 허용(사내 설치형 기본) |
| D14 | 파트 모델 | E2a·E2b·E2c·E2e **opus**(인증·보안), E2d·E2f sonnet | E2c sonnet(파일이 익숙한 E7 담당자라면) |

### 13.1 총괄 결정 (2026-11-01 06:45)
D1~D7, D9~D14는 **제안안으로 확정**한다. D8만 바꾼다.
- **D8 변경**: 데스크톱 딥링크 스킴은 `teammessenger`로 한다. 제안안 `slackclone-desktop`은 브랜드 이름 복사 금지(CLAUDE.md 5장)에 걸리고, 데스크톱 앱 이름(PR #45 "Team Messenger")과 맞춘다.
- **D4 보완**: 비밀번호를 모르는 기존 사용자의 연결 구제 경로(조직 관리자가 연결 요청을 승인하는 흐름)는 E2c 이후 후속 파트로 보드에 올린다.
- 순서: E1e가 머지된 뒤 E2a를 시작한다(D1). E2a→E2b→E2c 직렬, 이후 E2d·E2e·E2f 병렬.

## 14. 나중에 확인할 목록(브라우저·실계정 필요)
1. 실습 워크스페이스가 SSO를 쓰는지, 로그인 화면의 SSO 버튼·홈 영역 발견 순서(이메일 먼저인지 버튼 먼저인지). 쓰기 없음, 관찰만.
2. Slack 데스크톱 앱이 SSO 때 시스템 브라우저를 여는지, 돌아오는 딥링크 형식(REA로 데스크톱 앱의 프로토콜 등록 확인 가능 — `inspect_desktop_application`).
3. 총괄 수동 점검: 실제 Google Workspace·Entra 테넌트·Okta 개발자 조직으로 각 프리셋 1회 로그인(테스트 계정, 끝나면 구성 삭제).
