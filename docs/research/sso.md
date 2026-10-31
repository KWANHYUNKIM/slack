# SSO(OIDC·SAML) 조사 메모

작성: planner-1, 2026-11-01. 대상 스펙: `docs/specs/E2-sso.md`. 번호(S1~)는 스펙에서 근거로 인용한다.
브라우저 도구가 없어 실제 Slack 관리 화면은 관찰하지 못했다. Slack 동작은 공식 도움말과 Salesforce Trailhead 문서로만 정리했다(문구·디자인은 옮기지 않는다).

## 1. 표준 문서
| # | 문서 | 스펙에 쓴 내용 |
|---|---|---|
| S1 | OpenID Connect Core 1.0 — https://openid.net/specs/openid-connect-core-1_0.html | 3.1 Authorization Code Flow, 3.1.3.7 ID Token 검증 순서(iss 정확히 일치, aud에 client_id, 여러 aud면 azp, alg 허용 목록, exp/iat, nonce), 15.5.2 nonce 구현 |
| S2 | OpenID Connect Discovery 1.0 — https://openid.net/specs/openid-connect-discovery-1_0.html | `{issuer}/.well-known/openid-configuration`, 4.3 응답의 `issuer`가 요청한 issuer와 정확히 같아야 함 |
| S3 | RFC 7636 PKCE — https://www.rfc-editor.org/rfc/rfc7636 | S256만 사용. 우리 OAuth 인가 서버(mcp-4)가 이미 검증 쪽을 구현했고, SSO에서는 생성 쪽을 쓴다 |
| S4 | RFC 9700 OAuth 2.0 Security BCP — https://www.rfc-editor.org/rfc/rfc9700 | state와 PKCE로 CSRF·코드 주입 방지, 4.4 mix-up 방어(IdP별 콜백 또는 iss 확인), 정확한 redirect_uri |
| S5 | RFC 9207 인가 응답 iss 파라미터 — https://www.rfc-editor.org/rfc/rfc9207 | 콜백에 `iss`가 오면 기대 issuer와 비교(mix-up 방어) |
| S6 | RFC 8252 OAuth for Native Apps — https://www.rfc-editor.org/rfc/rfc8252 | 데스크톱은 내장 웹뷰가 아니라 시스템 브라우저로 인가(8.12), 사용자 정의 스킴 리다이렉트와 PKCE로 가로채기 방어(7.1, 8.1) |
| S7 | RFC 7517 JWK, RFC 7515 JWS — https://www.rfc-editor.org/rfc/rfc7517 | JWKS의 kid, 키 회전 시 kid가 없으면 한 번 다시 받기 |
| S8 | SAML 2.0 Core — https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf | Response/Assertion 구조, Conditions(NotBefore/NotOnOrAfter), AudienceRestriction, NameID 형식(persistent) |
| S9 | SAML 2.0 Profiles 4.1 Web Browser SSO — https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf | SP 시작 흐름, 4.1.4.3 응답 처리 규칙(Recipient=ACS, InResponseTo, NotOnOrAfter, 1회 사용 — Assertion ID 재사용 금지), IdP 시작 흐름의 위험 |
| S10 | SAML 2.0 Bindings — https://docs.oasis-open.org/security/saml/v2.0/saml-bindings-2.0-os.pdf | AuthnRequest는 HTTP-Redirect(DEFLATE+base64), Response는 HTTP-POST, RelayState 80바이트 한도 |
| S11 | OWASP SAML Security Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/SAML_Security_Cheat_Sheet.html | XML 서명 래핑(XSW) 방어: 서명이 가리키는 요소만 사용, 스키마 검증, 절대 XPath, KeyInfo 인증서 신뢰 금지, XXE 차단 |
| S12 | Somorovsky 외, "On Breaking SAML: Be Whoever You Want to Be"(USENIX Security 2012) — https://www.usenix.org/conference/usenixsecurity12/technical-sessions/presentation/somorovsky | XSW 공격 8유형. 테스트 픽스처의 기준 |
| S13 | OWASP OAuth2 Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html | 클라이언트 쪽 점검 목록 |

