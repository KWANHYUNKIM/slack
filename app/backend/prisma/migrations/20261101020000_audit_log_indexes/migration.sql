-- AlterTable: 로그인 실패처럼 사용자를 특정할 수 없는 기록을 위해 actorId를 비울 수 있게 한다
ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;

-- 사용자를 지워도 감사 기록은 남긴다(수행자만 비운다)
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");
