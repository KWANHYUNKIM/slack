-- CreateTable
CREATE TABLE "DMReaction" (
    "id" SERIAL NOT NULL,
    "emoji" VARCHAR(50) NOT NULL,
    "userId" INTEGER NOT NULL,
    "dmId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DMReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DMReaction_dmId_idx" ON "DMReaction"("dmId");

-- CreateIndex
CREATE UNIQUE INDEX "DMReaction_userId_dmId_emoji_key" ON "DMReaction"("userId", "dmId", "emoji");

-- AddForeignKey
ALTER TABLE "DMReaction" ADD CONSTRAINT "DMReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DMReaction" ADD CONSTRAINT "DMReaction_dmId_fkey" FOREIGN KEY ("dmId") REFERENCES "DirectMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
