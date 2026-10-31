# E1 조직과 멀티 워크스페이스 (설계 스펙)

작성: planner-1, 2026-11-01. 상위 문서: `docs/architecture/enterprise-and-distribution.md` 3절 E1.
근거 조사: `docs/research/enterprise-grid.md`(R1~R12 번호는 그 문서의 출처 번호).
이 문서는 설계 스펙이고, 개발은 9절의 파트(E1a~E1h) 단위로 배정한다. 총괄 결정이 필요한 항목은 11절에 모았다.

## 0. 요약
- **조직(Organization) 1개 + 워크스페이스(Workspace) N개.** 사용자 계정(User)은 조직에 하나이고, 워크스페이스 참여는 `WorkspaceMember`(역할 포함)로 표현한다.
- **채널은 워크스페이스에 속한다.** 다만 저장은 `ChannelWorkspace`(채널이 보이는 워크스페이스 목록)로 해서, 처음부터 조직 내부 공유 채널을 같은 모델로 다룬다. 채널 이름의 유일성은 워크스페이스 단위다.
- **DM과 그룹 DM은 조직 단위**다(워크스페이스에 붙이지 않는다). 상대와 같은 워크스페이스를 하나 이상 공유해야 새 DM을 시작할 수 있다.
- **거버넌스(2FA 강제, OAuth 앱 허용, 감사 로그, 법적 보존, eDiscovery, DLP)는 조직 단위**, 보존 기간은 조직 기본값 + 워크스페이스 재정의.
- **현재 워크스페이스는 `X-Workspace-Id` 헤더로 받는다.** 채널·메시지처럼 id가 있는 리소스는 리소스에서 워크스페이스를 역산해 검사한다. 서브도메인은 쓰지 않는다.
- **기존 데이터는 기본 조직 1개·기본 워크스페이스 1개로 무중단 이전**한다. 헤더가 없으면 사용자의 기본 워크스페이스로 해석하므로, 프런트를 바꾸기 전에도 기존 클라이언트가 그대로 동작한다.
- Slack Connect(조직 사이 공유)는 범위 밖이다.

## 1. 기능 설명

### 1.1 사용자 관점
1. 한 번 로그인하면(조직 계정) 내가 속한 워크스페이스가 왼쪽 레일에 나란히 보이고, 눌러서 전환한다. 전환해도 다시 로그인하지 않는다.
2. 사이드바의 채널 목록, 채널 찾아보기, 멤버 디렉터리, 기본 검색 범위는 **현재 워크스페이스** 기준이다.
3. DM·그룹 DM 목록은 어느 워크스페이스에서 봐도 같다(조직 단위).
4. 공유 채널은 공유된 모든 워크스페이스의 사이드바에 같은 채널(같은 id, 같은 메시지)로 보이고, 공유 표시 아이콘이 붙는다.
5. 공개(Open) 워크스페이스는 "워크스페이스 찾아보기"에서 직접 참여할 수 있고, 초대 전용(Invite only)은 초대 링크로만 들어간다.

### 1.2 관리자 관점
| 주체 | 할 수 있는 일(E1 범위) |
|---|---|
| 조직 소유자·관리자(`OrgRole.OWNER/ADMIN`) | 워크스페이스 생성·수정·보관, 사용자를 워크스페이스에 배정·제거, 조직 정책(2FA, OAuth 앱, 보존 기본값, DLP, 법적 보존, eDiscovery, 감사 로그), 채널 공유 |
| 워크스페이스 소유자·관리자(`WorkspaceMember.role OWNER/ADMIN`) | 자기 워크스페이스의 멤버 관리, 초대, 채널 관리(지금 `/admin`의 채널·멤버·초대·웹훅 탭), 보존 기간 재정의(조직이 잠그지 않았을 때) |
| 워크스페이스 멤버·게스트 | 지금과 같음. 게스트 여부는 워크스페이스마다 다를 수 있다 |
- 조직 소유자라고 모든 워크스페이스의 관리자가 되지는 않는다(R10). 단, 조직 관리 API는 모든 워크스페이스에 대해 동작한다.
- 세부 역할 분리(조직 주 소유자 이전, 사용자 정의 역할, 채널 관리자)는 E8이다.

## 2. 현재 코드 분석(이미 구현 / 부족 / 없음)

기준: `main` 905d268 + 머지 예정 `feat/mcp-oauth`(20261101080000_add_oauth), `feat/group-membership-history`(20261101090000).

| 영역 | 현재 상태 | 분류 | E1에서 할 일 |
|---|---|---|---|
| 조직·워크스페이스 모델 | 없음. 서버 = 워크스페이스 1개라는 암묵 전제 | 없음 | `Organization`, `Workspace`, `WorkspaceMember` 추가 |
| 사용자 역할 | `User.role`(OWNER/ADMIN/MEMBER/GUEST) 하나. JWT payload와 토큰 캐시(`middleware/auth.ts`)가 role을 들고 있고, 라우트·서비스 66곳이 `req.user.role`을 본다 | 부족 | `User.orgRole` + `WorkspaceMember.role`로 분리. 호환 심(3.4절)으로 기존 66곳을 바로 고치지 않는다 |
| 채널 | `Channel.name @unique`(전역), 이름 중복 검사는 대소문자 무시(`routes/channels.ts:44`, `channelService.ts:44`). `GET /channels`는 전체 공개 채널 | 부족 | 워크스페이스 소속, 이름 유일성을 워크스페이스 단위로 |
| 기본 채널 | `defaultChannelService.ts`가 이름 `general`, `random`으로 전역 검색 | 부족 | 워크스페이스마다 기본 채널(`Workspace.defaultChannelIds` 대신 `ChannelWorkspace.isDefault`) |
| 채널 멤버십 인가 | `authorize.ts`의 `requireChannelMembership`, `requireMessageAccess`, `verifyFileAccess` 등은 채널 멤버십만 본다 | 이미 구현(대부분 재사용) | 채널 멤버이면 그 채널을 볼 권한은 충분. 추가로 **가입·초대 시점**에 워크스페이스 멤버십 검사 |
| DM·그룹 DM | `DirectMessage`, `DMGroup`(memberKey 전역 유일), 게스트 격리 규칙 | 이미 구현 | 조직 단위로 유지. "새 DM 시작"에 공유 워크스페이스 검사 추가 |
| 사용자 목록 | `GET /users`는 전체 사용자, `GET /users/:id`는 누구나 | 부족 | 현재 워크스페이스 멤버로 한정, 단건은 같은 워크스페이스를 공유할 때만 |
| 초대 | `InviteLink`(역할 포함), `/auth/register`, `/auth/invite/:code` | 부족 | 초대에 `workspaceId`. 로그인한 기존 사용자의 초대 수락 경로 추가 |
| 워크스페이스 설정 | `WorkspaceSetting` id=1 단일 행: `messageRetentionDays`, `requireMfa`, (OAuth 브랜치) `allowOAuthApps`. `mfaService.ts`, `retentionService.ts`가 직접 id=1 사용 | 부족 | `OrganizationSetting`(조직 정책) + `WorkspaceSetting`(workspaceId PK, 재정의) 분리 |
| 감사 로그 | `AuditLog`에 위치 정보 없음 | 부족 | `organizationId`, `workspaceId?` 추가, 조회 필터 |
| 법적 보존·eDiscovery | `LegalHold`, `LegalHoldCustodian`, `ediscoveryService` 전역 | 이미 구현(조직 단위로 그대로 맞음) | 결과에 워크스페이스 표시, 워크스페이스 필터 |
| DLP | `DlpRule.name @unique` 전역 | 이미 구현(조직 단위) | `organizationId`만. 워크스페이스별 규칙은 범위 밖 |
| 보존 정리 | 채널 `retentionDays` → 워크스페이스 기본(id=1) | 부족 | 채널 → 채널의 호스트 워크스페이스 재정의 → 조직 기본 순서 |
| 소켓 room | `user:<id>`, `channel:<id>`, `dm:<a>-<b>`(`docs/architecture/events.md`) | 이미 구현(전역 id라 그대로 씀) | `ws:<workspaceId>` room 추가 |
| 전체 방송 | `io.emit`이 4곳: `channelService.ts:106 channel:updated`, `admin.ts:555 channel:deleted`, `admin.ts:601 channel:archived`, `admin.ts:646 channel:unarchived` | **누출** | 채널이 보이는 워크스페이스 room으로만 |
| presence | 같은 채널·DM을 쓰는 사용자에게만(`websocket/index.ts:306, 775`) | 이미 구현 | 변경 없음 |
| 검색 | `searchService.ts` 전역(멤버 채널 + 공개 채널) | 부족 | 공개 채널 결과는 현재(또는 지정) 워크스페이스로 한정, 사람 탭은 워크스페이스 멤버 |
| 활동·안 읽음·스레드 모아보기 | 사용자 단위 | 부족 | 채널 항목을 현재 워크스페이스로 거르는 옵션, 워크스페이스별 안 읽음 합계(전환기 배지) |
| 사이드바 설정 | `SidebarPref.userId @id` | 부족 | (userId, workspaceId) 단위 |
| MCP | 17개 도구(`mcp/server.ts`), PAT·OAuth 토큰은 사용자 단위 | 부족 | 토큰은 조직 단위 유지, 목록형 도구에 `workspaceId` 인자와 결과 필드 추가, `list_workspaces` 도구 |
| 관리자 미들웨어 | `adminAuth.ts`의 `requireAdmin`/`requireOwner`가 `req.user.role` | 부족 | 워크스페이스 관리자(`requireWorkspaceAdmin`)와 조직 관리자(`requireOrgAdmin`) 분리 |
| 프런트 라우팅 | `/c/:channelId`, `/d/:userId`, `/g/:groupId`, `/admin` 등(`App.tsx:657~697`) | 부족 | `/w/:workspaceId/...` 접두와 옛 경로 리다이렉트, 전환기 |
| 사용자 그룹(14) | 없음 | 없음 | E1 범위 밖(E9 선행) |
| Slack Connect | 없음 | 없음 | 범위 밖 |

