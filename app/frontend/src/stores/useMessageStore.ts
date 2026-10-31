import { create } from 'zustand';
import * as api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/stores/useAuthStore';
import type { Message, Reaction } from '@/lib/types';
import { t } from '@/lib/i18n';

function transformApiMessage(msg: api.ApiMessage): Message {
  // Group raw reaction rows into { emoji, count, userIds[] }
  const reactionMap = new Map<string, Reaction>();
  for (const r of msg.reactions ?? []) {
    const existing = reactionMap.get(r.emoji);
    const userName = r.user?.name ?? '';
    if (existing) {
      existing.count++;
      existing.userIds.push(r.userId);
      existing.userNames.push(userName);
    } else {
      reactionMap.set(r.emoji, {
        emoji: r.emoji,
        count: 1,
        userIds: [r.userId],
        userNames: [userName],
      });
    }
  }

  return {
    id: msg.id,
    content: msg.content,
    userId: msg.userId,
    user: {
      id: msg.user.id,
      name: msg.user.name,
      avatar: msg.user.avatar,
    },
    channelId: msg.channelId,
    createdAt: new Date(msg.createdAt),
    updatedAt: msg.updatedAt ? new Date(msg.updatedAt) : undefined,
    reactions: Array.from(reactionMap.values()),
    files: (msg.files ?? []).map((f) => ({
      id: f.id,
      filename: f.filename,
      originalName: f.originalName ?? f.filename,
      mimetype: f.mimetype,
      size: f.size,
      url: f.url,
    })),
    threadCount: msg._count?.replies ?? 0,
    threadParticipants: msg.threadParticipants ?? [],
    threadId: msg.threadId ?? null,
    alsoSendToChannel: msg.alsoSendToChannel ?? false,
    parentExcerpt: msg.parent && !msg.parent.deletedAt ? msg.parent : null,
    isDeleted: !!msg.deletedAt,
    isEdited: !!msg.editedAt,
    isPinned: msg.isPinned ?? false,
  };
}

interface MessageState {
  messages: Message[];
  isLoading: boolean;
  loadError: string | null;
  loadedChannelId: number | null;
  sendError: string | null;

  fetchMessages: (channelId: number, around?: number) => Promise<void>;
  getMessagesForChannel: (channelId: number) => Message[];
  sendMessage: (channelId: number, content: string, fileIds?: number[]) => Promise<void>;
  editMessage: (messageId: number, content: string) => Promise<void>;
  deleteMessage: (messageId: number) => Promise<void>;
  addReaction: (messageId: number, emoji: string) => void;
  removeReaction: (messageId: number, emoji: string) => void;
  clearSendError: () => void;
  updateUserInMessages: (userId: number, updates: { name?: string; avatar?: string }) => void;
  // Socket event handlers
  onMessageNew: (msg: api.ApiMessage) => void;
  onMessageUpdated: (msg: api.ApiMessage) => void;
  onMessageDeleted: (data: { messageId: number; threadId?: number | null }) => void;
  onReactionAdded: (data: { messageId: number; reaction: { emoji: string; userId: number; user: { name: string } } }) => void;
  onReactionRemoved: (data: { messageId: number; emoji: string; userId: number }) => void;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: [],
  isLoading: false,
  loadError: null,
  loadedChannelId: null,
  sendError: null,

  fetchMessages: async (channelId: number, around?: number) => {
    set({ isLoading: true, loadError: null, loadedChannelId: channelId });
    try {
      const data = await api.getMessages(channelId, undefined, 50, around);
      // Discard stale response if the user already switched to another channel
      if (get().loadedChannelId !== channelId) return;
      const messages = data.messages.map(transformApiMessage);
      // API returns desc order (or chronological for around), reverse if not around
      if (!around) messages.reverse();
      set({ messages, isLoading: false, loadedChannelId: channelId });
    } catch {
      if (get().loadedChannelId !== channelId) return;
      set({ isLoading: false, loadError: t('messages:errors.loadFailed') });
    }
  },

  getMessagesForChannel: (channelId: number) => {
    return get().messages.filter((msg) => msg.channelId === channelId);
  },

  sendMessage: async (channelId: number, content: string, fileIds?: number[]) => {
    const socket = getSocket();
    if (socket?.connected) {
      // Send via socket with ack callback so we can detect errors
      return new Promise<void>((resolve, reject) => {
        // Fallback timeout — reject if no ack in 10s so failures aren't silently swallowed
        const timeout = setTimeout(() => {
          set({ sendError: t('messages:errors.sendTimeout') });
          reject(new Error('Message send timed out'));
        }, 10000);
        socket.emit('message:send', { channelId, content, fileIds }, (response: { error?: string }) => {
          clearTimeout(timeout);
          if (response?.error) {
            set({ sendError: response.error });
            reject(new Error(response.error));
          } else {
            set({ sendError: null });
            resolve();
          }
        });
      });
    } else {
      // Fallback to REST if socket not connected
      try {
        const apiMsg = await api.sendMessage(channelId, content, fileIds);
        const message = transformApiMessage(apiMsg);
        set((state) => ({
          messages: [...state.messages, message],
          sendError: null,
        }));
      } catch (err) {
        const msg = (err instanceof Error && err.message) || t('messages:errors.sendFailed');
        set({ sendError: msg });
        throw err;
      }
    }
  },