## 2. 라이브러리와 취약점 사례
| # | 자료 | 판단에 쓴 내용 |
|---|---|---|
| S20 | `jose`(panva) — https://github.com/panva/jose | 의존성 없음, Node `crypto` 위의 JWS/JWK 구현. 이미 `@modelcontextprotocol/sdk`의 하위 의존성(v6.2.14)으로 설치돼 있다. `jwtVerify` + `createLocalJWKSet`으로 키 캐시를 직접 통제할 수 있다 |
| S21 | `openid-client`(panva) — https://github.com/panva/openid-client | 대안. 디스커버리·PKCE·검증을 묶어 주지만 `oauth4webapi`까지 들어오고 추상화가 커서 오류 code 매핑과 로컬 가짜 IdP 주입이 오히려 번거롭다 |
| S22 | `@node-saml/node-saml` — https://github.com/node-saml/node-saml | Node에서 가장 많이 쓰는 SAML SP 구현(passport-saml의 코어). 의존: `xml-crypto`, `@xmldom/xmldom`, `xml-encryption`, `xmlbuilder` |
| S23 | WorkOS "SAMLStorm"(xml-crypto CVE-2025-29775, CVE-2025-29774) — https://workos.com/blog/samlstorm | xml-crypto ≤6.0.0의 서명 우회. node-saml, samlify 등 하위 전부 영향. 6.0.1·3.2.1·2.1.6에서 수정. **SAML은 검증된 라이브러리를 쓰되 최소 버전 고정과 우리 쪽 추가 검사(2중 방어)가 필요**하다는 근거 |
| S24 | xml-crypto CVE-2024-32962(KeyInfo 인증서로 서명 위조) | KeyInfo의 인증서를 절대 신뢰하지 않고 설정된 인증서만 쓴다 |
| S25 | Duo Labs, SAML 주석 주입(2018, CVE-2017-11427 등) — https://duo.com/blog/duo-finds-saml-vulnerabilities-affecting-multiple-implementations | NameID 텍스트 노드에 주석을 끼워 다른 사용자로 로그인. 테스트 픽스처에 포함 |
| S26 | ruby-saml CVE-2024-45409, CVE-2025-25291/25292(파서 차이) | 다른 언어지만 "서명 검증에 쓴 DOM과 값을 읽는 DOM이 다르면 뚫린다"는 교훈. 검증한 노드에서만 값을 읽는다 |

## 3. IdP별 주의점
| # | 자료 | 내용 |
|---|---|---|
| S30 | Google OIDC — https://developers.google.com/identity/openid-connect/openid-connect | issuer `https://accounts.google.com`, `email_verified`, Workspace 도메인은 `hd` 클레임(요청의 `hd`는 힌트일 뿐이므로 응답 클레임으로 검사) |
| S31 | Microsoft identity platform ID 토큰 — https://learn.microsoft.com/entra/identity-platform/id-token-claims-reference | v2 issuer `https://login.microsoftonline.com/{tenantId}/v2.0`. `/common`·`/organizations` 디스커버리의 issuer는 `{tenantid}` 자리표시자라 정확 일치 검증이 안 된다 → **테넌트 고정 issuer만 허용**. `email`은 바꿀 수 있는 디렉터리 속성이고 `email_verified`가 없다 |
| S32 | nOAuth(Descope 2023, Semperis 2025) — https://www.semperis.com/blog/noauth-abuse-alert-full-account-takeover/ | Entra `email` 클레임만 믿고 기존 계정에 연결하면 다른 테넌트가 피해자 이메일을 주장해 계정 탈취. 대책: 이메일이 아니라 (issuer, sub)로 식별, 테넌트 고정, `xms_edov`(이메일 도메인 소유 확인 선택 클레임)가 false면 거부, 기존 계정 연결은 사용자 확인 필수 |
| S33 | Okta OIDC — https://developer.okta.com/docs/reference/api/oidc/ | org 인가 서버(`https://{org}.okta.com`)와 사용자 정의 인가 서버(`.../oauth2/default`)는 issuer가 다르다. 관리자가 넣은 issuer 그대로 디스커버리 |