## 3. 데이터 모델

### 3.1 새 모델(Prisma 초안)
```prisma
enum OrgRole {
  OWNER      // 조직 소유자. primaryOwnerId가 주 소유자
  ADMIN
  MEMBER
}

enum WorkspaceDiscoverability {
  OPEN         // 조직 멤버 누구나 목록에서 보고 참여
  INVITE_ONLY  // 목록에는 보이지만 초대·관리자 배정으로만
  HIDDEN       // 목록에 안 보임, 초대·배정으로만
}

model Organization {
  id             Int      @id @default(autoincrement())
  name           String   @db.VarChar(100)
  primaryOwnerId Int?     // E8에서 이전 API. 사용자 삭제 시 SetNull
  createdAt      DateTime @default(now())
  updatedAt      DateTime @default(now()) @updatedAt

  workspaces Workspace[]
  users      User[]
  setting    OrganizationSetting?
}

model Workspace {
  id              Int                      @id @default(autoincrement())
  organizationId  Int
  slug            String                   @db.VarChar(21)  // 소문자·숫자·하이픈. 조직 안에서 유일(R5 21자)
  name            String                   @db.VarChar(100)
  description     String?                  @db.VarChar(500)
  discoverability WorkspaceDiscoverability @default(INVITE_ONLY)
  icon            String?                  @db.VarChar(500) // 업로드 파일 경로(외부 URL 금지, 규칙 17)
  createdBy       Int?
  archivedAt      DateTime?
  createdAt       DateTime                 @default(now())
  updatedAt       DateTime                 @default(now()) @updatedAt

  organization Organization       @relation(fields: [organizationId], references: [id], onDelete: Restrict)
  members      WorkspaceMember[]
  channels     ChannelWorkspace[]
  hostedChannels Channel[]        @relation("ChannelHost")
  setting      WorkspaceSetting?
  inviteLinks  InviteLink[]

  @@unique([organizationId, slug])
  @@unique([organizationId, name])
  @@index([organizationId, archivedAt])
}

// 사용자의 워크스페이스 참여. 나가거나 제거되면 행을 지우지 않고 leftAt을 채운다(재참여 시 갱신, 감사·eDiscovery용).
model WorkspaceMember {
  workspaceId Int
  userId      Int
  role        Role      @default(MEMBER)   // 기존 enum 재사용(OWNER/ADMIN/MEMBER/GUEST)
  joinedAt    DateTime  @default(now())
  leftAt      DateTime?
  invitedBy   Int?

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([workspaceId, userId])
  @@index([userId, leftAt])
  @@index([workspaceId, leftAt, role])
}

// 채널이 보이는 워크스페이스. 모든 채널은 호스트 행(isHost=true) 1개를 가진다. 공유하면 행이 늘어난다.
// name은 Channel.name을 복사한 값이고 nameKey는 lower(name). 이름 유일성은 이 표에서 워크스페이스 단위로 강제한다.
model ChannelWorkspace {
  channelId   Int
  workspaceId Int
  isHost      Boolean  @default(false)
  isDefault   Boolean  @default(false) // 새 멤버가 자동으로 들어가는 기본 채널
  nameKey     String   @db.VarChar(80)
  sharedBy    Int?
  sharedAt    DateTime @default(now())

  channel   Channel   @relation(fields: [channelId], references: [id], onDelete: Cascade)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@id([channelId, workspaceId])
  @@unique([workspaceId, nameKey])
  @@index([workspaceId, isDefault])
}

// 조직 정책(기존 WorkspaceSetting id=1의 후신). organizationId가 PK.
model OrganizationSetting {
  organizationId       Int      @id
  messageRetentionDays Int?     // 조직 기본. null이면 무기한
  retentionLocked      Boolean  @default(false) // true면 워크스페이스 재정의 금지(R9 잠금)
  requireMfa           Boolean  @default(false)
  allowOAuthApps       Boolean  @default(true)
  updatedAt            DateTime @default(now()) @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
}

// 워크스페이스 재정의. 행이 없거나 값이 null이면 조직 값을 따른다.
model WorkspaceSetting {
  workspaceId          Int      @id
  messageRetentionDays Int?     // 0=무기한, N=N일, null=조직 기본
  updatedAt            DateTime @default(now()) @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
}
```

### 3.2 기존 모델 변경
| 모델 | 변경 | 이유 |
|---|---|---|
| `User` | `organizationId Int`(FK, NOT NULL, 백필 후), `orgRole OrgRole @default(MEMBER)`, `defaultWorkspaceId Int?`(마지막으로 쓴 워크스페이스, 헤더 없을 때 해석용). `role`은 E1a~E1g 동안 **읽기 전용 호환 컬럼**으로 남기고 E1h에서 삭제 | 계정은 조직 단위. `email @unique`는 전역 유지(11절 D1: 서버당 조직 1개) |
| `Channel` | `workspaceId Int`(호스트 워크스페이스, FK `ChannelHost`), `name @unique` 제거(유일성은 `ChannelWorkspace.nameKey`) | 보존 재정의·관리 권한의 기준이 되는 호스트. 공유 여부와 무관하게 하나 |
| `InviteLink` | `workspaceId Int`(FK) | 초대는 워크스페이스로 들어온다 |
| `AuditLog` | `organizationId Int?`, `workspaceId Int?`(FK 없이, 워크스페이스 보관·삭제 후에도 기록 유지), `@@index([organizationId, createdAt])`, `@@index([workspaceId, createdAt])` | R11의 context.location |
| `LegalHold`, `DlpRule` | `organizationId Int`(백필 1). `DlpRule.name @unique` → `@@unique([organizationId, name])`, `key @unique` → `@@unique([organizationId, key])` | 조직 단위 정책 |
| `SidebarPref` | PK `userId` → `@@id([userId, workspaceId])`(workspaceId 추가) | 워크스페이스마다 접기 상태가 다르다 |
| `Activity` | `workspaceId Int?`(채널 활동이면 채널 호스트 워크스페이스, DM이면 null), `@@index([userId, workspaceId, readAt])` | 전환기 배지와 워크스페이스 필터. 공유 채널 활동은 null이 아니라 호스트 id를 넣고, 필터는 `ChannelWorkspace` 조인으로 한다(아래 3.3) |
| `OAuthClient`, `OAuthToken`, `PersonalAccessToken` | 변경 없음(조직 단위 토큰, 사용자가 속한 모든 워크스페이스) | R2의 조직 단위 설치와 같은 모양. 워크스페이스 제한 토큰은 후속 |
| 기존 `WorkspaceSetting`(id=1) | 값을 `OrganizationSetting`(organizationId=1)으로 옮기고 표 구조를 3.1의 `WorkspaceSetting`으로 교체 | 4.3 이전 순서 참고 |

