import { io, Socket } from 'socket.io-client';

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
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect') handleSessionEnded();
  });
  socket.on('connect_error', (err) => {
    if (err.message === 'Invalid token') handleSessionEnded();
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

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
