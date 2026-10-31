import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/apiErrors';
import { create } from 'zustand';
import {
  getConversation, sendDM, editDM, deleteDM, addDMReaction, removeDMReaction,
  prefetchFileTokens, getDMGroupMessages, sendDMGroupMessage, type ApiDirectMessage, type ApiDMReaction,
} from '@/lib/api';
import { useAuthStore } from './useAuthStore';
import { useChannelStore } from './useChannelStore';
import { useUnreadStore } from './useUnreadStore';
import { dmUnreadScope } from '@/lib/unread';
import type { Reaction } from '@/lib/types';

export interface DMFile {
  id: number;
  filename: string;
  originalName: string;
  mimetype: string;
  size: number;
  url: string;
}

export interface DMMessage {
  id: number;
  content: string;
  fromUserId: number;
  fromUser: { id: number; name: string; avatar?: string | null };
  createdAt: Date;
  editedAt?: Date | null;
  threadId?: number | null;
  isPinned?: boolean;
  replyCount: number;
  threadParticipants: { id: number; name: string; avatar: string | null }[];
  reactions: Reaction[];
  files: DMFile[];
}

// 대화 키: 1:1 DM은 상대 userId(양수), 그룹 DM은 -groupId(음수).
// messages 맵과 액션(조회·전송·편집·리액션)이 이 숫자 키 하나로 두 종류의 대화를 함께 다룬다.
export const groupConversationKey = (groupId: number) => -groupId;
const isGroupKey = (key: number) => key < 0;

/** 소켓으로 받은 DM이 어느 대화에 속하는지 */
export function conversationKeyOf(
  dm: { fromUserId: number; toUserId: number | null; groupId?: number | null },
  currentUserId: number,
): number | null {
  if (dm.groupId) return groupConversationKey(dm.groupId);
  if (dm.toUserId === null) return null;
  return dm.fromUserId === currentUserId ? dm.toUserId : dm.fromUserId;
}

function groupReactions(apiReactions?: ApiDMReaction[]): Reaction[] {
  if (!apiReactions || apiReactions.length === 0) return [];
  const map = new Map<string, Reaction>();
  for (const r of apiReactions) {
    const existing = map.get(r.emoji);
    if (existing) {
      existing.count++;
      existing.userIds.push(r.userId);
      existing.userNames.push(r.user.name);
    } else {
      map.set(r.emoji, { emoji: r.emoji, count: 1, userIds: [r.userId], userNames: [r.user.name] });
    }
  }
  return [...map.values()];
}

function transformDM(dm: ApiDirectMessage): DMMessage {
  return {
    id: dm.id,
    content: dm.content,
    fromUserId: dm.fromUserId,
    fromUser: dm.fromUser,
    createdAt: new Date(dm.createdAt),
    editedAt: dm.editedAt ? new Date(dm.editedAt) : null,
    threadId: dm.threadId ?? null,
    isPinned: dm.isPinned ?? false,
    replyCount: dm._count?.replies ?? 0,
    threadParticipants: dm.threadParticipants ?? [],
    reactions: groupReactions(dm.reactions),
    files: (dm.files ?? []).map((f) => ({
      id: f.id,
      filename: f.filename,
      originalName: f.originalName ?? f.filename,
      mimetype: f.mimetype,
      size: f.size,
      url: f.url,
    })),
  };
}

interface DMState {
  /** 대화 키(1:1은 userId, 그룹은 groupConversationKey(groupId)) → 메시지 */
  messages: Record<number, DMMessage[]>;
  isLoading: boolean;
  loadError: string | null;
  loadingUserId: number | null;
  isSending: boolean;
  sendError: string | null;

