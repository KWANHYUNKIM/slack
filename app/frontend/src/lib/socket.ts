import { io, Socket } from 'socket.io-client';
import { MFA_ENROLLMENT_EVENT } from '@/lib/api';

/** 서버(websocket/index.ts MFA_KICK_MESSAGE)가 2FA 등록이 필요해 거부하거나 끊을 때 보내는 사유 */
const MFA_KICK_MESSAGE = 'MFA enrollment required';

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  return socket;
}

export function connectSocket(): Socket | null {
  if (socket?.connected) return socket;

  const token = localStorage.getItem('token');
  if (!token) return null;

  socket = io({
    auth: (cb) => { cb({ token: localStorage.getItem('token') }); },
    transports: ['websocket', 'polling'],
  });

  // 서버가 세션을 폐기해 끊은 경우(io server disconnect)와 재연결 때 토큰이 거부된 경우만 로그아웃 처리한다.
  // 네트워크 끊김('transport close' 등)은 자동 재연결에 맡긴다.
  // 조직이 2FA를 필수로 해 끊긴 경우(E7b)는 로그아웃하지 않고 등록 화면으로 보낸다(인증 스토어가 이벤트를 듣는다).
  let mfaRequired = false;
  socket.on('error', (payload: { message?: string } | undefined) => {
    if (payload?.message === MFA_KICK_MESSAGE) {
      mfaRequired = true;
      window.dispatchEvent(new Event(MFA_ENROLLMENT_EVENT));
    }
  });
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect' && !mfaRequired) handleSessionEnded();
  });
  socket.on('connect_error', (err) => {
    if (err.message === MFA_KICK_MESSAGE) window.dispatchEvent(new Event(MFA_ENROLLMENT_EVENT));
    else if (err.message === 'Invalid token') handleSessionEnded();
  });

  socket.on('connect', () => {
    if (import.meta.env.DEV || import.meta.env.VITE_E2E) {
      (window as Window & { __socket?: Socket | null }).__socket = socket;
    }
  });

  return socket;
}

/** 로그인 화면이 안내 문구를 보여 주도록 표시를 남기고 로그인 화면으로 보낸다(전체 새로고침으로 메모리 상태도 지운다). */
export const SESSION_ENDED_FLAG = 'sessionEnded';

function handleSessionEnded() {
  if (!localStorage.getItem('token')) return;
  localStorage.removeItem('token');
  sessionStorage.setItem(SESSION_ENDED_FLAG, '1');
  disconnectSocket();
  window.location.href = '/login';
}

/**
 * 같은 소켓 객체로 새 토큰을 들고 다시 붙는다(2FA를 켜고 끈 뒤 토큰이 바뀌었을 때). 등록해 둔 이벤트 핸들러는 그대로 남는다.
 * 클라이언트가 먼저 끊으므로('io client disconnect') 로그아웃 처리는 일어나지 않는다. auth는 연결할 때마다 localStorage를 읽는다.
 */
export function reconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket.connect();
  }
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
