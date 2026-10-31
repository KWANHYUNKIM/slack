-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'REMINDER';

-- CreateTable
CREATE TABLE "Reminder" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "messageId" INTEGER,
    "dmId" INTEGER,
    "channelId" INTEGER,
    "text" VARCHAR(500),
    "remindAt" TIMESTAMP(3) NOT NULL,
    "firedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "fireSeq" INTEGER NOT NULL DEFAULT 0,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "failedAt" TIMESTAMP(3),
    "locale" VARCHAR(8),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reminder_userId_completedAt_remindAt_idx" ON "Reminder"("userId", "completedAt", "remindAt");

-- CreateIndex
CREATE INDEX "Reminder_remindAt_firedAt_idx" ON "Reminder"("remindAt", "firedAt");

-- AddForeignKey
ALTER TABLE "Reminder" ADD CONSTRAINT "Reminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Activity에 리마인더 id와 발송 회차를 더하고 unique에 포함한다(같은 대상에 리마인더가 여럿이어도, 스누즈 후 다시 울려도 활동이 겹치지 않게).
-- NULL을 같은 값으로 취급하는 unique를 이름을 유지해 다시 만든다.
ALTER TABLE "Activity" ADD COLUMN "reminderId" INTEGER;
ALTER TABLE "Activity" ADD COLUMN "reminderSeq" INTEGER;
DROP INDEX "Activity_userId_type_messageId_dmId_actorId_emoji_key";
CREATE UNIQUE INDEX "Activity_userId_type_messageId_dmId_actorId_emoji_reminderI_key"
  ON "Activity"("userId", "type", "messageId", "dmId", "actorId", "emoji", "reminderId", "reminderSeq") NULLS NOT DISTINCT;
