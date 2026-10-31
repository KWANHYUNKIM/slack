-- CreateTable: 그룹 DM 구성원 이력(가입 구간마다 한 행, 나가면 leftAt)
CREATE TABLE "DMGroupMembership" (
    "id" SERIAL NOT NULL,
    "groupId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "DMGroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DMGroupMembership_groupId_userId_idx" ON "DMGroupMembership"("groupId", "userId");

-- CreateIndex
CREATE INDEX "DMGroupMembership_userId_idx" ON "DMGroupMembership"("userId");

-- AddForeignKey
ALTER TABLE "DMGroupMembership" ADD CONSTRAINT "DMGroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "DMGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DMGroupMembership" ADD CONSTRAINT "DMGroupMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 같은 사람의 열린 구간(지금 구성원)은 그룹마다 하나뿐이다. Prisma 스키마로 표현할 수 없는 부분 인덱스라 SQL로만 둔다.
CREATE UNIQUE INDEX "DMGroupMembership_open_key" ON "DMGroupMembership"("groupId", "userId") WHERE "leftAt" IS NULL;

-- 기존 데이터 이전: 지금 구성원마다 열린 구간(leftAt NULL) 하나를 만든다. joinedAt은 가입 시각(감사용, 범위 판단에는 쓰지 않는다).
-- 한계: 이 마이그레이션을 배포하기 전에 이미 나간 구성원의 과거 구간은 기록이 없어 복원할 수 없다.
-- 그런 사람이 대상자이면 그 그룹 DM은 eDiscovery 검색·내보내기와 보존 정리의 법적 보존 제외에서 본인이 보낸 메시지만 잡힌다.
INSERT INTO "DMGroupMembership" ("groupId", "userId", "joinedAt", "leftAt")
SELECT "groupId", "userId", "joinedAt", NULL
FROM "DMGroupMember";