### 3.3 workspaceId를 붙이는 테이블과 안 붙이는 테이블
| 붙인다(직접) | `Channel`(호스트), `ChannelWorkspace`, `WorkspaceMember`, `InviteLink`, `WorkspaceSetting`, `SidebarPref`, `Activity`(nullable), `AuditLog`(nullable) |
|---|---|
| **채널을 통해 상속**(붙이지 않음) | `Message`, `Reaction`, `ChannelMember`, `ChannelRead`, `ChannelStar`, `ScheduledMessage`, `Webhook`, `Bookmark`, `ThreadRead`, 채널 메시지 첨부 `File`. 채널 id가 전역 유일이고 채널이 여러 워크스페이스에 공유될 수 있으므로 복제하면 공유 시 일관성이 깨진다 |
| **조직 단위**(organizationId 또는 없음) | `User`, `DirectMessage`, `DMGroup`, `DMGroupMember`, `DMGroupMembership`, `DMReaction`, `DMStar`, DM 첨부 `File`, `Reminder`, `PushSubscription`, `Session`, `Mfa*`, `PersonalAccessToken`, `OAuth*`, `LegalHold*`, `DlpRule`, `OrganizationSetting` |
- 서버당 조직이 1개(D1)이므로 조직 단위 테이블에는 E1에서 `organizationId`를 굳이 붙이지 않는다. 예외는 조직 정책 표(`LegalHold`, `DlpRule`, `AuditLog`)로, 조회 필터와 유일 제약에 쓰므로 붙인다.

### 3.4 역할 해석과 호환 심
- `req.user.orgRole`: `User.orgRole`.
- `req.workspace = { id, role }`: 3.5의 미들웨어가 채운다.
- **호환 심**: 미들웨어는 `req.user.role = req.workspace.role`로 덮어쓴다. 그러면 기존 66곳의 `req.user.role === 'ADMIN'` 같은 검사가 "현재 워크스페이스 관리자"라는 뜻으로 그대로 동작한다. 기존 데이터는 백필로 `WorkspaceMember.role = User.role`이 되므로 기본 워크스페이스에서 결과가 같다.
- 조직 관리 API(`/org/*`)와 조직 정책 API(보존 기본값, 2FA, OAuth, DLP, 법적 보존, eDiscovery, 감사 로그)는 `requireOrgAdmin`(`orgRole in (OWNER, ADMIN)`)으로 바꾼다. 백필은 기존 `User.role OWNER → orgRole OWNER`, `ADMIN → orgRole ADMIN`이라 기존 관리자는 계속 쓸 수 있다.
- E8은 이 위에 조직 주 소유자 이전, 워크스페이스 관리자 권한 세분화, 채널 관리자를 얹는다.

### 3.5 인덱스와 제약 요약
- `Workspace @@unique([organizationId, slug])`, `@@unique([organizationId, name])`(R5 `domain_taken`, `name_taken_in_org`).
- `ChannelWorkspace @@unique([workspaceId, nameKey])`: 채널 생성·이름 변경·공유가 모두 이 제약에 걸린다. 이름 변경은 해당 채널의 모든 `ChannelWorkspace.nameKey`를 한 트랜잭션에서 고친다. 충돌(P2002)은 `CHANNEL_NAME_TAKEN`으로 바꾼다.
- `Channel.name @unique` 삭제. 채널 이름 유니코드 파트(`feat/channel-name-unicode`)가 머지되면 nameKey 정규화 규칙(lower + NFC)을 그쪽 `lib/channelName` 규칙과 맞춘다.
- `WorkspaceMember @@index([userId, leftAt])`: 내 워크스페이스 목록과 인증 캐시. `@@index([workspaceId, leftAt, role])`: 멤버 디렉터리와 관리자 찾기.

## 4. 기존 데이터 이전(무중단)

### 4.1 원칙
- 한 번의 `prisma migrate deploy`로 끝나야 하고(`entrypoint.sh`), 서버 코드가 이전 전 상태와 이전 후 상태 양쪽에서 잠깐 함께 돌 수 있게 **확장 → 백필 → 코드 전환 → 축소** 순서를 지킨다.
- 축소(옛 컬럼 삭제: `User.role`, `Channel.name @unique` 같은 것)는 코드가 새 구조만 쓰게 된 뒤 별도 마이그레이션(E1h)에서 한다.

### 4.2 E1a 마이그레이션 SQL 골격(`20261102010000_add_organizations_workspaces`)
```sql
-- 1) 확장
CREATE TYPE "OrgRole" AS ENUM ('OWNER','ADMIN','MEMBER');
CREATE TYPE "WorkspaceDiscoverability" AS ENUM ('OPEN','INVITE_ONLY','HIDDEN');
CREATE TABLE "Organization" (...);
CREATE TABLE "Workspace" (...);
CREATE TABLE "WorkspaceMember" (...);
CREATE TABLE "ChannelWorkspace" (...);
ALTER TABLE "User" ADD COLUMN "organizationId" INTEGER, ADD COLUMN "orgRole" "OrgRole" NOT NULL DEFAULT 'MEMBER', ADD COLUMN "defaultWorkspaceId" INTEGER;
ALTER TABLE "Channel" ADD COLUMN "workspaceId" INTEGER;
ALTER TABLE "InviteLink" ADD COLUMN "workspaceId" INTEGER;

-- 2) 백필: 기본 조직 1, 기본 워크스페이스 1 (빈 DB여도 만든다. 첫 OWNER 부트스트랩이 이 행을 쓴다)
INSERT INTO "Organization" (id, name) VALUES (1, 'Organization');
INSERT INTO "Workspace" (id, "organizationId", slug, name, discoverability) VALUES (1, 1, 'main', 'Workspace', 'INVITE_ONLY');
SELECT setval(pg_get_serial_sequence('"Organization"','id'), 1);
SELECT setval(pg_get_serial_sequence('"Workspace"','id'), 1);
UPDATE "User" SET "organizationId" = 1, "defaultWorkspaceId" = 1,
  "orgRole" = CASE role WHEN 'OWNER' THEN 'OWNER'::"OrgRole" WHEN 'ADMIN' THEN 'ADMIN'::"OrgRole" ELSE 'MEMBER'::"OrgRole" END;
UPDATE "Organization" SET "primaryOwnerId" = (SELECT id FROM "User" WHERE role = 'OWNER' ORDER BY id LIMIT 1) WHERE id = 1;
INSERT INTO "WorkspaceMember" ("workspaceId","userId",role,"joinedAt")
  SELECT 1, id, role, "createdAt" FROM "User";          -- 비활성 사용자도 넣는다(계정 비활성과 멤버십은 별개 축)
UPDATE "Channel" SET "workspaceId" = 1;
INSERT INTO "ChannelWorkspace" ("channelId","workspaceId","isHost","isDefault","nameKey")
  SELECT id, 1, true, (name IN ('general','random') AND "isPrivate" = false), lower(name) FROM "Channel";
UPDATE "InviteLink" SET "workspaceId" = 1;

-- 3) 제약 강화
ALTER TABLE "User" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Channel" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "InviteLink" ALTER COLUMN "workspaceId" SET NOT NULL;
-- FK, 인덱스 생성. Channel.name 유니크는 E1h까지 유지(옛 코드 경로 보호). 단 새 워크스페이스에서 같은 이름을
-- 만들려면 삭제가 필요하므로 E1c에서 제거한다(9절 마이그레이션 표).
```
- 기본 조직·워크스페이스 이름은 번역 키가 아니라 데이터다. 첫 OWNER가 관리 화면에서 바꾼다. `create-owner` CLI에 `--org-name`, `--workspace-name` 선택 인자를 추가한다(E1b).
- 기존 기본 채널(`general`, `random`)은 `isDefault=true`로 표시하고, 이후 `defaultChannelService`는 이름이 아니라 `ChannelWorkspace.isDefault`로 찾는다.
- 백필 검증 테스트: 사용자·채널·초대가 있는 DB에 마이그레이션을 적용한 뒤 행 수(`User = WorkspaceMember`, `Channel = ChannelWorkspace(isHost)`)와 역할 매핑을 확인한다(`tests/e1-migration.test.ts`, 마이그레이션 직후 상태를 seed SQL로 재현).

