// 허들 오류 문구를 번역 키로 바꾼다. 서버(websocket/huddles.ts)는 영어 원문을 message로 보내므로
// 원문을 그대로 화면에 보여 주지 않고, 알려진 원문은 번역 키로 옮기고 나머지는 일반 문구를 쓴다.
// 외부 의존이 없게 유지한다(node --test에서 바로 돌리려고).

export const HUDDLE_GENERIC_ERROR_KEY = 'huddle:errors.generic';

const SERVER_MESSAGE_KEYS: Record<string, string> = {
  'Rate limit exceeded': 'huddle:errors.rateLimited',
  'Invalid invite payload': 'huddle:errors.invalidInvite',
  'Cannot invite yourself': 'huddle:errors.cannotInviteSelf',
  'Leave your current huddle first': 'huddle:errors.leaveFirst',
  'User not found': 'huddle:errors.userNotFound',
  'Invalid accept payload': 'huddle:errors.invalidAccept',
  'Invite not found or expired': 'huddle:errors.inviteNotFound',
  'They are already in another huddle': 'huddle:errors.busy',
  'They went offline': 'huddle:errors.peerOffline',
};

/**
 * 스토어의 error 값을 번역 키로 바꾼다.
 * 이미 `huddle:`로 시작하는 키는 그대로 두고, 서버 원문이면 대응 키를, 모르는 원문이면 일반 키를 돌려준다.
 */
export function huddleErrorKey(error: string): string {
  if (error.startsWith('huddle:')) return error;
  return SERVER_MESSAGE_KEYS[error] ?? HUDDLE_GENERIC_ERROR_KEY;
}
