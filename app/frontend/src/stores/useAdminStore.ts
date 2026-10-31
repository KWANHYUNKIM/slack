import { t } from '@/lib/i18n';
import { create } from 'zustand';
import * as api from '@/lib/api';
import type { AdminUser, AdminChannel, AdminInvite, AuditLogEntry, AdminWebhook } from '@/lib/api';

interface AdminState {
  users: AdminUser[];
  channels: AdminChannel[];
  invites: AdminInvite[];
  webhooks: AdminWebhook[];
  auditLog: AuditLogEntry[];
  auditLogTotal: number;
  isLoading: boolean;
  error: string | null;
  fetchUsers: () => Promise<void>;
  fetchChannels: () => Promise<void>;
  fetchInvites: () => Promise<void>;
  fetchWebhooks: () => Promise<void>;
  fetchAuditLog: (limit?: number, offset?: number) => Promise<void>;
  updateUserRole: (userId: number, role: 'ADMIN' | 'MEMBER' | 'GUEST') => Promise<void>;
  transferOwnership: (userId: number) => Promise<void>;
  deactivateUser: (userId: number) => Promise<void>;
  reactivateUser: (userId: number) => Promise<void>;
  createInvite: (data: { role?: string; maxUses?: number | null; expiresAt?: string | null }) => Promise<void>;
  deleteInvite: (inviteId: number) => Promise<void>;
  createWebhook: (data: { name: string; channelId: number }) => Promise<void>;
  deleteWebhook: (webhookId: number) => Promise<void>;
  deleteChannel: (channelId: number) => Promise<void>;
  archiveChannel: (channelId: number) => Promise<void>;
  unarchiveChannel: (channelId: number) => Promise<void>;
  /** 실패하면 reject한다(상태는 바꾸지 않는다). 호출한 쪽이 성공·실패를 판단하고 apiErrorMessage로 번역해 보여 준다. */
  editChannel: (channelId: number, data: { name?: string; isPrivate?: boolean }) => Promise<void>;
  // 주의: editChannel과 removeChannelMember 외의 액션은 아직 실패를 error 상태로 삼킨다. 호출 측과 함께 바꾸는 작업은 fix/admin-store-actions에서 한다.
  removeChannelMember: (channelId: number, userId: number) => Promise<void>;
}

