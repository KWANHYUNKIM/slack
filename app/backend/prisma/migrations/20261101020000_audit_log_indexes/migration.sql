-- AlterTable: 로그인 실패처럼 사용자를 특정할 수 없는 기록을 위해 actorId를 비울 수 있게 한다
ALTER TABLE "AuditLog" ALTER COLUMN "actorId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");