  /** withUnread: 대화를 처음 열 때만. 읽음 처리 이전의 안 읽음 기준점을 같은 응답으로 받아 useUnreadStore에 고정한다 */
  fetchConversation: (userId: number, around?: number, withUnread?: boolean) => Promise<void>;
  sendMessage: (userId: number, content: string, fileIds?: number[]) => Promise<void>;
  editMessage: (messageId: number, content: string, userId: number) => Promise<void>;
  deleteMessage: (messageId: number, userId: number) => Promise<void>;
  addIncomingMessage: (dm: ApiDirectMessage, currentUserId: number) => void;
  onDMUpdated: (dm: ApiDirectMessage, currentUserId: number) => void;
  onDMDeleted: (data: { dmId: number; fromUserId: number; toUserId: number | null; groupId?: number | null }, currentUserId: number) => void;
  addReaction: (dmId: number, emoji: string, conversationUserId: number) => void;
  removeReaction: (dmId: number, emoji: string, conversationUserId: number) => void;
  onReactionAdded: (data: { dmId: number; reaction: { emoji: string; userId: number; user: { name: string } } }) => void;
  onReactionRemoved: (data: { dmId: number; emoji: string; userId: number }) => void;
  updateReplyCount: (messageId: number, userId: number, count: number, participant?: { id: number; name: string; avatar: string | null }) => void;
  incrementReplyCount: (messageId: number, userId: number, participant?: { id: number; name: string; avatar: string | null }) => void;
  clearConversation: (userId: number) => void;
  clearSendError: () => void;
}