### 4.3 설정 표 이전(E1e, `20261102040000_split_org_workspace_settings`)
1. `OrganizationSetting` 생성, `INSERT ... SELECT 1, "messageRetentionDays", "requireMfa", "allowOAuthApps" FROM "WorkspaceSetting" WHERE id = 1`(행이 없으면 기본값 행).
2. 옛 `WorkspaceSetting`을 `WorkspaceSetting_old`로 이름 바꾸고 새 `WorkspaceSetting`(workspaceId PK) 생성, 옛 표 삭제.
3. `mfaService.ts`, `retentionService.ts`, (OAuth) `allowOAuthApps` 조회 코드를 같은 PR에서 새 표로 바꾼다. 같은 PR이어야 배포 사이에 깨지지 않는다.

## 5. 권한과 격리

### 5.1 현재 워크스페이스 해석: 헤더 방식
| 후보 | 장점 | 단점 | 결론 |
|---|---|---|---|
| 서브도메인(`acme.example.com`) | Slack 웹과 비슷 | 자체 호스팅에 와일드카드 DNS·TLS 필요, 데스크톱 셸은 서버 주소 하나를 저장(1절), socket.io 쿠키·CORS·CSP 설정이 워크스페이스마다 달라짐, LAN 시험 불가 | 쓰지 않음 |
| API 경로(`/w/:id/channels`) | 요청만 봐도 범위가 보임 | `app.ts`의 마운트 27개와 프런트 `api.ts` 호출 전부 변경, MCP·웹훅 URL도 변경. 한 루프에 못 끝냄 | 쓰지 않음 |
| **헤더 `X-Workspace-Id`** + 리소스 역산 | 기존 라우트를 그대로 두고 미들웨어 하나로 도입, 헤더가 없으면 기본 워크스페이스로 해석해 점진 전환, 프런트는 `api.ts` 한 곳에서 주입 | 요청 로그에서 범위가 덜 보임(로그에 workspaceId를 남겨 보완) | **채택** |
- 프런트 **페이지 URL**은 `/w/:workspaceId/c/:channelId`처럼 경로에 워크스페이스를 넣는다(분석 대상 `app.slack.com/client/<team>/<channel>`과 같은 구조). API 경로와는 별개다.

### 5.2 미들웨어 `resolveWorkspace`(`middleware/workspace.ts`, E1b)
1. `authMiddleware` 다음에 전역으로 건다(`/auth/*`, `/mcp`, `/webhooks/:token` 수신, 정적 파일 제외. `/mcp`는 도구가 인자로 직접 해석한다).
2. 헤더 `X-Workspace-Id`가 있으면 정수 검증 후 사용, 없으면 `User.defaultWorkspaceId`, 그것도 없거나 이미 나간 곳이면 가장 먼저 참여한 활성 워크스페이스.
3. 그 워크스페이스에 활성 멤버십(`leftAt IS NULL`)이 없거나 워크스페이스가 보관됐으면 **404 `WORKSPACE_NOT_FOUND`**(존재 여부를 숨긴다). 조직 관리자라도 멤버가 아니면 일반 API에서는 404이고, 관리 작업은 `/org/*`로 한다.
4. `req.workspace = { id, role, organizationId }`, 호환 심 `req.user.role = role`.
5. 활성 워크스페이스가 하나도 없으면 403 `NO_WORKSPACE`(프런트는 "워크스페이스 찾아보기·초대 대기" 화면).
6. 캐시: `auth.ts`의 토큰 캐시와 같은 5초 TTL로 `userId → [{ workspaceId, role }]`를 캐시하고, 멤버십 변경 API에서 `invalidateTokenCache`와 함께 비운다.

### 5.3 리소스 역산 규칙
| 요청 종류 | 규칙 |
|---|---|
| 목록·생성(`GET/POST /channels`, `GET /users`, `GET /search`, `GET /unreads`, `GET /threads`, `GET /activity`, `/admin/channels`, `/admin/users`, `/admin/invites`, `/admin/webhooks`) | `req.workspace.id`로 거른다 |
| 채널 리소스(`/channels/:id/*`, `/messages/:id/*`, 파일) | 지금처럼 채널 멤버십으로 판정. **비멤버 공개 채널 읽기·참여**(`requirePublicChannelReadAccess`, `POST /channels/:id/join`)는 채널의 `ChannelWorkspace`에 사용자가 활성 멤버인 워크스페이스가 있어야 한다. 없으면 404 |
| 채널 멤버 추가(`POST /channels/:id/members`, `/admin/channels/:id/members`) | 추가 대상이 채널의 워크스페이스 중 하나에 활성 멤버여야 한다. 아니면 400 `USER_NOT_IN_WORKSPACE` |
| DM(`/dms/:userId`, 그룹 생성·추가) | 새 대화 시작과 그룹 멤버 추가는 두 사용자가 활성 워크스페이스를 하나 이상 공유해야 한다. 기존 대화의 읽기·답장은 계속 허용(11절 D3). 게스트 규칙은 기존대로 |
| 사용자 단건(`GET /users/:id`, presence) | 공유 워크스페이스가 있거나 DM 이력이 있으면 보임, 아니면 404 |
| 워크스페이스에서 제거될 때 | 그 워크스페이스만의 채널(`ChannelWorkspace`가 그 워크스페이스뿐인 채널)에서 `ChannelMember` 삭제, 공유 채널은 남은 워크스페이스에 여전히 멤버이면 유지. 즐겨찾기·읽음 행은 채널 멤버 삭제 규칙을 따른다 |

### 5.4 소켓
- 연결 시 활성 멤버십마다 `ws:<workspaceId>` room에 참여한다. 멤버십 추가·제거 API는 그 사용자의 모든 소켓에 `socket.join/leave`를 한다(`io.in('user:<id>').socketsJoin(...)`).
- **`io.emit` 4곳을 없앤다**: 공개 채널 이벤트는 `ChannelWorkspace`의 워크스페이스마다 `io.to(['ws:1','ws:3'])`로 보낸다(socket.io의 배열 대상은 중복 수신을 막는다). 비공개 채널은 지금처럼 멤버 `user:<id>`.
- 채널 관련 이벤트 payload에 `workspaceIds: number[]`(채널이 보이는 워크스페이스)를 추가한다. 클라이언트는 현재 워크스페이스가 아니면 사이드바 목록만 갱신하고 화면은 그대로 둔다.
- 새 이벤트(`docs/architecture/events.md`에 E1 절로 등록):

