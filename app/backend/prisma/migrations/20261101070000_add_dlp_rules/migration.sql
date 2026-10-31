-- CreateEnum
CREATE TYPE "DlpAction" AS ENUM ('BLOCK', 'WARN');

-- CreateTable
CREATE TABLE "DlpRule" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(40),
    "name" VARCHAR(100) NOT NULL,
    "pattern" VARCHAR(500) NOT NULL,
    "action" "DlpAction" NOT NULL DEFAULT 'BLOCK',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DlpRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DlpRule_key_key" ON "DlpRule"("key");

-- CreateIndex
CREATE UNIQUE INDEX "DlpRule_name_key" ON "DlpRule"("name");

-- CreateIndex
CREATE INDEX "DlpRule_enabled_idx" ON "DlpRule"("enabled");

-- AddForeignKey
ALTER TABLE "DlpRule" ADD CONSTRAINT "DlpRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
