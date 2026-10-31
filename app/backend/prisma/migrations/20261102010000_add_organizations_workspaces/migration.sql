-- E1a 조직·워크스페이스 스키마와 백필 (docs/specs/E1-multi-workspace.md 3절, 4.2절)
-- 확장 → 백필 → 제약 순서. 이 마이그레이션 뒤에도 옛 코드 경로(User.role, Channel.name 전역 유니크)는 그대로 동작한다.
-- 새 컬럼은 상수 기본값 1(기본 조직·워크스페이스)을 가지므로 PostgreSQL 11+에서 표를 다시 쓰지 않고 붙는다.

-- 1) 확장
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "WorkspaceDiscoverability" AS ENUM ('OPEN', 'INVITE_ONLY', 'HIDDEN');

CREATE TABLE "Organization" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "primaryOwnerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Workspace" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "slug" VARCHAR(21) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "discoverability" "WorkspaceDiscoverability" NOT NULL DEFAULT 'INVITE_ONLY',
    "icon" VARCHAR(500),
    "createdBy" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkspaceMember" (
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "invitedBy" INTEGER,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("workspaceId","userId")
);

CREATE TABLE "ChannelWorkspace" (
    "channelId" INTEGER NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "isHost" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "nameKey" VARCHAR(80) NOT NULL,
    "sharedBy" INTEGER,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelWorkspace_pkey" PRIMARY KEY ("channelId","workspaceId")
);

ALTER TABLE "User" ADD COLUMN "organizationId" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "orgRole" "OrgRole" NOT NULL DEFAULT 'MEMBER',
ADD COLUMN "defaultWorkspaceId" INTEGER;
ALTER TABLE "Channel" ADD COLUMN "workspaceId" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "InviteLink" ADD COLUMN "workspaceId" INTEGER NOT NULL DEFAULT 1;

-- 2) 백필: 기본 조직 1, 기본 워크스페이스 1. 빈 DB여도 만든다(첫 OWNER 부트스트랩과 가입이 이 행을 쓴다).
-- 이름은 번역 키가 아니라 데이터다. 첫 OWNER가 관리 화면에서 바꾼다.
INSERT INTO "Organization" ("id", "name") VALUES (1, 'Organization');
INSERT INTO "Workspace" ("id", "organizationId", "slug", "name", "discoverability") VALUES (1, 1, 'main', 'Workspace', 'INVITE_ONLY');
-- id를 직접 넣었으므로 다음 자동 id가 2부터 나오게 맞춘다.
SELECT setval(pg_get_serial_sequence('"Organization"', 'id'), 1);
SELECT setval(pg_get_serial_sequence('"Workspace"', 'id'), 1);

-- 조직 역할은 기존 전역 역할에서 옮긴다(OWNER→OWNER, ADMIN→ADMIN, 나머지→MEMBER). 기존 관리자는 E1e 뒤에도 조직 정책을 계속 다룬다.
UPDATE "User" SET "defaultWorkspaceId" = 1,
  "orgRole" = CASE "role"
    WHEN 'OWNER' THEN 'OWNER'::"OrgRole"
    WHEN 'ADMIN' THEN 'ADMIN'::"OrgRole"
    ELSE 'MEMBER'::"OrgRole"
  END;
UPDATE "Organization" SET "primaryOwnerId" = (SELECT "id" FROM "User" WHERE "role" = 'OWNER' ORDER BY "id" LIMIT 1) WHERE "id" = 1;

-- 비활성 사용자도 넣는다(계정 비활성과 워크스페이스 멤버십은 별개 축이다).
INSERT INTO "WorkspaceMember" ("workspaceId", "userId", "role", "joinedAt")
  SELECT 1, "id", "role", "createdAt" FROM "User";

-- 모든 채널(보관·비공개 포함)을 기본 워크스페이스의 호스트 행으로 연결한다.
-- Channel.name 유니크는 대소문자를 구분하므로 옛 데이터에 'Dev'와 'dev'가 함께 있을 수 있다. nameKey 유니크(소문자)에
-- 걸리지 않게 같은 키의 두 번째 채널부터는 채널 이름에 쓸 수 없는 '~'와 채널 id를 붙인다(이름 자체는 바꾸지 않는다).
INSERT INTO "ChannelWorkspace" ("channelId", "workspaceId", "isHost", "isDefault", "nameKey", "sharedAt")
  SELECT "id", 1, true,
    ("name" IN ('general', 'random') AND "isPrivate" = false),
    CASE WHEN rn = 1 THEN key ELSE left(key, 80 - length('~' || "id")) || '~' || "id" END,
    "createdAt"
  FROM (
    SELECT "id", "name", "isPrivate", "createdAt", lower("name") AS key,
      row_number() OVER (PARTITION BY lower("name") ORDER BY "id") AS rn
    FROM "Channel"
  ) c;

-- 3) 제약과 인덱스. Channel.name 전역 유니크는 E1c까지 유지한다(옛 코드 경로 보호).
CREATE INDEX "Workspace_organizationId_archivedAt_idx" ON "Workspace"("organizationId", "archivedAt");
CREATE UNIQUE INDEX "Workspace_organizationId_slug_key" ON "Workspace"("organizationId", "slug");
CREATE UNIQUE INDEX "Workspace_organizationId_name_key" ON "Workspace"("organizationId", "name");
CREATE INDEX "WorkspaceMember_userId_leftAt_idx" ON "WorkspaceMember"("userId", "leftAt");
CREATE INDEX "WorkspaceMember_workspaceId_leftAt_role_idx" ON "WorkspaceMember"("workspaceId", "leftAt", "role");
CREATE INDEX "ChannelWorkspace_workspaceId_isDefault_idx" ON "ChannelWorkspace"("workspaceId", "isDefault");
CREATE UNIQUE INDEX "ChannelWorkspace_workspaceId_nameKey_key" ON "ChannelWorkspace"("workspaceId", "nameKey");
CREATE INDEX "Channel_workspaceId_idx" ON "Channel"("workspaceId");
CREATE INDEX "InviteLink_workspaceId_idx" ON "InviteLink"("workspaceId");

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_primaryOwnerId_fkey" FOREIGN KEY ("primaryOwnerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelWorkspace" ADD CONSTRAINT "ChannelWorkspace_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelWorkspace" ADD CONSTRAINT "ChannelWorkspace_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_defaultWorkspaceId_fkey" FOREIGN KEY ("defaultWorkspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InviteLink" ADD CONSTRAINT "InviteLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