| 이벤트 | 대상 room | payload | 시점 |
|---|---|---|---|
| `workspace:member:added` | `user:<대상>`, `ws:<id>`(디렉터리 갱신) | `{ workspaceId, userId, role }` | 배정, 초대 수락, 공개 워크스페이스 참여 |
| `workspace:member:removed` | `user:<대상>`, `ws:<id>` | `{ workspaceId, userId }` | 제거, 나가기. 대상 클라이언트는 그 워크스페이스를 전환기에서 빼고 room을 떠난다 |
| `workspace:member:updated` | `user:<대상>`, `ws:<id>` | `{ workspaceId, userId, role }` | 역할 변경 |
| `workspace:updated` | `ws:<id>` | `{ id, slug, name, icon, discoverability }` | 이름·아이콘 등 변경 |
| `workspace:archived` | `ws:<id>` | `{ id }` | 보관 |
| `channel:shared` / `channel:unshared` | 추가·제외된 `ws:<id>`(공개), 멤버 `user:<id>`(비공개) | `{ channelId, workspaceIds }` | 공유 변경(E1g) |

### 5.5 기능별 범위(조직 vs 워크스페이스)
| 기능 | 범위 | 상세 |
|---|---|---|
| 검색 | 기본 현재 워크스페이스 + 내 DM. `workspace=all`이면 내 모든 워크스페이스 | 공개 채널 "멤버 아님" 결과는 해당 워크스페이스의 채널만. 사람 탭은 워크스페이스 멤버 |
| MCP | 토큰은 조직 단위 | 새 도구 `list_workspaces`. `list_channels`, `list_users`, `search`, `list_files`에 선택 인자 `workspaceId`(없으면 모든 워크스페이스, 결과에 `workspaceIds` 표시). 채널·메시지 id 기반 도구는 채널 멤버십 규칙 그대로. `docs/architecture/mcp.md` 4절 갱신 |
| eDiscovery | 조직 | 결과 항목에 채널의 워크스페이스 표시, 선택 필터 `workspaceId` |
| 법적 보존 | 조직 | 변경 없음(사용자 단위). 채널 보존 플래그는 채널 단위 그대로 |
| 보존 정리 | 채널 → 호스트 워크스페이스 재정의 → 조직 기본. DM은 조직 기본 | `retentionService.ts`의 기본값 조회를 채널별 해석으로 |
| DLP | 조직 | 규칙은 조직 하나에 공통 |
| 감사 로그 | 조직 | 모든 기록에 `organizationId`, 워크스페이스 안에서 일어난 일은 `workspaceId`. 조직 관리자는 전체, 워크스페이스 관리자는 자기 워크스페이스 기록만(E8에서 세분) |
| 2FA 강제, OAuth 앱 허용 | 조직 | `OrganizationSetting` |
| 초대 | 워크스페이스 | 워크스페이스 관리자가 만든다 |
| 웹훅 | 채널(→워크스페이스) | 관리 목록은 현재 워크스페이스 채널의 웹훅 |
| 허들 | 채널 | 변경 없음 |

### 5.6 교차 워크스페이스 누출 방지 테스트 전략
1. **공용 픽스처** `tests/helpers/workspaces.ts`: 워크스페이스 A, B와 사용자 `a`(A만), `b`(B만), `ab`(둘 다), `orgAdmin`(조직 관리자, A만 멤버), 게스트 `ga`(A 게스트). A·B에 공개·비공개 채널, 같은 이름 `general`을 하나씩.
2. **누출 매트릭스 테스트** `tests/workspace-isolation.test.ts`: 사용자 `a`가 B의 리소스에 대해 (1) 목록에 안 보이고 (2) id로 직접 접근하면 404이며 (3) 소켓 이벤트를 받지 않음을 표로 돌린다. 대상: 채널 목록·단건·참여·멤버 목록·파일·핀, 메시지 읽기, 검색 4탭, 사용자 목록·단건·presence, 초대·웹훅 관리, 워크스페이스 단건, MCP `list_channels`·`search`·`list_users`, `channel:updated`·`channel:archived`·`channel:deleted`·`workspace:updated`.
3. **헤더 위조**: `a`가 `X-Workspace-Id: B`를 보내면 404, 숫자가 아닌 값은 400, 보관된 워크스페이스는 404.
4. **양쪽 멤버 `ab`**: 헤더에 따라 같은 이름 `general` 두 개 중 맞는 것이 보이는지, 공유 채널은 두 워크스페이스에서 같은 id로 보이는지.
5. **정적 검사(선택)**: `tests/workspace-scope-lint.test.ts`가 `routes/`·`services/`에서 `prisma.channel.findMany`·`prisma.user.findMany`·`prisma.inviteLink.findMany` 호출을 찾아, 허용 목록(범위 헬퍼를 쓰는 파일)에 없으면 실패시킨다. 기존 `error-code-coverage.test.ts`와 같은 방식. R3의 "기존 테스트를 조직 컨텍스트로 다시 돌리기"는 비용이 커서 하지 않고, 기존 테스트는 기본 워크스페이스에서 그대로 통과해야 한다는 조건으로 대신한다.
6. CRUD 반복: 워크스페이스·멤버·채널·공유를 각각 생성 → 조회 → 수정 → 삭제(보관·제거·해제) → 삭제 후 조회 실패를 테스트로 남긴다(`docs/conventions/backend.md` 5절).

## 6. API 변경 목록

### 6.1 새 API
| 메서드·경로 | 권한 | 설명 | 오류 code |
|---|---|---|---|
| `GET /workspaces` | 로그인 | 내 활성 워크스페이스 목록 `{ workspaces: [{ id, slug, name, icon, role, unreadCount? }] }` | |
| `GET /workspaces/discover` | 로그인 | 조직의 OPEN·INVITE_ONLY 워크스페이스(HIDDEN 제외), 내 참여 여부 | |
| `POST /workspaces/:id/join` | 로그인 | OPEN만. 멤버로 참여, 기본 채널 가입 | `WORKSPACE_NOT_FOUND`, `WORKSPACE_NOT_OPEN` |
| `POST /workspaces/:id/leave` | 멤버 | 나가기. 마지막 OWNER는 거부 | `LAST_WORKSPACE_OWNER` |
| `PUT /users/me/default-workspace` | 멤버 | `{ workspaceId }` 전환 시 기억 | |
| `GET /workspaces/:id/members` | 멤버 | 디렉터리(기존 `GET /users`와 같은 모양) | |
| `POST /workspaces/:id/members` | 워크스페이스 관리자, 조직 관리자 | `{ userId, role?, channelIds? }`(R6 assign). 조직 사용자만 | `USER_ALREADY_WORKSPACE_MEMBER`, `USER_NOT_FOUND` |
| `PATCH /workspaces/:id/members/:userId` | 같음 | `{ role }`. OWNER 지정은 워크스페이스 OWNER·조직 관리자만 | `LAST_WORKSPACE_OWNER` |
| `DELETE /workspaces/:id/members/:userId` | 같음 | 제거(R6 remove). `leftAt` 기록, 5.3 채널 정리 | `CANNOT_REMOVE_PRIMARY_OWNER` |
| `GET /org` | 조직 관리자 | 조직 정보 | |
| `PATCH /org` | 조직 OWNER | `{ name }` | |
| `GET /org/workspaces` | 조직 관리자 | 보관 포함 전체, 멤버 수 | |
| `POST /org/workspaces` | 조직 관리자 | `{ slug, name, description?, discoverability? }`(R5). 만든 사람이 워크스페이스 OWNER, 기본 채널 `general` 생성 | `WORKSPACE_SLUG_TAKEN`, `WORKSPACE_NAME_TAKEN`, `INVALID_WORKSPACE_SLUG` |
| `PATCH /org/workspaces/:id` | 조직 관리자, 그 워크스페이스 OWNER | 이름·설명·접근 수준·아이콘 | 같음 |
| `POST /org/workspaces/:id/archive`, `/unarchive` | 조직 관리자 | 보관(하드 삭제 없음, 11절 D6). 마지막 활성 워크스페이스는 거부 | `LAST_WORKSPACE` |
| `GET /org/users` | 조직 관리자 | 조직 전체 사용자와 소속 워크스페이스(`teams[]`, R2) | |
| `PATCH /org/users/:id` | 조직 OWNER | `{ orgRole }` | |
| `GET /org/settings`, `PATCH /org/settings` | 조직 관리자 | 보존 기본값·잠금, 2FA, OAuth 허용(기존 `/admin/settings/security`, `/admin/retention`의 조직 부분 이동) | |
| `GET/PATCH /workspaces/:id/settings` | 워크스페이스 관리자 | 보존 재정의(잠금이면 거부) | `SETTING_LOCKED_BY_ORG` |
| `POST /auth/invite/:code/accept` | 로그인 | 기존 계정이 초대를 받아 워크스페이스에 참여 | `INVITE_INVALID` |
| `GET /channels/:id/workspaces`, `PUT /channels/:id/workspaces` | 조직 관리자, 또는 호스트·대상 양쪽 워크스페이스 관리자(R9) | 공유 대상 목록 조회와 교체 `{ workspaceIds }`(R8). 호스트는 뺄 수 없다 | `CHANNEL_NAME_TAKEN`(대상 워크스페이스 이름 충돌), `CANNOT_UNSHARE_HOST` |
- 오류 code는 `utils/errorCodes.ts`에 등록하고 프런트 `apiErrorCodes.ts`·번역 키를 함께 추가한다(i18n 규칙).

