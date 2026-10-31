-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "alsoSendToChannel" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ThreadRead" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "threadId" INTEGER NOT NULL,
    "lastReadReplyId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThreadRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ThreadRead_userId_updatedAt_idx" ON "ThreadRead"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadRead_userId_threadId_key" ON "ThreadRead"("userId", "threadId");

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreadRead" ADD CONSTRAINT "ThreadRead_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
