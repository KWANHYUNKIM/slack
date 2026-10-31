// 백엔드 서버 주소. 프런트에는 따로 정한 API base(VITE_API_URL 같은 값)가 없고, 모든 HTTP 호출이
// 같은 출처의 상대 경로(/auth, /channels ...)로 나간다. 운영에서는 백엔드가 프런트를 직접 서빙하고,
// 개발에서는 vite dev proxy가 같은 경로를 백엔드(:3000)로 넘기므로 location.origin이 곧 백엔드 주소다.
//
// D1(데스크톱 셸) 연결 지점: 데스크톱 앱은 페이지 출처가 서버가 아닐 수 있으므로, preload가 서버 주소를
// 주입하면(예: window.desktop?.serverUrl) 여기서 그 값을 먼저 쓰도록 바꾼다. 서버 주소가 필요한 곳은
// 모두 이 함수를 거치게 해서 그때 한 곳만 고치면 되게 한다.
export function getServerOrigin(): string {
  return window.location.origin;
}

/** MCP 클라이언트(Claude Code 등)가 연결할 Streamable HTTP 엔드포인트 */
export function getMcpUrl(): string {
  return `${getServerOrigin()}/mcp`;
}