### 6.2 기존 API 변경
| API | 변경 |
|---|---|
| 모든 인증 API | `X-Workspace-Id` 헤더 해석(5.2). 응답 헤더 `X-Workspace-Id`로 실제 해석된 값을 돌려준다(디버그와 프런트 확인용) |
| `POST /auth/register`(초대) | 초대의 워크스페이스에 `WorkspaceMember` 생성, `organizationId`·`defaultWorkspaceId` 설정, 그 워크스페이스 기본 채널 가입 |
| `POST /auth/login` 응답, `GET /users/me` | `organization: { id, name }`, `orgRole`, `workspaces[]`, `defaultWorkspaceId` 추가. `role`은 기본 워크스페이스 역할(호환) |
| `POST /channels` | 현재 워크스페이스에 생성, `ChannelWorkspace` 호스트 행 |
| `GET /channels`, 채널 찾아보기 | 현재 워크스페이스 채널(공유 포함)만, 항목에 `workspaceIds`, `isShared` |
| `PATCH /channels/:id`(이름) | 모든 `ChannelWorkspace.nameKey` 갱신, 충돌 시 `CHANNEL_NAME_TAKEN` |
| `GET /users` | 현재 워크스페이스 활성 멤버 |
| `GET /search` | `workspace=current|all|<id>` 파라미터(기본 current) |
| `GET /unreads`, `GET /threads`, `GET /activity` | 채널 항목은 현재 워크스페이스로 거름, DM 항목은 그대로. `GET /workspaces`에 워크스페이스별 안 읽음 합계 |
| `/admin/*`(채널·멤버·초대·웹훅) | 현재 워크스페이스로 범위 한정, 권한은 워크스페이스 관리자 |
| `/admin/audit-logs`, `/admin/retention`, `/admin/dlp`, `/admin/legal-holds`, `/admin/ediscovery`, `/admin/settings/security` | 조직 관리자 권한으로 변경, 감사 로그는 `workspaceId` 필터 |
| `GET/PATCH /users/me/sidebar` | 현재 워크스페이스 기준 |
| `create-owner` CLI | 기본 조직·워크스페이스를 쓰고 이름 인자 선택 |

## 7. 프런트 변경 목록
| 항목 | 내용 | 파일 |
|---|---|---|
| URL 구조 | `/w/:workspaceId/c/:channelId`, `/w/:workspaceId/d/:userId`, `/w/:workspaceId/g/:groupId`, `.../m/:messageId`, `/w/:workspaceId/(files|unreads|later|threads|search|activity|admin)`. 조직 관리는 `/org/admin` | `App.tsx` |
| 옛 URL 호환 | `/c/:id[...]`는 채널의 `workspaceIds` 중 현재(또는 기본) 워크스페이스로 리다이렉트, `/d`·`/g`는 기본 워크스페이스로. 퍼머링크 파서는 두 형식을 모두 받는다 | `App.tsx`(`DefaultRedirect`), `lib/permalink.ts`, `hooks/usePermalinkSync.ts` |
| 워크스페이스 id 결정 | 경로 `:workspaceId` → 스토어 `currentWorkspaceId` → `defaultWorkspaceId` 순 | 새 `stores/useWorkspaceStore.ts` |
| API 헤더 | 모든 요청에 `X-Workspace-Id: currentWorkspaceId` | `lib/api.ts`(fetch 래퍼 3곳: 17, 75, 732, 790행 근처) |
| 전환기 | 왼쪽 세로 레일: 워크스페이스 아이콘(이니셜 대체), 안 읽음 점·멘션 숫자, `+`(만들기·찾아보기), 단축키 `Ctrl/Cmd+1..9` | 새 `components/Layout/WorkspaceRail.tsx`, `AppLayout.tsx`, `lib/shortcuts.ts` |
| 전환 동작 | 스토어의 채널·메시지·안 읽음·스레드·활동 캐시를 워크스페이스 키로 나누거나 비우고 다시 불러온다(DM 스토어는 유지). 소켓은 끊지 않는다 | `stores/useChannelStore.ts`, `useMessageStore.ts`, `useUnreadStore.ts`, `useThreadStore.ts`, `useActivityStore.ts` |
| 소켓 | 채널 이벤트의 `workspaceIds`로 현재 워크스페이스가 아니면 사이드바만 갱신. `workspace:*` 처리 | `lib/socket.ts`, 각 스토어 |
| 워크스페이스 찾아보기·참여·나가기 | 모달 | 새 `components/Workspace/*` |
| 초대 수락(로그인 상태) | `/invite/:code`에서 "참여" 버튼 | `components/Auth/*` |
| 공유 채널 표시 | 채널 이름 옆 공유 아이콘(자체 SVG), 채널 상세에 공유 워크스페이스 목록 | `Sidebar/ChannelItem.tsx`, 채널 상세 |
| 관리 화면 | `/w/:id/admin`은 워크스페이스 관리(기존 탭 중 채널·멤버·초대·웹훅), `/org/admin`은 조직(워크스페이스, 사용자, 보안, 보존, DLP, 법적 보존, 감사 로그) | `components/Admin/AdminPage.tsx` 분할, 새 `AdminWorkspacesTab.tsx` |
| 데스크톱 | 딥링크 `teammessenger://` 경로에 워크스페이스 포함, 독 배지는 전체 합 | `app/desktop`, `hooks/useDesktopBridge.ts` |
| 번역 | 새 네임스페이스 `workspace.json`(ko, en), 하드코딩 금지 | `locales/*/workspace.json` |

## 8. 완료 기준(E1 전체)
1. 기존 DB에 마이그레이션을 적용하면 데이터 손실 없이 기본 조직·워크스페이스로 옮겨지고, 기존 백엔드 테스트 전체가 헤더 없이 통과한다.
2. 조직 관리자가 워크스페이스 B를 만들고(C), 목록에서 보고(R), 이름·접근 수준을 바꾸고(U), 보관한다(D). 보관 후 B의 API 접근은 404.
3. 사용자를 B에 배정·역할 변경·제거하는 CRUD가 동작하고, 제거된 사용자는 B 전용 채널에서 빠지며 소켓으로 즉시 반영된다.
4. A와 B에 같은 이름의 채널을 만들 수 있고, 같은 워크스페이스 안에서는 대소문자 무시로 충돌한다.
5. 5.6의 누출 매트릭스 테스트가 모두 통과한다(특히 `channel:updated`·`archived`·`deleted`가 다른 워크스페이스 소켓에 가지 않는다).
6. 채널을 A에서 B로 공유하면 B 사이드바에 같은 채널이 보이고 메시지가 실시간으로 양쪽에 간다. 이름 충돌이면 거부된다. 공유를 해제하면 B에서만 사라지고 메시지는 남는다.
7. DM은 워크스페이스를 바꿔도 같은 목록이고, 워크스페이스를 공유하지 않는 사용자와 새 DM을 시작할 수 없다.
8. 감사 로그에 워크스페이스 위치가 남고, 조직 관리자는 워크스페이스로 거를 수 있다. 보존 정리가 워크스페이스 재정의를 따른다.
9. MCP `list_workspaces`가 동작하고 `list_channels`에 `workspaceId`를 주면 그 워크스페이스 채널만 나온다.
10. 웹에서 전환기로 워크스페이스를 바꾸면 URL·사이드바·검색 범위가 바뀌고, 옛 `/c/:id` 링크가 새 URL로 리다이렉트된다. 한국어 번역 누락 0.
11. 보안 점검(`docs/security/nodejs-security.md` 3절 인가, 10절 루프 점검)에서 새 엔드포인트의 권한 실패 테스트가 있다.

