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

-- 기존 데이터 이전: 지금 구성원마다 열린 구간(leftAt NULL) 하나를 만든다.
-- 시작 시각은 가입 시각(joinedAt)이다. 처음부터 있던 구성원은 그룹과 같은 문장에서 만들어져 joinedAt이 그룹 생성 시각과
-- 몇 ms 어긋날 수 있으므로, 생성 후 1초 안에 들어온 구성원은 그룹 생성 시각으로 당긴다.
-- 이미 나간 사람의 과거 구간은 기록이 없어 되살릴 수 없다.
INSERT INTO "DMGroupMembership" ("groupId", "userId", "joinedAt", "leftAt")
SELECT gm."groupId", gm."userId",
       CASE WHEN gm."joinedAt" < g."createdAt" + INTERVAL '1 second' THEN LEAST(gm."joinedAt", g."createdAt") ELSE gm."joinedAt" END,
       NULL
FROM "DMGroupMember" gm
JOIN "DMGroup" g ON g."id" = gm."groupId";
