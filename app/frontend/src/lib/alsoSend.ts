/**
 * "채널에도 보내기" 체크를 전송 응답 뒤에 풀지 정한다.
 * sentVersion은 전송을 시작할 때, currentVersion은 응답이 왔을 때의 사용자 변경 횟수다.
 * 응답을 기다리는 사이 사용자가 체크를 한 번이라도 바꿨다면(횟수가 달라짐) 그 선택을 지킨다.
 */
export function shouldClearAlsoSend(sentVersion: number, currentVersion: number): boolean {
  return sentVersion === currentVersion;
}