## 9. 파트 분할
schema.prisma를 바꾸는 파트는 동시에 진행하지 않는다(`docs/conventions/backend.md` 4절). 마이그레이션은 머지 예정인 `20261101080000_add_oauth`, `20261101090000_add_dm_group_membership_history` 뒤에 붙고, **E1a 시작 전에 두 PR이 main에 머지돼 있어야 한다**(`WorkspaceSetting.allowOAuthApps`, `DMGroupMembership`을 이전 SQL이 다룬다).

| 파트 | 범위 | 선행 | 마이그레이션 | 예상 | 모델 | 충돌 위험 파일 |
|---|---|---|---|---|---|---|
| **E1a 스키마와 백필** | 3.1의 `Organization`·`Workspace`·`WorkspaceMember`·`ChannelWorkspace`, `User.organizationId/orgRole/defaultWorkspaceId`, `Channel.workspaceId`, `InviteLink.workspaceId`, 4.2 백필. 동작 변경 없음. 채널 생성·이름 변경·가입·`defaultChannelService`·`bootstrapService`·`create-owner`가 새 행(`ChannelWorkspace`, `WorkspaceMember`)을 함께 쓰도록 최소 수정. `tests/setup.ts` 정리 순서. 백필 테스트 | OAuth·그룹 이력 PR 머지 | `20261102010000_add_organizations_workspaces` | 2h | **opus** | `schema.prisma`, `routes/channels.ts`, `services/channelService.ts`, `defaultChannelService.ts`, `bootstrapService.ts`, `routes/auth.ts`, `tests/setup.ts` |
| **E1b 워크스페이스 컨텍스트와 API** | `middleware/workspace.ts`(5.2, 호환 심, 캐시), `requireWorkspaceAdmin`·`requireOrgAdmin`, `/workspaces/*`·`/org/*` 워크스페이스·멤버 CRUD(6.1, 공유 채널 제외), 소켓 `ws:<id>` room과 `workspace:*` 이벤트, 로그인·`/users/me` 응답 확장, 초대 수락, `events.md` 등록. 테스트 픽스처 `tests/helpers/workspaces.ts` | E1a | 없음 | 2h | **opus** | `app.ts`, `middleware/auth.ts`, `middleware/adminAuth.ts`, `types.ts`, `websocket/index.ts`, `routes/auth.ts`, `routes/users.ts` |
| **E1c 채널·사용자·관리 범위 격리** | `GET/POST /channels`·찾아보기·가입·멤버 추가의 워크스페이스 검사(5.3), `Channel.name` 유니크 제거, `io.emit` 4곳 제거(5.4), `GET /users`·`/users/:id`·presence, `/admin` 채널·멤버·초대·웹훅 범위, 워크스페이스 제거 시 채널 정리, 누출 매트릭스 1차(채널·사용자·소켓) | E1b | `20261102020000_drop_channel_name_global_unique` | 2h | **opus** | `routes/channels.ts`, `routes/admin.ts`, `services/channelService.ts`, `middleware/authorize.ts`, `routes/users.ts`, `websocket/index.ts` |
| **E1d DM·검색·활동·MCP 범위** | DM·그룹 DM 새 대화의 공유 워크스페이스 검사, 검색 `workspace` 파라미터, 활동·안 읽음·스레드 모아보기 필터, 워크스페이스별 안 읽음 합계, `SidebarPref` 워크스페이스 단위, `Activity.workspaceId`, MCP `list_workspaces`와 `workspaceId` 인자, `mcp.md` 갱신, 누출 매트릭스 2차(검색·MCP·DM) | E1c | `20261102030000_workspace_scoped_prefs_activity` | 2h | sonnet(실패 2회면 opus) | `services/searchService.ts`, `routes/search.ts`, `routes/dms.ts`, `services/dmGroupService.ts`, `services/mentionService.ts`, `routes/unreads.ts`, `routes/thread-list.ts`, `routes/activity.ts`, `mcp/*` |
| **E1e 조직 거버넌스 분리** | `OrganizationSetting`·`WorkspaceSetting` 분리(4.3), `mfaService`·`retentionService`·OAuth 허용 조회 이전, 보존 재정의·잠금, `AuditLog.organizationId/workspaceId`와 기록 헬퍼(`auditLogService`가 `req.workspace`를 받음), 감사 로그 필터, `LegalHold`·`DlpRule.organizationId`, eDiscovery 결과의 워크스페이스 표시, `/org/settings`, 관리 API 권한을 조직 관리자로 | E1b(E1c·E1d와 파일은 거의 안 겹치지만 스키마 순서상 E1d 뒤) | `20261102040000_split_org_workspace_settings`, `20261102050000_org_scope_audit_dlp_holds` | 2h | sonnet | `services/retentionService.ts`, `mfaService.ts`, `auditLogService.ts`, `dlpService.ts`, `ediscoveryService.ts`, `routes/admin*.ts`, OAuth 라우트 |
| **E1f 프런트 전환기와 URL** | 7절의 URL 구조·옛 URL 리다이렉트·`useWorkspaceStore`·API 헤더·워크스페이스 레일·전환 시 스토어 초기화·소켓 필터·찾아보기·참여·나가기·초대 수락 화면·번역 | E1b(API), E1c 머지 후 권장 | 없음 | 2h | sonnet | `App.tsx`, `lib/api.ts`, `lib/socket.ts`, `lib/permalink.ts`, `components/Layout/AppLayout.tsx`, `components/Sidebar/Sidebar.tsx`, 스토어 다수 |
| **E1g 조직 내부 공유 채널** | `GET/PUT /channels/:id/workspaces`, 이름 충돌 검사, 해제 시 멤버 정리(5.3 규칙), `channel:shared/unshared`, 공유 채널 관리 권한(조직 관리자 또는 양쪽 워크스페이스 관리자), 보존 기준은 호스트, 프런트 공유 표시·공유 대화상자, 테스트(공유 CRUD 반복) | E1c, E1f | 없음(E1a의 `ChannelWorkspace` 사용) | 2h | **opus** | `routes/channels.ts`, `services/channelService.ts`, `websocket/index.ts`, `components/Sidebar/ChannelItem.tsx`, 채널 상세 |
| **E1h 관리 화면 분리와 정리** | `/org/admin`(워크스페이스 CRUD, 조직 사용자와 소속, 조직 설정 탭 이동), `/w/:id/admin` 축소, `User.role` 컬럼 삭제와 남은 참조 제거(호환 심은 유지하되 원천을 `WorkspaceMember`로만), 정적 범위 검사 테스트(5.6-5), 최종 누출 매트릭스 전체 실행 | E1e, E1f, E1g | `20261102060000_drop_user_role` | 2h | sonnet | `components/Admin/*`, `routes/admin.ts`, `schema.prisma`, 테스트 |

- 병렬 가능성: E1a → E1b → E1c는 직렬. E1c 뒤에 E1d(백엔드)와 E1f(프런트)는 파일이 겹치지 않아 동시에 가능하나, E1d는 스키마를 바꾸므로 다른 스키마 파트와는 동시 불가. E1e는 E1d 머지 뒤. E1g는 E1c·E1f 뒤. E1h는 마지막.
- 총 예상 16h(8파트 × 2h), 자원 감속 단계면 직렬로 약 4~5루프.

