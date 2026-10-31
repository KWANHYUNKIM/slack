-- 이미 소프트 삭제된 DM(그룹 DM 포함)의 첨부를 분리한다. 앞으로의 삭제는 앱이 같은 방식으로 처리한다.
-- 채널 메시지는 분리 당시 원래 id를 남기지 않았다면 되찾을 수 없어 백필하지 않는다(E6 이후 삭제분은 이미 채워져 있다).
UPDATE "File" f
SET "detachedFromDmId" = f."dmId", "dmId" = NULL
FROM "DirectMessage" d
WHERE f."dmId" = d."id" AND d."deletedAt" IS NOT NULL;
