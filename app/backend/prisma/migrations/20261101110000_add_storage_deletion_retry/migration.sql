-- CreateTable: 보존 정리의 저장소 삭제 아웃박스(파일 행 삭제와 같은 트랜잭션에서 넣고, 본체 삭제에 성공하면 지운다)
CREATE TABLE "StorageDeletionRetry" (
    "id" SERIAL NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "gcsPath" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" VARCHAR(500),
    "lastTriedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageDeletionRetry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StorageDeletionRetry_attempts_id_idx" ON "StorageDeletionRetry"("attempts", "id");