### 9.1 E1 위에 올라가는 파트와 의존
| 후속 | E1에서 받는 것 | 필요한 E1 파트 |
|---|---|---|
| E2 SSO | SSO 설정은 `OrganizationSetting`(또는 별도 `SsoConnection`에 `organizationId`). 조직 단위 강제는 `resolveWorkspace` 앞 단계(로그인)에서. JIT 가입 시 기본 워크스페이스 배정 규칙 | E1a, E1b, E1e |
| E3 SCIM | `/scim/v2/Users`는 조직 사용자(`User`), `/Groups`는 E9·14의 사용자 그룹, 워크스페이스 배정은 `WorkspaceMember` API(6.1)를 재사용. 비활성(`active=false`)은 계정 축(`deactivatedAt`), 워크스페이스 제거와 구분 | E1b, E1h(역할 정리) + E2 |
| E8 관리자 역할 세분화 | `OrgRole`, `WorkspaceMember.role`, `requireOrgAdmin`·`requireWorkspaceAdmin`, `Organization.primaryOwnerId`. E8은 주 소유자 이전, 사용자 정의 역할, 채널 관리자, 감사 로그 열람 범위 세분화 | E1b, E1e, E1h |
| E9 정보 장벽 | DM 시작과 채널 멤버 추가에 들어간 "공유 워크스페이스 검사" 지점(5.3)을 정책 훅으로 일반화. 사용자 그룹(14) 필요 | E1c, E1d + 14 |
| E5·E6·E10(이미 구현) | 조직 단위로 옮기는 수정만 E1e에서 | E1e |
| MCP(mcp-1~4) | 도구 범위 인자. OAuth 조직 정책(`allowOAuthApps`)은 `OrganizationSetting` | E1d, E1e |

## 10. 관련 파일(slawk 기준)
- 스키마·마이그레이션: `app/backend/prisma/schema.prisma`, `app/backend/prisma/migrations/`
- 인증·인가: `app/backend/src/middleware/auth.ts`, `authorize.ts`, `adminAuth.ts`, `accessTokenAuth.ts`, `app/backend/src/types.ts`, `app/backend/src/app.ts`
- 채널·사용자·관리: `app/backend/src/routes/channels.ts`, `users.ts`, `admin.ts`, `auth.ts`, `app/backend/src/services/channelService.ts`, `defaultChannelService.ts`, `bootstrapService.ts`, `app/backend/src/scripts/create-owner.ts`
- 거버넌스: `app/backend/src/services/retentionService.ts`, `mfaService.ts`, `auditLogService.ts`, `dlpService.ts`, `legalHoldService.ts`, `ediscoveryService.ts`, `app/backend/src/routes/admin{AuditLogs,Retention,Dlp,LegalHolds,Ediscovery}.ts`
- DM·검색·활동: `app/backend/src/routes/dms.ts`, `dmGroups.ts`, `search.ts`, `unreads.ts`, `thread-list.ts`, `activity.ts`, `app/backend/src/services/searchService.ts`, `dmService.ts`, `dmGroupService.ts`, `mentionService.ts`
- 소켓: `app/backend/src/websocket/index.ts`, `docs/architecture/events.md`
- MCP: `app/backend/src/mcp/server.ts`, `readTools.ts`, `searchTools.ts`, `fileTools.ts`, `dmTools.ts`, `docs/architecture/mcp.md`
- 프런트: `app/frontend/src/App.tsx`, `lib/api.ts`, `lib/socket.ts`, `lib/permalink.ts`, `components/Layout/AppLayout.tsx`, `components/Sidebar/*`, `components/Admin/*`, `stores/*`, `locales/*`
- 테스트: `app/backend/src/tests/setup.ts`, 새 `tests/helpers/workspaces.ts`, `tests/workspace-isolation.test.ts`, `tests/e1-migration.test.ts`

## 11. 총괄 결정 요청
| # | 쟁점 | 제안 | 대안 |
|---|---|---|---|
| D1 | 서버 하나에 조직을 몇 개 둘까 | **1개**(테이블은 만들되 조직 생성 API 없음). 이메일 전역 유일 유지, 조직 단위 테이블에 organizationId 생략 | 다중 조직(SaaS형): 모든 조직 단위 표에 organizationId와 유일 제약 변경 필요, E1 규모 1.5배 |
| D2 | 현재 워크스페이스 전달 | **`X-Workspace-Id` 헤더 + 리소스 역산**, 페이지 URL은 `/w/:id/...` | API 경로 접두, 서브도메인(5.1 표) |
| D3 | DM 범위 | **조직 단위**. 새 대화 시작은 공유 워크스페이스 필수, 기존 대화는 유지 | 워크스페이스 단위 DM(같은 두 사람이 워크스페이스마다 다른 대화) |
| D4 | 페이지 URL에 id와 slug 중 무엇 | **id**(slug 변경 시 링크 유지, Slack도 team id) | slug(읽기 쉬움, 이름 변경 시 리다이렉트 표 필요) |
| D5 | 검색 기본 범위 | **현재 워크스페이스 + 내 DM**, 옵션으로 전체 | 처음부터 전체(Unified Grid식) |
| D6 | 워크스페이스 삭제 | **보관만**(하드 삭제 없음, 법적 보존·eDiscovery 보호) | 하드 삭제 + 내보내기 |
| D7 | 비멤버 접근 응답 | 다른 워크스페이스 리소스는 **404**(존재 은닉). 같은 워크스페이스의 비공개 채널은 기존대로 403 유지 | 모두 403(기존 테스트와 일관) |
| D8 | 감사 로그 열람 | 조직 관리자 전체, 워크스페이스 관리자는 자기 워크스페이스만 | E8까지 조직 관리자만 |
| D9 | 워크스페이스 관리자가 조직 사용자를 자기 워크스페이스에 직접 배정 | **허용**(조직 사용자 한정, 감사 로그 기록) | 조직 관리자만 배정, 워크스페이스 관리자는 초대 링크만 |
| D10 | 토큰(PAT·OAuth) 범위 | **조직 단위**(사용자가 속한 모든 워크스페이스), 워크스페이스 제한은 후속 | 발급 시 워크스페이스 선택 |
| D11 | Slack Connect(조직 간 공유) | E1 범위 밖, 후속 연합 설계로 | - |

### 11.1 총괄 결정 (2026-11-01 04:05)
D1~D11 모두 **제안안으로 확정**한다. 근거: 기존 단일 워크스페이스 데이터와 테스트를 깨지 않는 점진 전환(D2 헤더 없으면 기본 워크스페이스), 법적 보존·eDiscovery와의 일관성(D3 DM 조직 단위, D6 보관만, D10 토큰 조직 단위), 존재 은닉으로 교차 워크스페이스 누출 최소화(D7), E1 규모 억제(D1 조직 1개, D11 Slack Connect 제외).
- 파트는 9절 순서대로 직렬 진행하고, 스키마를 바꾸는 파트(E1a, E1c, E1d, E1e, E1h)는 동시에 두 개를 열지 않는다. E1f는 E1c 머지 후 E1d와 병렬 가능.
- E1a 시작 조건: OAuth(080000)·그룹 이력(090000) PR이 main에 머지된 뒤.
- 12절 브라우저 확인은 Claude in Chrome 연결 뒤 00c 파트와 함께 한다.

## 12. 브라우저 확인 필요 목록
Claude in Chrome 미연결로 관찰하지 못했다. 연결되면 `#claude-test`에서만 확인한다(쓰기 후 삭제).
1. 워크스페이스 전환기의 위치·배지 표시, 전환 시 URL `/client/<team>/<channel>`의 변화와 네트워크 요청(부트 API가 워크스페이스별인지).
2. 공유 채널 표시 아이콘과 채널 상세의 공유 워크스페이스 목록.
3. 검색 범위 선택 UI.
4. 실습 워크스페이스가 Enterprise 조직인지(아니면 위 항목은 관찰 불가, 문서 근거 유지).
