// 세션이 끝났다는 신호(HTTP 401, 소켓 거부·끊김)를 받았을 때 무엇을 할지 고르는 순수 로직(node --test로 검사한다).
//
// 같은 브라우저의 여러 탭은 localStorage 토큰 하나를 같이 쓴다. 한 탭이 2FA를 켜거나 끄면 서버가 새 토큰을 주고
// 이전 토큰은 무효가 된다. 다른 탭이 이전 토큰으로 실패했을 때 저장된 새 토큰까지 지우면 모든 탭이 로그아웃된다.
// 그래서 실패한 토큰이 지금 저장된 토큰과 같을 때만 지운다.

export type SessionEndAction =
  /** 저장된 토큰이 실패한 그 토큰이다: 지우고 로그인 화면으로 */
  | 'clear'
  /** 다른 탭이 이미 새 토큰으로 바꿨다: 지우지 말고 새 토큰으로 다시 붙는다 */
  | 'retry'
  /** 저장된 토큰이 없다(이미 로그아웃): 할 일 없음 */
  | 'ignore';

export function sessionEndAction(failedToken: string | null | undefined, storedToken: string | null): SessionEndAction {
  if (!storedToken) return 'ignore';
  if (!failedToken || failedToken === storedToken) return 'clear';
  return 'retry';
}