export const useDMStore = create<DMState>((set, get) => ({
  messages: {},
  isLoading: false,
  loadError: null,
  loadingUserId: null,
  isSending: false,
  sendError: null,

  fetchConversation: async (userId: number, around?: number, withUnread?: boolean) => {
    set({ isLoading: true, loadError: null, loadingUserId: userId });
    const scope = dmUnreadScope(userId);
    try {
      let data: { messages: ApiDirectMessage[]; lastReadId?: number | null; unreadCount?: number };
      if (isGroupKey(userId)) {
        const groupData = await getDMGroupMessages(-userId, undefined, around, withUnread);
        // 응답에 실린 최신 멤버 목록으로 사이드바·헤더를 맞춘다
        if (groupData.group) useChannelStore.getState().upsertGroupDM(groupData.group);
        data = groupData;
      } else {
        data = await getConversation(userId, undefined, around, withUnread);
      }
      // Discard stale response if user already switched to another conversation
      if (get().loadingUserId !== userId) return;
      if (withUnread) {
        useUnreadStore.getState().setBaseline(scope, data.lastReadId ?? null, data.unreadCount ?? 0);
      }
      const msgs = data.messages.map(transformDM);
      prefetchFileTokens(msgs.flatMap((m) => m.files.map((f) => f.id)));
      if (!around) msgs.reverse(); // API returns DESC, we want ASC (around returns chronological)
      set((state) => ({
        messages: { ...state.messages, [userId]: msgs },
        isLoading: false,
        loadError: null,
      }));
    } catch {
      if (get().loadingUserId !== userId) return;
      if (withUnread) useUnreadStore.getState().setUnknown(scope);
      set({ isLoading: false, loadError: t('channels:dm.loadError') });
    }
  },

  sendMessage: async (userId: number, content: string, fileIds?: number[]) => {
    set({ isSending: true, sendError: null });
    try {
      const dm = isGroupKey(userId)
        ? await sendDMGroupMessage(-userId, content, fileIds)
        : await sendDM(userId, content, fileIds);
      const message = transformDM(dm);
      set((state) => {
        const existing = state.messages[userId] ?? [];
        // Dedup: the REST broadcast (io.to) may have already delivered this
        // via the dm:new WebSocket event before the HTTP response arrived
        if (existing.some((m) => m.id === message.id)) {
          return { isSending: false };
        }
        return {
          messages: {
            ...state.messages,
            [userId]: [...existing, message],
          },
          isSending: false,
        };
      });
    } catch (err) {
      set({ isSending: false, sendError: apiErrorMessage(err, 'channels:dm.sendError') });
    }
  },

  editMessage: async (messageId: number, content: string, userId: number) => {
    try {
      const updated = await editDM(messageId, content);
      const message = transformDM(updated);
      set((state) => ({
        messages: {
          ...state.messages,
          [userId]: (state.messages[userId] ?? []).map((m) =>
            m.id === messageId ? message : m,
          ),
        },
      }));
    } catch (err) {
      console.error('Failed to edit DM:', err);
      throw err;
    }
  },

  deleteMessage: async (messageId: number, userId: number) => {
    try {
      await deleteDM(messageId);
      set((state) => ({
        messages: {
          ...state.messages,
          [userId]: (state.messages[userId] ?? []).filter((m) => m.id !== messageId),
        },
      }));
    } catch (err) {
      console.error('Failed to delete DM:', err);
      throw err;
    }
  },

  clearSendError: () => set({ sendError: null }),

  updateReplyCount: (messageId: number, userId: number, count: number, participant?: { id: number; name: string; avatar: string | null }) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [userId]: (state.messages[userId] ?? []).map((m) => {
          if (m.id !== messageId) return m;
          const updatedParticipants = participant && !m.threadParticipants.some((p) => p.id === participant.id)
            ? [...m.threadParticipants, participant]
            : m.threadParticipants;
          return { ...m, replyCount: count, threadParticipants: updatedParticipants };
        }),
      },
    }));
  },

  addReaction: async (dmId: number, emoji: string, conversationUserId: number) => {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;
    const userId = currentUser.id;

    // Optimistic update
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationUserId]: (state.messages[conversationUserId] ?? []).map((m) => {
          if (m.id !== dmId) return m;
          const existing = m.reactions.find((r) => r.emoji === emoji);
          if (existing) {
            if (existing.userIds.includes(userId)) return m;
            return { ...m, reactions: m.reactions.map((r) => r.emoji === emoji ? { ...r, count: r.count + 1, userIds: [...r.userIds, userId], userNames: [...r.userNames, currentUser.name] } : r) };
          }
          return { ...m, reactions: [...m.reactions, { emoji, count: 1, userIds: [userId], userNames: [currentUser.name] }] };
        }),
      },
    }));

    try {
      await addDMReaction(dmId, emoji);
    } catch {
      // Revert on failure by refetching
      get().fetchConversation(conversationUserId);
    }
  },

  removeReaction: async (dmId: number, emoji: string, conversationUserId: number) => {
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) return;
    const userId = currentUser.id;

    // Optimistic update
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationUserId]: (state.messages[conversationUserId] ?? []).map((m) => {
          if (m.id !== dmId) return m;
          return {
            ...m,
            reactions: m.reactions
              .map((r) => {
                if (r.emoji !== emoji) return r;
                const idx = r.userIds.indexOf(userId);
                if (idx === -1) return r;
                return { ...r, count: r.count - 1, userIds: r.userIds.filter((_, i) => i !== idx), userNames: r.userNames.filter((_, i) => i !== idx) };
              })
              .filter((r) => r.count > 0),
          };
        }),
      },
    }));

    try {
      await removeDMReaction(dmId, emoji);
    } catch {
      get().fetchConversation(conversationUserId);
    }
  },

  onReactionAdded: (data: { dmId: number; reaction: { emoji: string; userId: number; user: { name: string } } }) => {
    // Skip own reactions — already applied optimistically
    const currentUser = useAuthStore.getState().user;
    if (currentUser && data.reaction.userId === currentUser.id) return;
    const state = get();
    // Find which conversation contains this DM
    for (const [userIdStr, msgs] of Object.entries(state.messages)) {
      const msg = msgs.find((m) => m.id === data.dmId);
      if (!msg) continue;
      const uid = Number(userIdStr);
      // Skip if already applied (optimistic update)
      const existing = msg.reactions.find((r) => r.emoji === data.reaction.emoji);
      if (existing?.userIds.includes(data.reaction.userId)) return;
      set((s) => ({
        messages: {
          ...s.messages,
          [uid]: (s.messages[uid] ?? []).map((m) => {
            if (m.id !== data.dmId) return m;
            const ex = m.reactions.find((r) => r.emoji === data.reaction.emoji);
            if (ex) {
              return { ...m, reactions: m.reactions.map((r) => r.emoji === data.reaction.emoji ? { ...r, count: r.count + 1, userIds: [...r.userIds, data.reaction.userId], userNames: [...r.userNames, data.reaction.user.name] } : r) };
            }
            return { ...m, reactions: [...m.reactions, { emoji: data.reaction.emoji, count: 1, userIds: [data.reaction.userId], userNames: [data.reaction.user.name] }] };
          }),
        },
      }));
      return;
    }
  },

  onReactionRemoved: (data: { dmId: number; emoji: string; userId: number }) => {
    // Skip own removals — already applied optimistically
    const currentUser = useAuthStore.getState().user;
    if (currentUser && data.userId === currentUser.id) return;
    const state = get();
    for (const [userIdStr, msgs] of Object.entries(state.messages)) {
      const msg = msgs.find((m) => m.id === data.dmId);
      if (!msg) continue;
      const uid = Number(userIdStr);
      set((s) => ({
        messages: {
          ...s.messages,
          [uid]: (s.messages[uid] ?? []).map((m) => {
            if (m.id !== data.dmId) return m;
            return {
              ...m,
              reactions: m.reactions
                .map((r) => {
                  if (r.emoji !== data.emoji) return r;
                  const idx = r.userIds.indexOf(data.userId);
                  if (idx === -1) return r;
                  return { ...r, count: r.count - 1, userIds: r.userIds.filter((_, i) => i !== idx), userNames: r.userNames.filter((_, i) => i !== idx) };
                })
                .filter((r) => r.count > 0),
            };
          }),
        },
      }));
      return;
    }
  },

  incrementReplyCount: (messageId: number, userId: number, participant?: { id: number; name: string; avatar: string | null }) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [userId]: (state.messages[userId] ?? []).map((m) => {
          if (m.id !== messageId) return m;
          const updatedParticipants = participant && !m.threadParticipants.some((p) => p.id === participant.id)
            ? [...m.threadParticipants, participant]
            : m.threadParticipants;
          return { ...m, replyCount: m.replyCount + 1, threadParticipants: updatedParticipants };
        }),
      },
    }));
  },

  addIncomingMessage: (dm: ApiDirectMessage, currentUserId: number) => {
    // Thread replies don't appear in the main conversation
    if (dm.threadId) return;
    const otherUserId = conversationKeyOf(dm, currentUserId);
    if (otherUserId === null) return;
    const state = get();
    // Only add if we have this conversation loaded and the message isn't already there
    if (!state.messages[otherUserId]) return;
    if (state.messages[otherUserId].some((m) => m.id === dm.id)) return;
    const message = transformDM(dm);
    set({
      messages: {
        ...state.messages,
        [otherUserId]: [...state.messages[otherUserId], message],
      },
    });
  },

  onDMUpdated: (dm: ApiDirectMessage, currentUserId: number) => {
    const otherUserId = conversationKeyOf(dm, currentUserId);
    if (otherUserId === null) return;
    const state = get();
    if (!state.messages[otherUserId]) return;
    const updated = transformDM(dm);
    set({
      messages: {
        ...state.messages,
        [otherUserId]: state.messages[otherUserId].map((m) =>
          m.id === dm.id ? updated : m,
        ),
      },
    });
  },

  onDMDeleted: (data: { dmId: number; fromUserId: number; toUserId: number | null; groupId?: number | null }, currentUserId: number) => {
    const otherUserId = conversationKeyOf(data, currentUserId);
    if (otherUserId === null) return;
    const state = get();
    if (!state.messages[otherUserId]) return;
    set({
      messages: {
        ...state.messages,
        [otherUserId]: state.messages[otherUserId].filter((m) => m.id !== data.dmId),
      },
    });
  },

  clearConversation: (userId: number) => {
    set((state) => {
      const rest = { ...state.messages };
      delete rest[userId];
      return { messages: rest };
    });
  },
}));