## 4. Slack의 SSO 동작(공식 도움말)
| # | 자료 | 정리 |
|---|---|---|
| S40 | Set up SAML single sign-on for Slack — https://slack.com/help/articles/203772216 | 요구 수준 3단계: 모든 멤버 필수 / 게스트 제외 필수(부분 필수) / 선택. 게스트가 있으면 부분 필수 권장. **워크스페이스 소유자·조직 소유자는 SSO를 우회해 이메일+비밀번호로 로그인 가능**(IdP 장애 대비). SSO를 켜면 기존 멤버에게 계정을 IdP와 "연결(bind)"하라는 메일이 가고 72시간 안에 연결. 켜는 순간 로그인돼 있던 멤버는 그대로 로그인 상태, 이후 로그인부터 IdP. 활성화 전 "구성 테스트" 단계. 최대 12개 SSO 구성(기본 + 추가 11) |
| S41 | Custom SAML single sign-on — https://slack.com/help/articles/205168057 | NameID persistent 형식 필수(고유, 바뀌지 않음), 이메일 속성 필수, 응답 서명 필수, HTTP-POST 바인딩만, SP·IdP 시작 모두 지원, JIT·SCIM 지원. **Single Logout 미지원, IdP 세션 길이 무시 — 대신 Slack 쪽 세션 기간 설정** |
| S42 | Manage single sign-on settings — https://slack.com/help/articles/220403548 | 설정 항목: SSO 필수 여부, 프로필 동기화, 이메일 변경 허용, 표시 이름 변경 허용. 조직 수준에서 멤버·게스트 SSO 제외 목록. **SSO 구성을 지우면 그 IdP로 로그인한 멤버가 모두 로그아웃** |
| S43 | Trailhead, Implement the right authentication process — https://trailhead.salesforce.com/content/learn/modules/identity-management-in-slack/implement-the-right-authentication-process | Enterprise Grid는 조직 수준에서 모든 워크스페이스에 SSO. 필수 속성은 NameID와 email. IdP를 바꾸면 NameID는 바뀌지만 이메일은 일치해야 함 |
| S44 | Trailhead, Explore Access and Security Controls — https://trailhead.salesforce.com/content/learn/modules/identity-management-in-slack/explore-access-and-security-controls | IdP 세션 정책이 있으면 Slack 세션 기간을 맞추라고 권장. 정회원의 MFA는 IdP에 맡기고, 게스트·소유자는 Slack 자체 2FA |

## 5. 우리 설계에 반영한 유추
1. Slack은 SSO 사용자를 **IdP 쪽 영구 식별자(NameID) + 이메일 일치**로 묶고, 기존 계정은 사용자가 직접 연결하게 한다(S40의 bind 메일). 우리는 메일 발송이 없으므로 **기존 비밀번호(+2FA) 확인으로 연결**한다.
2. **소유자 우회(break-glass)**, **게스트 제외 옵션**, **개별 사용자 제외 목록**을 둔다(S40, S42).
3. **SLO 미지원, 세션 길이는 우리 쪽 설정**(S41, S44). 구성 삭제·비활성화 시 그 구성으로 만든 세션 폐기(S42).
4. **SSO 로그인은 로컬 2FA를 건너뛴다**(MFA는 IdP 책임, S44). 비밀번호로 들어오는 소유자·제외 사용자에게는 기존 2FA 정책 유지.
5. **켜기 전 테스트 필수**(S40의 Test Configuration).
6. OIDC는 Slack 문서에 SAML만큼 드러나지 않는다(S43 결과도 SAML 중심). 엔터프라이즈 배포 문서(3절 E2)의 순서대로 OIDC를 먼저 구현하고, 데이터 모델은 두 프로토콜이 같은 `SsoConnection`·`SsoIdentity`를 쓰도록 맞춘다.