  editMessage: async (messageId: number, content: string) => {
    try {
      const apiMsg = await api.editMessage(messageId, content);
      const updated = transformApiMessage(apiMsg);
      set({
        messages: get().messages.map((msg) =>
          msg.id === messageId ? updated : msg,
        ),
      });
    } catch (err) {
      console.error('Failed to edit message:', err);
      throw err;
    }
  },

  deleteMessage: async (messageId: number) => {
    try {
      await api.deleteMessage(messageId);
      // 답글의 개수 감소는 message:deleted 이벤트가 맡는다(여기서도 줄이면 두 번 줄어든다)
      const target = get().messages.find((m) => m.id === messageId);
      if (target?.threadId) {
        set({ messages: get().messages.filter((m) => m.id !== messageId) });
      } else {
        get().onMessageDeleted({ messageId, threadId: null });
      }
    } catch (err) {
      console.error('Failed to delete message:', err);
      throw err;
    }
  },

  clearSendError: () => set({ sendError: null }),

  updateUserInMessages: (userId, updates) => {
    set({
      messages: get().messages.map((msg) => {
        const isAuthor = msg.userId === userId;
        const participants = msg.threadParticipants;
        const hasParticipant = participants?.some((p) => p.id === userId) ?? false;
        if (!isAuthor && !hasParticipant) return msg;
        return {
          ...msg,
          user: isAuthor ? { ...msg.user, ...updates } : msg.user,
          threadParticipants: participants && hasParticipant
            ? participants.map((p) =>
                p.id === userId ? { ...p, ...updates } : p
              )
            : participants,
        };
      }),
    });
  },

  // Socket event handlers — called when we receive a broadcast from the server
  onMessageNew: (msg: api.ApiMessage) => {
    // Avoid duplicates (we already added it locally when we sent via REST)
    if (get().messages.some((m) => m.id === msg.id)) return;
    const message = transformApiMessage(msg);
    // Only add to messages list if it belongs to the currently loaded channel
    if (message.channelId === get().loadedChannelId) {
      // If this is a reply, update the parent message's threadCount and threadParticipants
      if (msg.threadId) {
        const currentUserId = getUserId();
        // "채널에도 보내기" 답글은 타임라인에도 나타난다
        if (msg.alsoSendToChannel) set((state) => ({ messages: [...state.messages, message] }));
        const isOwnReply = msg.userId === currentUserId;
        set((state) => ({
          messages: state.messages.map((m) => {
            if (m.id !== msg.threadId) return m;
            const participant = { id: msg.user.id, name: msg.user.name, avatar: msg.user.avatar ?? null };
            const alreadyParticipant = m.threadParticipants?.some((p) => p.id === participant.id);
            return {
              ...m,
              // Only increment count for other users' replies — own count is updated via onReplyCountChange
              threadCount: isOwnReply ? m.threadCount : m.threadCount + 1,
              threadParticipants: alreadyParticipant
                ? m.threadParticipants
                : [...(m.threadParticipants ?? []), participant],
            };
          }),
        }));
      } else {
        set((state) => ({ messages: [...state.messages, message] }));
      }
    }
  },

  onMessageUpdated: (msg: api.ApiMessage) => {
    const prev = get().messages.find((m) => m.id === msg.id);
    let updated = transformApiMessage(msg);
    // 편집 응답에는 답글 수(_count)와 부모 발췌가 없을 수 있다. 기존 값을 보존한다.
    if (prev) {
      updated = {
        ...updated,
        threadCount: msg._count ? updated.threadCount : prev.threadCount,
        threadParticipants: msg.threadParticipants ?? prev.threadParticipants,
        parentExcerpt: msg.parent !== undefined ? updated.parentExcerpt : prev.parentExcerpt,
      };
    }
    // 스레드 답글의 "채널에도 보내기"가 사후에 켜지거나 꺼진 경우: 타임라인에 넣거나 뺀다
    if (msg.threadId) {
      const exists = get().messages.some((m) => m.id === updated.id);
      if (msg.alsoSendToChannel && !exists && updated.channelId === get().loadedChannelId) {
        set({ messages: [...get().messages, updated].sort((a, b) => a.id - b.id) });
      } else if (!msg.alsoSendToChannel) {
        set({ messages: get().messages.filter((m) => m.id !== updated.id) });
      } else {
        set({ messages: get().messages.map((m) => (m.id === updated.id ? updated : m)) });
      }
      return;
    }
    set({
      messages: get().messages.map((m) => (m.id === updated.id ? updated : m)),
    });
  },

