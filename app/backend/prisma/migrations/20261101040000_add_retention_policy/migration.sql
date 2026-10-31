-- 데이터 보존 정책(E5)과 법적 보존 플래그(E6 자리)
ALTER TABLE "User" ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Channel" ADD COLUMN "retentionDays" INTEGER,
ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false;

-- 채널 보존 일수는 null(상속), 0(이 채널만 무기한), 1 이상만 허용한다
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_retentionDays_check" CHECK ("retentionDays" IS NULL OR "retentionDays" >= 0);

CREATE TABLE "WorkspaceSetting" (
    "id" INTEGER NOT NULL,
    "messageRetentionDays" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceSetting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkspaceSetting_messageRetentionDays_check" CHECK ("messageRetentionDays" IS NULL OR "messageRetentionDays" >= 1)
);

-- 보존 정리가 오래된 DM을 createdAt으로 찾는다(채널 메시지는 [channelId, createdAt] 인덱스가 이미 있다)
CREATE INDEX "DirectMessage_createdAt_id_idx" ON "DirectMessage"("createdAt", "id");
