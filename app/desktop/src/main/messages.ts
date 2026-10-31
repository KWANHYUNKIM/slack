/**
 * 데스크톱 셸 자체 문구 (서버 주소 입력 화면, 메뉴). 서버의 웹 화면 문구는 app/frontend/src/locales에 있다.
 * en이 원문, ko는 1등급이라 키가 하나라도 빠지면 컴파일이 실패한다(Record<MessageKey, string>).
 */

const en = {
  'setup.title': 'Connect to your workspace',
  'setup.description': 'Enter the address of your workspace server. You can change it later from the menu.',
  'setup.label': 'Server address',
  'setup.placeholder': 'chat.example.com',
  'setup.submit': 'Connect',
  'setup.cancel': 'Cancel',
  'setup.reset': 'Forget saved server',
  'setup.current': 'Current server: {server}',
  'setup.connecting': 'Connecting to {server}…',
  'setup.hint': 'Local network addresses (localhost, 192.168.x.x, *.local) use http unless you type https. Other servers must use https.',
  'setup.error.empty': 'Enter a server address.',
  'setup.error.invalid': 'This does not look like a valid address.',
  'setup.error.scheme': 'Only http and https addresses are supported.',
  'setup.error.credentials': 'Do not include a user name or password in the address.',
  'setup.error.insecure': 'Use https for servers outside your local network.',
  'setup.error.unreachable': 'Could not reach {server}. Check the address and your connection.',
  'setup.error.redirected': '{server} tried to send you to a different address, so the connection was stopped.',
  'setup.error.timeout': '{server} did not respond within 10 seconds. Check the address and try again.',
  'menu.workspace': 'Workspace',
  'menu.changeServer': 'Change Server…',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

const ko: Messages = {
  'setup.title': '워크스페이스에 연결',
  'setup.description': '워크스페이스 서버 주소를 입력하세요. 나중에 메뉴에서 바꿀 수 있습니다.',
  'setup.label': '서버 주소',
  'setup.placeholder': 'chat.example.com',
  'setup.submit': '연결',
  'setup.cancel': '취소',
  'setup.reset': '저장한 서버 지우기',
  'setup.current': '현재 서버: {server}',
  'setup.connecting': '{server}에 연결하는 중…',
  'setup.hint': '내부망 주소(localhost, 192.168.x.x, *.local)는 https를 적지 않으면 http로 연결합니다. 그 밖의 서버는 https만 쓸 수 있습니다.',
  'setup.error.empty': '서버 주소를 입력하세요.',
  'setup.error.invalid': '올바른 주소 형식이 아닙니다.',
  'setup.error.scheme': 'http 또는 https 주소만 쓸 수 있습니다.',
  'setup.error.credentials': '주소에 아이디나 비밀번호를 넣지 마세요.',
  'setup.error.insecure': '내부망 밖의 서버는 https 주소를 쓰세요.',
  'setup.error.unreachable': '{server}에 연결하지 못했습니다. 주소와 네트워크를 확인하세요.',
  'setup.error.redirected': '{server}가 다른 주소로 이동시키려 해서 연결을 멈췄습니다.',
  'setup.error.timeout': '{server}가 10초 안에 응답하지 않았습니다. 주소를 확인하고 다시 시도하세요.',
  'menu.workspace': '워크스페이스',
  'menu.changeServer': '서버 변경…',
};

export const MESSAGES: Readonly<Record<'en' | 'ko', Messages>> = { en, ko };

/** 시스템 선호 언어 목록에서 지원 로캘을 고른다. 없으면 en */
export function pickLocale(preferred: readonly string[]): 'en' | 'ko' {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (base === 'ko') return 'ko';
    if (base === 'en') return 'en';
  }
  return 'en';
}

/** "{server}" 같은 자리 표시자를 채운다 */
export function format(text: string, params: Record<string, string> = {}): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? params[name] : match));
}
