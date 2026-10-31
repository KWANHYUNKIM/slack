import { create } from 'zustand';
import * as api from '@/lib/api';
import type { AccessToken, AccessTokenScope } from '@/lib/api';

// 개인 액세스 토큰(MCP 연결용). 원문 토큰은 발급 직후 한 번만 justCreated에 담고,
// 대화 상자를 닫거나 다른 토큰을 만들면 버린다(어디에도 저장하지 않는다).

/** 발급할 수 있는 범위와 번역 키(settings:accessTokens.scope.*). 키에 ':'를 쓰면 i18next 네임스페이스로 읽혀서 따로 둔다. */
export const ACCESS_TOKEN_SCOPES: { scope: AccessTokenScope; key: string }[] = [
  { scope: 'channels:read', key: 'channelsRead' },
  { scope: 'channels:history', key: 'channelsHistory' },
  { scope: 'users:read', key: 'usersRead' },
  { scope: 'chat:write', key: 'chatWrite' },
  { scope: 'reactions:write', key: 'reactionsWrite' },
  { scope: 'im:read', key: 'imRead' },
  { scope: 'im:history', key: 'imHistory' },
  { scope: 'im:write', key: 'imWrite' },
  { scope: 'search:read', key: 'searchRead' },
  { scope: 'files:read', key: 'filesRead' },
];

interface AccessTokenState {
  tokens: AccessToken[];
  loading: boolean;
  /** 방금 발급한 토큰의 원문. 화면에 한 번만 보여 준다. */
  justCreated: { id: number; token: string } | null;
  load: () => Promise<void>;
  create: (input: { name: string; scopes: AccessTokenScope[]; expiresInDays: number | null }) => Promise<void>;
  rename: (id: number, name: string) => Promise<void>;
  revoke: (id: number) => Promise<void>;
  /** 원문을 메모리에서 지운다 */
  dismissCreated: () => void;
}

export const useAccessTokenStore = create<AccessTokenState>((set) => ({
  tokens: [],
  loading: false,
  justCreated: null,

  load: async () => {
    set({ loading: true });
    try {
      const { items } = await api.listAccessTokens();
      set({ tokens: items });
    } finally {
      set({ loading: false });
    }
  },

  create: async (input) => {
    const { token, ...view } = await api.createAccessToken(input);
    set((s) => ({ tokens: [view, ...s.tokens], justCreated: { id: view.id, token } }));
  },

  rename: async (id, name) => {
    const updated = await api.renameAccessToken(id, name);
    set((s) => ({ tokens: s.tokens.map((x) => (x.id === id ? updated : x)) }));
  },

  revoke: async (id) => {
    await api.revokeAccessToken(id);
    set((s) => ({
      tokens: s.tokens.filter((x) => x.id !== id),
      justCreated: s.justCreated?.id === id ? null : s.justCreated,
    }));
  },

  dismissCreated: () => set({ justCreated: null }),
}));
