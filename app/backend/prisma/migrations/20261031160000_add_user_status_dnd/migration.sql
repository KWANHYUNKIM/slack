-- AlterTable
ALTER TABLE "User" ADD COLUMN     "customStatusEmoji" VARCHAR(50),
ADD COLUMN     "customStatusExpiresAt" TIMESTAMP(3),
ADD COLUMN     "customStatusText" VARCHAR(100),
ADD COLUMN     "dndUntil" TIMESTAMP(3),
ADD COLUMN     "dndWithStatus" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "User_dndUntil_idx" ON "User"("dndUntil");

-- CreateIndex
CREATE INDEX "User_customStatusExpiresAt_idx" ON "User"("customStatusExpiresAt");
