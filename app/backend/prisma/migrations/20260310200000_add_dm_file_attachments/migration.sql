-- AlterTable
ALTER TABLE "File" ADD COLUMN "dmId" INTEGER;

-- CreateIndex
CREATE INDEX "File_dmId_idx" ON "File"("dmId");

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_dmId_fkey" FOREIGN KEY ("dmId") REFERENCES "DirectMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
