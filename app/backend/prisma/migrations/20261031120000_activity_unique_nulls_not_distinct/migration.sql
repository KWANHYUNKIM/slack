-- 기존 unique는 NULL 컬럼(messageId, dmId, emoji) 때문에 중복을 막지 못했다.
-- 같은 이름·같은 컬럼으로 다시 만들되 NULL을 같은 값으로 취급해(Postgres 15+) 동시 요청에서도 DB가 중복을 막게 한다.
-- 이름을 유지하므로 schema.prisma의 @@unique와 어긋나지 않는다(Prisma는 NULLS NOT DISTINCT를 모른다).
DROP INDEX "Activity_userId_type_messageId_dmId_actorId_emoji_key";
CREATE UNIQUE INDEX "Activity_userId_type_messageId_dmId_actorId_emoji_key"
  ON "Activity"("userId", "type", "messageId", "dmId", "actorId", "emoji") NULLS NOT DISTINCT;
