-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('MENTION', 'CHANNEL_MENTION', 'HERE_MENTION', 'THREAD_REPLY', 'REACTION');

-- CreateTable
CREATE TABLE "Activity" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "actorId" INTEGER NOT NULL,
    "type" "ActivityType" NOT NULL,
    "messageId" INTEGER,
    "dmId" INTEGER,
    "channelId" INTEGER,
    "emoji" VARCHAR(50),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Activity_userId_readAt_createdAt_idx" ON "Activity"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Activity_messageId_idx" ON "Activity"("messageId");

-- CreateIndex
CREATE INDEX "Activity_dmId_idx" ON "Activity"("dmId");

-- CreateIndex
CREATE INDEX "Activity_userId_channelId_readAt_idx" ON "Activity"("userId", "channelId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_userId_type_messageId_dmId_actorId_emoji_key" ON "Activity"("userId", "type", "messageId", "dmId", "actorId", "emoji");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
