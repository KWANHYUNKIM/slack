import { t as translate } from '@/lib/i18n';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { SendHorizontal } from 'lucide-react';
import {
  getThread, replyToMessage, getDMThread, replyToDM,
  editMessage as apiEditMessage, deleteMessage as apiDeleteMessage,
  editDM, deleteDM,
  addReaction as apiAddReaction, removeReaction as apiRemoveReaction,
  addDMReaction, removeDMReaction, setReplyBroadcast,
  type ApiDirectMessage,
  type ApiMessage,
} from '@/lib/api';
import { prefetchFileTokens } from '@/lib/api';
import { useAuthStore } from '@/stores/useAuthStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { cn } from '@/lib/utils';
import { getSocket } from '@/lib/socket';
import { serializeDelta } from '@/lib/serializeDelta';
import { convertShortcodesForSend } from '@/lib/emoji/emojiData';
import { FormatToolbar } from './FormatToolbar';
import { FilePreview } from './FilePreview';
import { MentionDropdown } from './MentionDropdown';
import { EmojiAutocomplete } from './EmojiAutocomplete';
import { EmojiPicker } from '@/components/ui/emoji-picker';
import { LinkModal } from './LinkModal';
import { PanelHeader } from './PanelHeader';
import { EditorToolbar } from './EditorToolbar';
import { useQuillEditor } from '@/hooks/useQuillEditor';
import { shouldClearAlsoSend } from '@/lib/alsoSend';
import { Message } from './Message';
import type { Message as MessageType, Reaction } from '@/lib/types';

interface ThreadPanelProps {
  messageId: number;
  onClose: () => void;
  onReplyCountChange?: (messageId: number, count: number, fromSelf?: boolean) => void;
  variant?: 'channel' | 'dm';
  readOnly?: boolean;
  /** ?reply=로 지정된 답글. 열릴 때 그 답글로 스크롤하고 강조한다. */
  highlightReplyId?: number | null;
  /** DM 스레드의 링크 복사가 가리킬 대화 */
  permalinkBase?: { kind: 'channel' | 'dm' | 'group'; conversationId: number };
}

function normalizeToMessage(msg: ApiMessage | ApiDirectMessage): MessageType {
  // DMs carry fromUser/fromUserId, channel messages carry user/userId
  const isDMMessage = 'fromUserId' in msg;
  const user = isDMMessage ? msg.fromUser : msg.user;
  const reactionMap = new Map<string, Reaction>();
  for (const r of msg.reactions ?? []) {
    const userName = r.user?.name ?? '';
    const existing = reactionMap.get(r.emoji);
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
    userId: isDMMessage ? msg.fromUserId : msg.userId,
    user: { id: user.id, name: user.name, avatar: user.avatar },
    channelId: isDMMessage ? 0 : msg.channelId,
    createdAt: new Date(msg.createdAt),
    reactions: Array.from(reactionMap.values()),
    files: (msg.files ?? []).map((f) => ({
      id: f.id,
      filename: f.filename,
      originalName: f.originalName ?? f.filename,
      mimetype: f.mimetype,
      size: f.size,
      url: f.url,
    })),
    threadCount: 0,
    threadId: msg.threadId ?? null,
    alsoSendToChannel: 'alsoSendToChannel' in msg ? !!msg.alsoSendToChannel : false,
    isDeleted: !!(msg as { deletedAt?: string | null }).deletedAt,
    isEdited: !!msg.editedAt,
    isPinned: false,
  };
}

