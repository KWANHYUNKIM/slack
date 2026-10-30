-- AlterTable
ALTER TABLE "Channel" ADD COLUMN     "createdBy" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;
