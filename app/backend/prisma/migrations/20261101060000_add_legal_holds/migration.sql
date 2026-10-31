-- CreateTable
CREATE TABLE "LegalHold" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(1000),
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" INTEGER,

    CONSTRAINT "LegalHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalHoldCustodian" (
    "holdId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "addedBy" INTEGER,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalHoldCustodian_pkey" PRIMARY KEY ("holdId","userId")
);

-- CreateIndex
CREATE INDEX "LegalHold_releasedAt_idx" ON "LegalHold"("releasedAt");

-- CreateIndex
CREATE INDEX "LegalHoldCustodian_userId_idx" ON "LegalHoldCustodian"("userId");

-- AddForeignKey
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_releasedBy_fkey" FOREIGN KEY ("releasedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalHoldCustodian" ADD CONSTRAINT "LegalHoldCustodian_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "LegalHold"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegalHoldCustodian" ADD CONSTRAINT "LegalHoldCustodian_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: 소프트 삭제로 분리된 첨부의 원래 메시지(FK 없음)
ALTER TABLE "File" ADD COLUMN "detachedFromMessageId" INTEGER,
ADD COLUMN "detachedFromDmId" INTEGER;

-- CreateIndex
CREATE INDEX "File_detachedFromMessageId_idx" ON "File"("detachedFromMessageId");

-- CreateIndex
CREATE INDEX "File_detachedFromDmId_idx" ON "File"("detachedFromDmId");

-- E5에서 User.legalHold를 직접 켠 사용자가 있으면 그 상태를 보존 건 하나로 옮긴다.
-- 이제 legalHold는 활성 보존 건에서 계산되므로, 옮기지 않으면 다음 동기화 때 꺼져 데이터가 정리될 수 있다.
INSERT INTO "LegalHold" ("name", "description", "createdAt", "updatedAt")
SELECT 'Migrated legal hold', 'Users who had the legal hold flag before legal hold cases existed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "User" WHERE "legalHold" = true);

INSERT INTO "LegalHoldCustodian" ("holdId", "userId", "addedAt")
SELECT h."id", u."id", CURRENT_TIMESTAMP
FROM "User" u
CROSS JOIN (SELECT max("id") AS "id" FROM "LegalHold") h
WHERE u."legalHold" = true AND h."id" IS NOT NULL;
