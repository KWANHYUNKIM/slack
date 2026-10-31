-- 그룹 DM: DMGroup/DMGroupMember를 추가하고 DirectMessage.toUserId를 nullable로 바꾼 뒤 groupId를 더한다.
-- 기존 1:1 행은 groupId = NULL, toUserId는 그대로라 아래 CHECK 제약을 만족한다(데이터 변경 없음).

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "dmGroupId" INTEGER;

-- AlterTable
ALTER TABLE "DirectMessage" ADD COLUMN     "groupId" INTEGER,
ALTER COLUMN "toUserId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "DMGroup" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100),
    "memberKey" VARCHAR(255) NOT NULL,
    "createdBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DMGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DMGroupMember" (
    "groupId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "lastReadDmId" INTEGER,
    "starredAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DMGroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DMGroup_memberKey_key" ON "DMGroup"("memberKey");

-- CreateIndex
CREATE INDEX "DMGroupMember_userId_idx" ON "DMGroupMember"("userId");

-- CreateIndex
CREATE INDEX "Activity_userId_dmGroupId_readAt_idx" ON "Activity"("userId", "dmGroupId", "readAt");

-- CreateIndex
CREATE INDEX "DirectMessage_groupId_createdAt_idx" ON "DirectMessage"("groupId", "createdAt");

-- AddForeignKey
ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DMGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DMGroupMember" ADD CONSTRAINT "DMGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DMGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DMGroupMember" ADD CONSTRAINT "DMGroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 1:1 메시지는 toUserId, 그룹 메시지는 groupId 중 정확히 하나만 가진다.
ALTER TABLE "DirectMessage" ADD CONSTRAINT "DirectMessage_target_check" CHECK (("toUserId" IS NULL) <> ("groupId" IS NULL));
