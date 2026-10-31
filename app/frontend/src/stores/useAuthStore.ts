import { create } from 'zustand';
import { t } from '@/lib/i18n';
import * as api from '@/lib/api';
import { clearDownloadToken } from '@/lib/api';
import { disconnectSocket } from '@/lib/socket';
import { toUserStatus, type User } from '@/lib/types';
import { useNotificationStore } from './useNotificationStore';
import { useSwitcherStore } from './useSwitcherStore';

let storageListenerRegistered = false;

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isHydrating: boolean;
  isLoading: boolean;
  error: string | null;
  /** 로그인 2단계 대기 중인 mfaToken(5분, 1회용). 메모리에만 둔다. */
  mfaToken: string | null;
  /** 조직이 2FA를 필수로 했는데 아직 등록하지 않았다. 등록 화면만 보여 준다. */
  mfaEnrollmentRequired: boolean;
  /** 'mfa'면 2단계 코드 입력이 필요하다 */
  login: (email: string, password: string) => Promise<'done' | 'mfa'>;
  completeMfaLogin: (code: string) => Promise<void>;
  cancelMfaLogin: () => void;
  /** 필수 등록을 마쳤다. 전체 화면을 새로 띄운다. */
  finishMfaEnrollment: () => void;
  logout: () => void;
  register: (name: string, email: string, password: string, inviteCode?: string) => Promise<void>;
  updateUser: (updates: Partial<User>) => void;
  hydrate: () => void;
}

/** 세션 토큰을 받은 뒤 공통 처리: 토큰을 저장하고 스토어에 넣을 상태를 돌려준다 */
function sessionState({ user, token, mfaEnrollmentRequired }: api.AuthResponse): Partial<AuthState> {
  localStorage.setItem('token', token);
  return {
    user: { ...user, status: 'online', role: user.role },
    isAuthenticated: true,
    isLoading: false,
    mfaToken: null,
    mfaEnrollmentRequired: !!mfaEnrollmentRequired,
  };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isAuthenticated: !!localStorage.getItem('token'),
  isHydrating: !!localStorage.getItem('token'),
  isLoading: false,
  error: null,
  mfaToken: null,
  mfaEnrollmentRequired: false,

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const res = await api.login(email, password);
      if ('mfaRequired' in res) {
        set({ isLoading: false, mfaToken: res.mfaToken });
        return 'mfa';
      }
      set(sessionState(res));
      return 'done';
    } catch (err) {
      const message = err instanceof Error ? err.message : t('auth:errors.loginFailed');
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  completeMfaLogin: async (code: string) => {
    const mfaToken = get().mfaToken;
    if (!mfaToken) throw new api.ApiError('MFA token missing', 401, 'MFA_TOKEN_INVALID');
    set({ isLoading: true });
    try {
      set(sessionState(await api.loginTwoFactor(mfaToken, code)));
    } catch (err) {
      // 대기가 끝났으면(만료·시도 초과) 비밀번호부터 다시 하게 한다
      if (err instanceof api.ApiError && err.code === 'MFA_TOKEN_INVALID') set({ mfaToken: null });
      set({ isLoading: false });
      throw err;
    }
  },

  cancelMfaLogin: () => set({ mfaToken: null }),

  finishMfaEnrollment: () => {
    set({ mfaEnrollmentRequired: false });
    // 등록 화면에서는 소켓과 스토어가 비어 있으니 새로 띄운다
    window.location.href = '/';
  },

  logout: () => {
    // Unsubscribe from push notifications before clearing auth
    useNotificationStore.getState().unsubscribe().catch(() => {});
    // 감사 로그용 로그아웃 알림. 실패해도 로그아웃은 막지 않고, 페이지 이동 뒤에도 전송되게 keepalive를 쓴다.
    const token = localStorage.getItem('token');
    if (token) {
      void fetch('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {});
    }
    localStorage.removeItem('token');
    // 최근 방문(06)은 사용자별 기록이라 로그아웃할 때 현재 사용자의 것을 지운다
    useSwitcherStore.getState().clearRecents();
    clearDownloadToken();
    disconnectSocket();
    // Hard reload to wipe all in-memory Zustand state (messages, DMs, channels, bookmarks)
    window.location.href = '/login';
  },

  register: async (name: string, email: string, password: string, inviteCode?: string) => {
    set({ isLoading: true, error: null });
    try {
      set(sessionState(await api.register(name, email, password, inviteCode)));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('auth:errors.registerFailed');
      set({ isLoading: false, error: message });
      throw err;
    }
  },

  updateUser: (updates) => {
    const current = get().user;
    if (current) set({ user: { ...current, ...updates } });
  },

  hydrate: () => {
    const token = localStorage.getItem('token');
    if (token) {
      try {
        // JWT payload only has { userId, tokenVersion } — placeholder until getMyProfile() resolves
        const payload = JSON.parse(atob(token.split('.')[1]));
        set({
          user: {
            id: payload.userId,
            email: '',
            name: t('auth:placeholderUserName'),
          },
          isAuthenticated: true,
          isHydrating: true,
        });
        api.getMyProfile().then((profile) => {
          set({
            user: {
              id: profile.id,
              email: profile.email,
              name: profile.name,
              avatar: profile.avatar,
              role: profile.role,
              status: toUserStatus(profile.status),
              locale: profile.locale,
              timeZone: profile.timeZone,
            },
            isHydrating: false,
          });
        }).catch((err) => {
          // 2FA 등록이 필요한 사용자는 로그인을 유지하고 등록 화면으로 보낸다
          if (err instanceof api.ApiError && err.code === api.MFA_ENROLLMENT_REQUIRED) {
            set({ mfaEnrollmentRequired: true, isHydrating: false });
            return;
          }
          localStorage.removeItem('token');
          set({ user: null, isAuthenticated: false, isHydrating: false });
        });
      } catch {
        localStorage.removeItem('token');
        set({ user: null, isAuthenticated: false, isHydrating: false });
      }
    } else {
      set({ isHydrating: false });
    }

    // Cross-tab session sync: detect logout from another tab (guard against StrictMode double-call)
    if (!storageListenerRegistered) {
      storageListenerRegistered = true;
      window.addEventListener('storage', (e) => {
        if (e.key === 'token' && e.newValue === null) {
          disconnectSocket();
          window.location.href = '/login';
        }
      });
      // 앱을 쓰는 중에 관리자가 2FA 필수를 켜면 API가 MFA_ENROLLMENT_REQUIRED를 돌려준다(lib/api.ts가 알린다)
      window.addEventListener(api.MFA_ENROLLMENT_EVENT, () => {
        if (get().isAuthenticated && !get().mfaEnrollmentRequired) {
          disconnectSocket();
          set({ mfaEnrollmentRequired: true });
        }
      });
    }
  },
}));
