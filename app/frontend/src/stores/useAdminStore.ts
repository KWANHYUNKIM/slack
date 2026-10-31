import { t } from '@/lib/i18n';
import { create } from 'zustand';
import * as api from '@/lib/api';
import type { AdminUser, AdminChannel, AdminInvite, AuditLogEntry, AdminWebhook } from '@/lib/api';
import { patchById, pickFields, removeById, restoreItem } from '@/lib/adminRollback';

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
  // 아래 변경 액션은 실패하면 그 항목만 원래 상태로 되돌린 뒤 reject한다.
  // 같은 항목에 요청이 진행 중이면 두 번째 요청은 무시한다.
  // 호출한 쪽이 try/catch로 받아 apiErrorMessage로 번역해 그 화면이나 대화상자에 보여 준다.
  /** 실패 시 reject */
  updateUserRole: (userId: number, role: 'ADMIN' | 'MEMBER' | 'GUEST') => Promise<void>;
  /** 실패 시 reject */
  transferOwnership: (userId: number) => Promise<void>;
  /** 실패 시 reject */
  deactivateUser: (userId: number) => Promise<void>;
  /** 실패 시 reject */
  reactivateUser: (userId: number) => Promise<void>;
  /** 실패 시 reject */
  createInvite: (data: { role?: string; maxUses?: number | null; expiresAt?: string | null }) => Promise<void>;
  /** 실패 시 reject */
  deleteInvite: (inviteId: number) => Promise<void>;
  /** 실패 시 reject */
  createWebhook: (data: { name: string; channelId: number }) => Promise<void>;
  /** 실패 시 reject */
  deleteWebhook: (webhookId: number) => Promise<void>;
  /** 실패 시 reject */
  deleteChannel: (channelId: number) => Promise<void>;
  /** 실패 시 reject */
  archiveChannel: (channelId: number) => Promise<void>;
  /** 실패 시 reject */
  unarchiveChannel: (channelId: number) => Promise<void>;
  /** 실패 시 reject (상태는 바꾸지 않는다). 호출한 쪽이 성공·실패를 판단하고 apiErrorMessage로 번역해 보여 준다. */
  editChannel: (channelId: number, data: { name?: string; isPrivate?: boolean }) => Promise<void>;
  /** 실패 시 reject */
  removeChannelMember: (channelId: number, userId: number) => Promise<void>;
}

export const useAdminStore = create<AdminState>((set, get) => {
  // 진행 중인 항목 키(예: user:3). 같은 키의 요청이 겹치면 두 번째는 실행하지 않는다.
  const inFlight = new Set<string>();
  const guard = async (key: string, task: () => Promise<void>): Promise<void> => {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await task();
    } finally {
      inFlight.delete(key);
    }
  };

  return {
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

    updateUserRole: (userId, role) =>
      guard(`user:${userId}`, async () => {
        const user = get().users.find((u) => u.id === userId);
        const prev = user ? pickFields(user, ['role']) : null;
        set({ users: patchById(get().users, userId, { role }) });
        try {
          const updated = await api.adminUpdateUserRole(userId, role);
          set({ users: patchById(get().users, userId, updated) });
        } catch (err) {
          if (prev) set({ users: patchById(get().users, userId, prev) });
          throw err;
        }
      }),

    transferOwnership: (userId) =>
      guard(`user:${userId}`, async () => {
        await api.adminTransferOwnership(userId);
        // Refresh users to reflect the role changes
        await get().fetchUsers();
      }),

    deactivateUser: (userId) =>
      guard(`user:${userId}`, async () => {
        const user = get().users.find((u) => u.id === userId);
        const prev = user ? pickFields(user, ['deactivatedAt']) : null;
        set({ users: patchById(get().users, userId, { deactivatedAt: new Date().toISOString() }) });
        try {
          const updated = await api.adminDeactivateUser(userId);
          set({ users: patchById(get().users, userId, updated) });
        } catch (err) {
          if (prev) set({ users: patchById(get().users, userId, prev) });
          throw err;
        }
      }),

    reactivateUser: (userId) =>
      guard(`user:${userId}`, async () => {
        const user = get().users.find((u) => u.id === userId);
        const prev = user ? pickFields(user, ['deactivatedAt']) : null;
        set({ users: patchById(get().users, userId, { deactivatedAt: null }) });
        try {
          const updated = await api.adminReactivateUser(userId);
          set({ users: patchById(get().users, userId, updated) });
        } catch (err) {
          if (prev) set({ users: patchById(get().users, userId, prev) });
          throw err;
        }
      }),

    createInvite: async (data) => {
      const invite = await api.adminCreateInvite(data);
      set({ invites: [invite, ...get().invites] });
    },

    deleteInvite: (inviteId) =>
      guard(`invite:${inviteId}`, async () => {
        const removed = removeById(get().invites, inviteId);
        if (removed) set({ invites: removed.next });
        try {
          await api.adminDeleteInvite(inviteId);
        } catch (err) {
          if (removed) set({ invites: restoreItem(get().invites, removed.item, removed.index) });
          throw err;
        }
      }),

    fetchWebhooks: async () => {
      try {
        const webhooks = await api.adminGetWebhooks();
        set({ webhooks });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : t('admin:errors.fetchWebhooks') });
      }
    },

    createWebhook: async (data) => {
      const webhook = await api.adminCreateWebhook(data);
      set({ webhooks: [webhook, ...get().webhooks] });
    },

    deleteWebhook: (webhookId) =>
      guard(`webhook:${webhookId}`, async () => {
        const removed = removeById(get().webhooks, webhookId);
        if (removed) set({ webhooks: removed.next });
        try {
          await api.adminDeleteWebhook(webhookId);
        } catch (err) {
          if (removed) set({ webhooks: restoreItem(get().webhooks, removed.item, removed.index) });
          throw err;
        }
      }),

    deleteChannel: (channelId) =>
      guard(`channel:${channelId}`, async () => {
        const removed = removeById(get().channels, channelId);
        if (removed) set({ channels: removed.next });
        try {
          await api.adminDeleteChannel(channelId);
        } catch (err) {
          if (removed) set({ channels: restoreItem(get().channels, removed.item, removed.index) });
          throw err;
        }
      }),

    archiveChannel: (channelId) =>
      guard(`channel:${channelId}`, async () => {
        const channel = get().channels.find((c) => c.id === channelId);
        const prev = channel ? pickFields(channel, ['archivedAt']) : null;
        set({ channels: patchById(get().channels, channelId, { archivedAt: new Date().toISOString() }) });
        try {
          const updated = await api.adminArchiveChannel(channelId);
          set({ channels: patchById(get().channels, channelId, updated) });
        } catch (err) {
          if (prev) set({ channels: patchById(get().channels, channelId, prev) });
          throw err;
        }
      }),

    unarchiveChannel: (channelId) =>
      guard(`channel:${channelId}`, async () => {
        const channel = get().channels.find((c) => c.id === channelId);
        const prev = channel ? pickFields(channel, ['archivedAt']) : null;
        set({ channels: patchById(get().channels, channelId, { archivedAt: null }) });
        try {
          const updated = await api.adminUnarchiveChannel(channelId);
          set({ channels: patchById(get().channels, channelId, updated) });
        } catch (err) {
          if (prev) set({ channels: patchById(get().channels, channelId, prev) });
          throw err;
        }
      }),

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
  };
});
