-- E1c 채널 이름 유일성을 워크스페이스 단위로만 둔다(docs/specs/E1-multi-workspace.md 3.5, 9절).
-- 워크스페이스 안의 유일성은 ChannelWorkspace(workspaceId, nameKey) 유니크가 맡는다(E1a). 이제 워크스페이스 A와 B가
-- 같은 이름 general을 가질 수 있다. 이름 조회와 중복 검사는 모두 워크스페이스 범위(nameKey)로 한다.
DROP INDEX "Channel_name_key";