export const useAdminStore = create<AdminState>((set, get) => ({
  users: [],
  channels: [],
  invites: [],
  webhooks: [],
  auditLog: [],
  auditLogTotal: 0,
  isLoading: false,
  error: null,

  fetchUsers: async () => {
    try {
      const users = await api.adminGetUsers();
      set({ users });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('admin:errors.fetchUsers') });
    }
  },

  fetchChannels: async () => {
    try {
      const channels = await api.adminGetChannels();
      set({ channels });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('admin:errors.fetchChannels') });
    }
  },

  fetchInvites: async () => {
    try {
      const invites = await api.adminGetInvites();
      set({ invites });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('admin:errors.fetchInvites') });
    }
  },

  updateUserRole: async (userId, role) => {
    const prev = get().users;
    set({ users: prev.map((u) => (u.id === userId ? { ...u, role } : u)) });
    try {
      const updated = await api.adminUpdateUserRole(userId, role);
      set({ users: get().users.map((u) => (u.id === userId ? updated : u)) });
    } catch (err) {
      set({ users: prev, error: err instanceof Error ? err.message : t('admin:errors.updateRole') });
    }
  },

  transferOwnership: async (userId) => {
    try {
      await api.adminTransferOwnership(userId);
      // Refresh users to reflect the role changes
      await get().fetchUsers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('admin:errors.transferOwnership') });
    }
  },

  deactivateUser: async (userId) => {
    const prev = get().users;
    set({ users: prev.map((u) => (u.id === userId ? { ...u, deactivatedAt: new Date().toISOString() } : u)) });
    try {
      const updated = await api.adminDeactivateUser(userId);
      set({ users: get().users.map((u) => (u.id === userId ? updated : u)) });
    } catch (err) {
      set({ users: prev, error: err instanceof Error ? err.message : t('admin:errors.deactivateUser') });
    }
  },

  reactivateUser: async (userId) => {
    const prev = get().users;
    set({ users: prev.map((u) => (u.id === userId ? { ...u, deactivatedAt: null } : u)) });
    try {
      const updated = await api.adminReactivateUser(userId);
      set({ users: get().users.map((u) => (u.id === userId ? updated : u)) });
    } catch (err) {
      set({ users: prev, error: err instanceof Error ? err.message : t('admin:errors.reactivateUser') });
    }
  },

  createInvite: async (data) => {
    try {
      const invite = await api.adminCreateInvite(data);
      set({ invites: [invite, ...get().invites] });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('admin:errors.createInvite') });
    }
  },

  deleteInvite: async (inviteId) => {
    const prev = get().invites;
    set({ invites: prev.filter((i) => i.id !== inviteId) });
    try {
      await api.adminDeleteInvite(inviteId);
    } catch (err) {
      set({ invites: prev, error: err instanceof Error ? err.message : t('admin:errors.deleteInvite') });
    }
  },

  fetchWebhooks: async () => {
    try {
      const webhooks = await api.adminGetWebhooks();
      set({ webhooks });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('admin:errors.fetchWebhooks') });
    }
  },

  createWebhook: async (data) => {
    try {
      const webhook = await api.adminCreateWebhook(data);
      set({ webhooks: [webhook, ...get().webhooks] });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('admin:errors.createWebhook') });
    }
  },

  deleteWebhook: async (webhookId) => {
    const prev = get().webhooks;
    set({ webhooks: prev.filter((w) => w.id !== webhookId) });
    try {
      await api.adminDeleteWebhook(webhookId);
    } catch (err) {
      set({ webhooks: prev, error: err instanceof Error ? err.message : t('admin:errors.deleteWebhook') });
    }
  },

  deleteChannel: async (channelId) => {
    const prev = get().channels;
    set({ channels: prev.filter((c) => c.id !== channelId) });
    try {
      await api.adminDeleteChannel(channelId);
    } catch (err) {
      set({ channels: prev, error: err instanceof Error ? err.message : t('admin:errors.deleteChannel') });
    }
  },

  archiveChannel: async (channelId) => {
    const prev = get().channels;
    set({
      channels: prev.map((c) =>
        c.id === channelId ? { ...c, archivedAt: new Date().toISOString() } : c
      ),
    });
    try {
      const updated = await api.adminArchiveChannel(channelId);
      set({ channels: get().channels.map((c) => (c.id === channelId ? updated : c)) });
    } catch (err) {
      set({ channels: prev, error: err instanceof Error ? err.message : t('admin:errors.archiveChannel') });
    }
  },

  unarchiveChannel: async (channelId) => {
    const prev = get().channels;
    set({
      channels: prev.map((c) =>
        c.id === channelId ? { ...c, archivedAt: null } : c
      ),
    });
    try {
      const updated = await api.adminUnarchiveChannel(channelId);
      set({ channels: get().channels.map((c) => (c.id === channelId ? updated : c)) });
    } catch (err) {
      set({ channels: prev, error: err instanceof Error ? err.message : t('admin:errors.unarchiveChannel') });
    }
  },

  // 실패는 그대로 던진다. 호출한 쪽이 성공·실패를 판단하고 번역된 문구를 보여 준다(삼키면 성공 여부를 이름으로 추정하게 된다).
  editChannel: async (channelId, data) => {
    const updated = await api.adminEditChannel(channelId, data);
    set({ channels: get().channels.map((c) => (c.id === channelId ? updated : c)) });
  },

  removeChannelMember: async (channelId, userId) => {
    try {
      await api.adminRemoveChannelMember(channelId, userId);
      // Member count will be updated via WebSocket channel:member-left event
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('admin:errors.removeChannelMember') });
      throw err;
    }
  },

  fetchAuditLog: async (limit = 50, offset = 0) => {
    try {
      const data = await api.adminGetAuditLog(limit, offset);
      set({
        auditLog: offset > 0 ? [...get().auditLog, ...data.entries] : data.entries,
        auditLogTotal: data.total,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('admin:errors.fetchAuditLog') });
    }
  },
}));