export function ThreadPanel({ messageId, onClose, onReplyCountChange, variant = 'channel', readOnly, highlightReplyId, permalinkBase }: ThreadPanelProps) {
  const { t } = useTranslation('messages');
  const isDM = variant === 'dm';
  const testPrefix = isDM ? 'dm-thread' : 'thread';

  const [parentMessage, setParentMessage] = useState<MessageType | null>(null);
  const [replies, setReplies] = useState<MessageType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [alsoSend, setAlsoSend] = useState(false);
  // 사용자가 체크를 바꾼 횟수. 전송 응답이 올 때 그사이 바뀌었는지 확인하는 데 쓴다
  const alsoSendVersion = useRef(0);
  const repliesEndRef = useRef<HTMLDivElement>(null);

  const handleSendRef = useRef<() => void>(() => {});

  const editor = useQuillEditor({
    placeholder: t('threadPanel.replyPlaceholder'),
    onSendRef: handleSendRef,
    onTextChange: () => setReplyError(null),
  });

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    const fetchFn = isDM ? getDMThread(messageId) : getThread(messageId);
    fetchFn
      .then((data) => {
        if (cancelled) return;
        setParentMessage(normalizeToMessage(data.parent));
        setReplies(data.replies.map((r) => normalizeToMessage(r)));
        prefetchFileTokens([data.parent, ...data.replies].flatMap((m) => (m.files ?? []).map((f: { id: number }) => f.id)));
        // 스레드를 열었으니 읽음 처리한다(보기만 하는 비멤버는 서버가 거부하므로 건너뛴다)
        if (!isDM && !readOnly) void useThreadStore.getState().markRead(messageId);
      })
      .catch(() => {
        if (!cancelled) setLoadError('threadPanel.loadFailed');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [messageId, isDM, readOnly]);

  // Listen for real-time thread replies via WebSocket
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    if (isDM) {
      const handleDMReply = (reply: ApiDirectMessage & { threadId: number }) => {
        if (reply.threadId !== messageId) return;
        const normalized = normalizeToMessage(reply);
        setReplies((prev) => {
          if (prev.some((r) => r.id === normalized.id)) return prev;
          return [...prev, normalized];
        });
      };
      socket.on('dm:reply', handleDMReply);
      return () => { socket.off('dm:reply', handleDMReply); };
    } else {
      const handleNewMessage = (msg: ApiMessage) => {
        if (msg.threadId !== messageId) return;
        // 패널이 열려 있는 동안 온 답글은 바로 읽음 처리한다
        if (!readOnly && msg.userId !== useAuthStore.getState().user?.id) void useThreadStore.getState().markRead(messageId);
        const normalized = normalizeToMessage(msg);
        setReplies((prev) => {
          if (prev.some((r) => r.id === normalized.id)) return prev;
          return [...prev, normalized];
        });
      };
      const handleDeletedMessage = (data: { messageId: number; threadId?: number | null }) => {
        if (data.threadId !== messageId) return;
        setReplies((prev) => prev.filter((r) => r.id !== data.messageId));
      };
      socket.on('message:new', handleNewMessage);
      socket.on('message:deleted', handleDeletedMessage);
      return () => {
        socket.off('message:new', handleNewMessage);
        socket.off('message:deleted', handleDeletedMessage);
      };
    }
  }, [messageId, isDM, readOnly]);

  // ?reply=가 있고 아직 그 위치로 가지 않았다면 답글로, 아니면 맨 아래로 스크롤한다
  const scrolledToHighlight = useRef(false);
  useEffect(() => {
    scrolledToHighlight.current = false;
  }, [messageId, highlightReplyId]);
  useEffect(() => {
    if (highlightReplyId && !scrolledToHighlight.current && replies.some((r) => r.id === highlightReplyId)) {
      scrolledToHighlight.current = true;
      document.querySelector(`[data-testid="${testPrefix}-panel"] [data-message-id="${highlightReplyId}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    repliesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [replies, highlightReplyId, testPrefix]);

  // Notify parent of reply count changes
  const onReplyCountChangeRef = useRef(onReplyCountChange);
  onReplyCountChangeRef.current = onReplyCountChange;
  const hasLoadedReplies = useRef(false);
  const didSendReply = useRef(false);
  useEffect(() => {
    if (!hasLoadedReplies.current && replies.length === 0) return;
    hasLoadedReplies.current = true;
    onReplyCountChangeRef.current?.(messageId, replies.length, didSendReply.current);
    didSendReply.current = false;
  }, [replies.length, messageId]);

  // --- Callbacks for Message component ---

  const handleEditMessage = useCallback(async (msgId: number, content: string) => {
    if (isDM) {
      const updated = await editDM(msgId, content);
      const normalized = normalizeToMessage(updated);
      if (parentMessage && msgId === parentMessage.id) {
        setParentMessage(normalized);
      } else {
        setReplies((prev) => prev.map((r) => r.id === msgId ? normalized : r));
      }
    } else {
      const updated = await apiEditMessage(msgId, content);
      // Edit endpoint returns user + reactions but not files — preserve existing data
      const updateMsg = (existing: MessageType): MessageType => ({
        ...existing,
        content: updated.content,
        isEdited: !!updated.editedAt,
      });
      if (parentMessage && msgId === parentMessage.id) {
        setParentMessage((prev) => prev ? updateMsg(prev) : prev);
      } else {
        setReplies((prev) => prev.map((r) => r.id === msgId ? updateMsg(r) : r));
      }
    }
  }, [isDM, parentMessage]);

  const handleDeleteMessage = useCallback(async (msgId: number) => {
    if (isDM) {
      await deleteDM(msgId);
    } else {
      await apiDeleteMessage(msgId);
    }
    if (parentMessage && msgId === parentMessage.id) {
      onClose();
    } else {
      setReplies((prev) => prev.filter((r) => r.id !== msgId));
    }
  }, [isDM, parentMessage, onClose]);

  const handleAddReaction = useCallback((msgId: number, emoji: string) => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;

    const addToMsg = (msg: MessageType): MessageType => {
      const existing = msg.reactions.find((r) => r.emoji === emoji);
      if (existing) {
        if (existing.userIds.includes(userId)) return msg;
        return {
          ...msg,
          reactions: msg.reactions.map((r) =>
            r.emoji === emoji
              ? { ...r, count: r.count + 1, userIds: [...r.userIds, userId], userNames: [...r.userNames, translate('messages:reactions.you')] }
              : r
          ),
        };
      }
      return {
        ...msg,
        reactions: [...msg.reactions, { emoji, count: 1, userIds: [userId], userNames: [translate('messages:reactions.you')] }],
      };
    };

    if (parentMessage && msgId === parentMessage.id) {
      setParentMessage((prev) => prev ? addToMsg(prev) : prev);
    } else {
      setReplies((prev) => prev.map((r) => r.id === msgId ? addToMsg(r) : r));
    }

    (isDM ? addDMReaction(msgId, emoji) : apiAddReaction(msgId, emoji)).catch(() => {});
  }, [isDM, parentMessage]);

  const handleRemoveReaction = useCallback((msgId: number, emoji: string) => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;

    const removeFromMsg = (msg: MessageType): MessageType => ({
      ...msg,
      reactions: msg.reactions
        .map((r) => {
          if (r.emoji !== emoji) return r;
          const idx = r.userIds.indexOf(userId);
          const newUserIds = r.userIds.filter((id) => id !== userId);
          const newUserNames = r.userNames.filter((_, i) => i !== idx);
          return { ...r, count: newUserIds.length, userIds: newUserIds, userNames: newUserNames };
        })
        .filter((r) => r.count > 0),
    });

    if (parentMessage && msgId === parentMessage.id) {
      setParentMessage((prev) => prev ? removeFromMsg(prev) : prev);
    } else {
      setReplies((prev) => prev.map((r) => r.id === msgId ? removeFromMsg(r) : r));
    }

    (isDM ? removeDMReaction(msgId, emoji) : apiRemoveReaction(msgId, emoji)).catch(() => {});
  }, [isDM, parentMessage]);

  const handleToggleBroadcast = useCallback((msgId: number, on: boolean) => {
    setReplies((prev) => prev.map((r) => (r.id === msgId ? { ...r, alsoSendToChannel: on } : r)));
    setReplyBroadcast(msgId, on).catch(() => {
      setReplies((prev) => prev.map((r) => (r.id === msgId ? { ...r, alsoSendToChannel: !on } : r)));
    });
  }, []);

  // --- Send reply ---

  const handleSendReply = useCallback(async () => {
    const quill = editor.quillRef.current;
    if (!quill) return;
    const text = await convertShortcodesForSend(serializeDelta(quill));
    if (!text && editor.pendingFiles.length === 0) return;
    const content = text || ' ';

    // 이번 전송에 쓴 체크 상태를 잡아 둔다. 응답이 오기 전에 사용자가 다시 체크했을 수 있다
    const sentAlsoSend = alsoSend;
    const sentAlsoSendVersion = alsoSendVersion.current;
    setIsSending(true);
    setReplyError(null);
    didSendReply.current = true;
    try {
      let apiReply;
      const fileIds = editor.pendingFiles.map((f) => f.id);
      const fileIdsParam = fileIds.length > 0 ? fileIds : undefined;
      if (isDM) {
        apiReply = await replyToDM(messageId, content, fileIdsParam);
      } else {
        apiReply = await replyToMessage(messageId, content, fileIdsParam, sentAlsoSend);
      }
      const reply = normalizeToMessage(apiReply);
      setReplies((prev) => {
        if (prev.some((r) => r.id === reply.id)) return prev;
        return [...prev, reply];
      });
      editor.clearEditor();
      // 응답을 기다리는 사이 사용자가 체크를 바꾸지 않았을 때만 푼다
      if (shouldClearAlsoSend(sentAlsoSendVersion, alsoSendVersion.current)) setAlsoSend(false);
    } catch (err) {
      didSendReply.current = false;
      console.error('Failed to send reply:', err);
      setReplyError('threadPanel.replyFailed');
    } finally {
      setIsSending(false);
    }
  }, [messageId, editor, isDM, alsoSend]);

  handleSendRef.current = handleSendReply;

  const hasContent = editor.canSend || editor.pendingFiles.length > 0;

  return (
    <div
      data-testid={`${testPrefix}-panel`}
      className="flex w-full md:w-[380px] flex-col border-s border-slack-border bg-white absolute inset-0 md:static md:inset-auto z-30 md:z-auto"
    >
      <PanelHeader title={t('threadPanel.title')} onClose={onClose} />

      {/* Thread messages */}
      <div className="flex-1 overflow-y-auto py-3">
        {isLoading ? (
          <div className="text-center text-sm text-slack-hint py-4">{t('threadPanel.loading')}</div>
        ) : loadError ? (
          <div data-testid={`${testPrefix}-load-error`} className="text-center text-sm text-slack-error py-4">{t(loadError)}</div>
        ) : (
          <>
            {parentMessage && (
              <div className="mb-2 pb-3 border-b border-slack-border">
                <Message
                  message={parentMessage}
                  showAvatar={true}
                  variant="thread"
                  permalinkBase={permalinkBase}
                  readOnly={readOnly}
                  onEditMessage={handleEditMessage}
                  onDeleteMessage={handleDeleteMessage}
                  onAddReaction={handleAddReaction}
                  onRemoveReaction={handleRemoveReaction}
                />
                {replies.length > 0 && (
                  <div className="mt-2 px-5 text-[12px] text-slack-secondary">
                    {t('thread.replyCount', { count: replies.length })}
                  </div>
                )}
              </div>
            )}

            {replies.map((reply) => (
              <Message
                key={reply.id}
                message={reply}
                showAvatar={true}
                variant="thread"
                permalinkBase={permalinkBase}
                readOnly={readOnly}
                onEditMessage={handleEditMessage}
                onDeleteMessage={handleDeleteMessage}
                onAddReaction={handleAddReaction}
                onRemoveReaction={handleRemoveReaction}
                highlighted={reply.id === highlightReplyId}
                onToggleBroadcast={isDM ? undefined : handleToggleBroadcast}
              />
            ))}
            <div ref={repliesEndRef} />
          </>
        )}
      </div>

      {/* Reply input */}
      <div className="relative border-t border-slack-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {readOnly ? (
          <div className="flex items-center justify-center py-3 text-[13px] text-slack-secondary">
            {t('threadPanel.joinToReply')}
          </div>
        ) : (<>
        {replyError && (
          <p data-testid={`${testPrefix}-reply-error`} className="mb-2 text-xs text-slack-error">{t(replyError)}</p>
        )}
        {editor.uploadError && (
          <p className="mb-2 text-xs text-slack-error">{editor.uploadError}</p>
        )}
        <div data-testid={`${testPrefix}-reply-input`} className="slawk-editor rounded-[8px] border border-slack-border-light">
          <FormatToolbar onApplyFormat={editor.applyFormat} />
          <FilePreview files={editor.pendingFiles} onRemove={editor.removePendingFile} />

          {editor.isUploading && (
            <div className="px-3 py-1 text-xs text-slack-hint">{t('input.uploading')}</div>
          )}

          <div ref={editor.editorRef} />

          {editor.showEmojiAutocomplete && editor.filteredEmojis.length > 0 && (
            <EmojiAutocomplete
              ref={editor.emojiAutocompleteRef}
              emojis={editor.filteredEmojis}
              selectedIndex={editor.emojiSelectedIndex}
              query={editor.emojiQuery}
              onSelect={editor.insertEmojiFromAutocomplete}
            />
          )}

          {editor.showMentionDropdown && (
            <MentionDropdown
              ref={editor.mentionDropdownRef}
              users={editor.mentionUsers}
              selectedIndex={editor.mentionSelectedIndex}
              onSelect={editor.insertMention}
            />
          )}

          {editor.showEmojiPicker && (
            <div className="absolute bottom-full start-0 mb-2 z-50">
              <EmojiPicker
                onEmojiSelect={editor.handleEmojiSelect}
                onClickOutside={() => editor.setShowEmojiPicker(false)}
              />
            </div>
          )}

          <input
            ref={editor.fileInputRef}
            type="file"
            className="hidden"
            accept="image/*,audio/*,video/*,.pdf,.txt,.json,.zip"
            onChange={editor.handleFileSelect}
          />

          {!isDM && (
            <label className="flex items-center gap-1.5 px-3 pb-1 text-[13px] text-slack-secondary">
              <input
                type="checkbox"
                data-testid="thread-also-send"
                checked={alsoSend}
                onChange={(e) => {
                  alsoSendVersion.current += 1;
                  setAlsoSend(e.target.checked);
                }}
              />
              {t('threadPanel.alsoSendToChannel')}
            </label>
          )}

          <EditorToolbar
            testIdPrefix={`${testPrefix}-`}
            onAttach={() => editor.fileInputRef.current?.click()}
            onEmojiToggle={() => editor.setShowEmojiPicker(!editor.showEmojiPicker)}
            onMention={editor.handleMentionButtonClick}
            isRecording={editor.isRecording}
            recordingDuration={editor.recordingDuration}
            onStartRecording={editor.startRecording}
            onStopRecording={editor.stopRecording}
            onCancelRecording={editor.cancelRecording}
          >
            <button
              data-testid={`${testPrefix}-send-button`}
              onClick={() => handleSendRef.current()}
              aria-label={t('input.send')}
              disabled={!hasContent || isSending}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded transition-colors',
                hasContent
                  ? 'bg-slack-btn text-white hover:bg-slack-btn-hover'
                  : 'text-slack-disabled',
              )}
            >
              <SendHorizontal className="h-4 w-4 rtl:-scale-x-100" />
            </button>
          </EditorToolbar>
        </div>

        {editor.showLinkModal && (
          <LinkModal
            linkUrl={editor.linkUrl}
            linkText={editor.linkText}
            onLinkUrlChange={editor.setLinkUrl}
            onLinkTextChange={editor.setLinkText}
            onSave={editor.handleLinkSave}
            onClose={() => editor.setShowLinkModal(false)}
          />
        )}
        </>)}
      </div>
    </div>
  );
}