  onMessageDeleted: (data: { messageId: number; threadId?: number | null }) => {
    if (data.threadId) {
      // A thread reply was deleted — decrement the parent message's threadCount
      // 채널에도 보냈던 답글의 타임라인 복사본도 함께 지운다. 답글이 모두 사라진 삭제된 부모(자리표시자)도 치운다.
      set({
        messages: get().messages
          .filter((m) => m.id !== data.messageId)
          .map((m) => (m.id === data.threadId ? { ...m, threadCount: Math.max(0, m.threadCount - 1) } : m))
          .filter((m) => !(m.id === data.threadId && m.isDeleted && m.threadCount === 0)),
      });
    } else {
      // 답글이 남은 부모는 자리표시자로 남기고, 답글이 없으면 목록에서 뺀다
      set({
        messages: get().messages.flatMap((m) => {
          if (m.id !== data.messageId) return [m];
          return m.threadCount > 0 ? [{ ...m, content: '', files: [], reactions: [], isDeleted: true }] : [];
        }),
      });
    }
  },

  onReactionAdded: (data) => {
    const currentUserId = getUserId();
    // Skip if this is our own reaction (already applied optimistically)
    if (data.reaction.userId === currentUserId) return;

    set({
      messages: get().messages.map((msg) => {
        if (msg.id !== data.messageId) return msg;
        const existing = msg.reactions.find((r) => r.emoji === data.reaction.emoji);
        if (existing) {
          if (existing.userIds.includes(data.reaction.userId)) return msg;
          return {
            ...msg,
            reactions: msg.reactions.map((r) =>
              r.emoji === data.reaction.emoji
                ? { ...r, count: r.count + 1, userIds: [...r.userIds, data.reaction.userId], userNames: [...r.userNames, data.reaction.user.name] }
                : r,
            ),
          };
        }
        return {
          ...msg,
          reactions: [...msg.reactions, { emoji: data.reaction.emoji, count: 1, userIds: [data.reaction.userId], userNames: [data.reaction.user.name] }],
        };
      }),
    });
  },

  onReactionRemoved: (data) => {
    const currentUserId = getUserId();
    // Skip if this is our own reaction (already applied optimistically)
    if (data.userId === currentUserId) return;

    set({
      messages: get().messages.map((msg) => {
        if (msg.id !== data.messageId) return msg;
        return {
          ...msg,
          reactions: msg.reactions
            .map((r) => {
              if (r.emoji !== data.emoji) return r;
              const idx = r.userIds.indexOf(data.userId);
              const newUserIds = r.userIds.filter((id) => id !== data.userId);
              const newUserNames = r.userNames.filter((_, i) => i !== idx);
              return { ...r, count: newUserIds.length, userIds: newUserIds, userNames: newUserNames };
            })
            .filter((r) => r.count > 0),
        };
      }),
    });
  },

  addReaction: async (messageId: number, emoji: string) => {
    const state = get();
    const userId = getUserId();
    if (!userId) return;
    // Check if reaction already exists to prevent double-click race
    const msg = state.messages.find((m) => m.id === messageId);
    if (msg?.reactions.some((r) => r.emoji === emoji && r.userIds.includes(userId))) return;
    // Capture channel ID at time of optimistic update for correct revert
    const channelAtUpdate = state.loadedChannelId;

    // Optimistic update
    set({
      messages: state.messages.map((m) => {
        if (m.id !== messageId) return m;
        const existing = m.reactions.find((r) => r.emoji === emoji);
        if (existing) {
          return {
            ...m,
            reactions: m.reactions.map((r) =>
              r.emoji === emoji
                ? { ...r, count: r.count + 1, userIds: [...r.userIds, userId], userNames: [...r.userNames, t('messages:reactions.you')] }
                : r,
            ),
          };
        }
        return {
          ...m,
          reactions: [...m.reactions, { emoji, count: 1, userIds: [userId], userNames: [t('messages:reactions.you')] }],
        };
      }),
    });

    try {
      await api.addReaction(messageId, emoji);
    } catch {
      if (channelAtUpdate) get().fetchMessages(channelAtUpdate);
    }
  },

  removeReaction: async (messageId: number, emoji: string) => {
    const state = get();
    const userId = getUserId();
    if (!userId) return;
    const channelAtUpdate = state.loadedChannelId;

    // Optimistic update
    set({
      messages: state.messages.map((m) => {
        if (m.id !== messageId) return m;
        return {
          ...m,
          reactions: m.reactions
            .map((r) => {
              if (r.emoji !== emoji) return r;
              const idx = r.userIds.indexOf(userId);
              const newUserIds = r.userIds.filter((id) => id !== userId);
              const newUserNames = r.userNames.filter((_, i) => i !== idx);
              return { ...r, count: newUserIds.length, userIds: newUserIds, userNames: newUserNames };
            })
            .filter((r) => r.count > 0),
        };
      }),
    });

    try {
      await api.removeReaction(messageId, emoji);
    } catch {
      if (channelAtUpdate) get().fetchMessages(channelAtUpdate);
    }
  },
}));

function getUserId(): number | null {
  return useAuthStore.getState().user?.id ?? null;
}
