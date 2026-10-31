-- 워크스페이스 이름은 조직 안에서 대소문자 무시로 유일하다(E1b, PR #128 리뷰).
-- 함수 인덱스라 Prisma 스키마로 표현할 수 없어 SQL로만 둔다(schema.prisma Workspace 주석 참고).
-- 기존 @@unique([organizationId, name])는 그대로 둔다(Prisma 스키마와 맞춰 migrate dev가 지우거나 다시 만들지 않게).
-- 충돌은 routes/org.ts가 P2002 -> 409 WORKSPACE_NAME_TAKEN으로 바꾼다.
CREATE UNIQUE INDEX "Workspace_organizationId_lower_name_key" ON "Workspace"("organizationId", lower("name"));
