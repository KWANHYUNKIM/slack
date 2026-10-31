import React, { useRef, useEffect, useCallback, useState } from 'react';
import type { Delta } from 'quill';
import {
  SendHorizontal,
  ChevronDown,
} from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/i18n/format';
import { cn } from '@/lib/utils';
import { PortalEmojiPicker } from '@/components/ui/emoji-picker';
import { scheduleMessage, ApiError } from '@/lib/api';
import { dlpBlockedMessage } from '@/lib/apiErrors';
import { serializeDelta } from '@/lib/serializeDelta';
import { convertShortcodesForSend } from '@/lib/emoji/emojiData';
import { LinkModal } from './LinkModal';
import { ScheduleModal } from './ScheduleModal';
import { ScheduleMenu } from './ScheduleMenu';
import { isRemindCommand, parseRemind } from '@/lib/remind';
import { useReminderStore } from '@/stores/useReminderStore';
import { FormatToolbar } from './FormatToolbar';
import { FilePreview } from './FilePreview';
import { MentionDropdown } from './MentionDropdown';
import { EmojiAutocomplete } from './EmojiAutocomplete';
import { EditorToolbar } from './EditorToolbar';
import { useQuillEditor } from '@/hooks/useQuillEditor';
import { useClickOutside } from '@/hooks/useClickOutside';
import { ErrorBanner, SuccessBanner } from '@/components/ui/ErrorBanner';

// Per-channel/DM draft storage (session-only, survives channel switches)
const drafts = new Map<string, Delta>();

function getDraftKey(channelId?: number, dmParticipantIds?: number[]): string {
  if (channelId) return `ch:${channelId}`;
  if (dmParticipantIds) return `dm:${dmParticipantIds.sort().join(',')}`;
  return '';
}

interface MessageInputProps {
  placeholder: string;
  onSend: (content: string, fileIds?: number[]) => Promise<void>;
  sendError: string | null;
  clearSendError: () => void;
  channelId?: number;
  dmParticipantIds?: number[];
  testIdPrefix?: string;
}

export const MessageInput = React.memo(function MessageInput({ placeholder, onSend, sendError, clearSendError, channelId, dmParticipantIds, testIdPrefix }: MessageInputProps) {
  const { t } = useTranslation('messages');
  const prefix = testIdPrefix ? `${testIdPrefix}-` : '';

  // Schedule message state
  const [showScheduleMenu, setShowScheduleMenu] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleConfirm, setScheduleConfirm] = useState<string | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [isScheduling, setIsScheduling] = useState(false);
  const scheduleMenuRef = useRef<HTMLDivElement>(null);

  const handleSendRef = useRef<() => void>(() => {});

  const editor = useQuillEditor({
    placeholder,
    onSendRef: handleSendRef,
    dmParticipantIds,
    testId: testIdPrefix ? `${testIdPrefix}-message-input` : undefined,
    enableInlineCode: true,
  });

  const handleSend = useCallback(async () => {
    const quill = editor.quillRef.current;
    if (!quill) return;
    // 입력 중 변환이 못 된 :단축코드:는 전송 직전에 바꾼다 (데이터가 늦으면 원문 그대로)
    const text = await convertShortcodesForSend(serializeDelta(quill));
    if (!text && editor.pendingFiles.length === 0) return;
    const content = text || '';
    // /remind 는 채널 메시지로 저장하지 않고 리마인더로 만든다(파싱 오류는 입력창 아래에 안내)
    if (isRemindCommand(text) && editor.pendingFiles.length === 0) {
      const parsed = parseRemind(text);
      if (!parsed.ok) {
        setScheduleError(t(`reminder.command.${parsed.error}`));
        setTimeout(() => setScheduleError(null), 6000);
        return;
      }
      const remindAt = new Date(Date.now() + parsed.minutes * 60_000);
      if (await useReminderStore.getState().create({ text: parsed.text, remindAt }, { notify: false })) {
        editor.clearEditor();
        const key = getDraftKey(channelId, dmParticipantIds);
        if (key) drafts.delete(key);
        setScheduleConfirm(t('reminder.command.created', { time: formatDateTime(remindAt) }));
        setTimeout(() => setScheduleConfirm(null), 4000);
      }
      // 실패하면 스토어가 오류 토스트를 띄운다(인라인 안내는 성공과 구문 오류만 맡는다)
      return;
    }
    const fileIds = editor.pendingFiles.map((f) => f.id);
    try {
      await onSend(content, fileIds.length > 0 ? fileIds : undefined);
      editor.clearEditor();
      // Clear saved draft on send
      const key = getDraftKey(channelId, dmParticipantIds);
      if (key) drafts.delete(key);
    } catch {
      // Send failed — editor content is preserved so the user doesn't lose their message
    }
  }, [onSend, editor, channelId, dmParticipantIds, t]);

  handleSendRef.current = handleSend;

  const handleSchedule = useCallback(
    async (scheduledAt: Date) => {
      const quill = editor.quillRef.current;
      if (!quill || !channelId) return;
      const text = await convertShortcodesForSend(serializeDelta(quill));
      if (!text) return;

      setIsScheduling(true);
      setScheduleError(null);
      try {
        await scheduleMessage(channelId, text, scheduledAt);
        editor.clearEditor();
        setShowScheduleMenu(false);
        setShowScheduleModal(false);

        setScheduleConfirm(t('input.scheduledFor', { time: formatDateTime(scheduledAt) }));
        setTimeout(() => setScheduleConfirm(null), 4000);
      } catch (err) {
        // 데이터 유출 방지 규칙에 걸리면 이유를 번역해 보여 준다. 그 밖에는 일반 문구.
        setScheduleError(err instanceof ApiError && err.code === 'DLP_BLOCKED' ? dlpBlockedMessage(err.rule) : t('input.scheduleFailed'));
        setTimeout(() => setScheduleError(null), 4000);
      } finally {
        setIsScheduling(false);
      }
    },
    [channelId, editor, t],
  );

  // Close schedule menu on outside click
  const closeScheduleMenu = useCallback(() => setShowScheduleMenu(false), []);
  useClickOutside(scheduleMenuRef, closeScheduleMenu, showScheduleMenu);

  // Save draft and restore when switching channels/DMs
  const prevKeyRef = useRef<string>('');
  useEffect(() => {
    const key = getDraftKey(channelId, dmParticipantIds);
    const quill = editor.quillRef.current;

    // Save draft from previous channel/DM
    if (prevKeyRef.current && quill) {
      const delta = quill.getContents();
      const text = quill.getText().trim();
      if (text) {
        drafts.set(prevKeyRef.current, delta);
      } else {
        drafts.delete(prevKeyRef.current);
      }
    }

    // Clear and restore draft for new channel/DM
    editor.clearEditor();
    if (key && quill) {
      const savedDraft = drafts.get(key);
      if (savedDraft) {
        quill.setContents(savedDraft);
        editor.setCanSend(true);
      }
    }

    prevKeyRef.current = key;
  }, [channelId, dmParticipantIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCustomSchedule = () => {
    setShowScheduleMenu(false);
    setShowScheduleModal(true);
  };

  const hasContent = editor.canSend || editor.pendingFiles.length > 0;

  return (
    <div className="relative px-5 pb-6 pt-4 bg-white">
      <div className="slawk-editor rounded-[8px] border border-slack-border-light">
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
          <PortalEmojiPicker
            anchorClassName="absolute bottom-full start-0 mb-2"
            onEmojiSelect={editor.handleEmojiSelect}
            onClickOutside={() => editor.setShowEmojiPicker(false)}
          />
        )}

        <input
          ref={editor.fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,audio/*,video/*,.pdf,.txt,.json,.zip"
          onChange={editor.handleFileSelect}
        />

        <EditorToolbar
          testIdPrefix={prefix}
          onAttach={() => editor.fileInputRef.current?.click()}
          onEmojiToggle={() => editor.setShowEmojiPicker(!editor.showEmojiPicker)}
          onMention={editor.handleMentionButtonClick}
          isRecording={editor.isRecording}
          recordingDuration={editor.recordingDuration}
          onStartRecording={editor.startRecording}
          onStopRecording={editor.stopRecording}
          onCancelRecording={editor.cancelRecording}
        >
          {/* Send button group with schedule dropdown */}
          <div className="flex items-center relative" ref={scheduleMenuRef}>
            <button
              data-testid={`${prefix}send-button`}
              onClick={handleSend}
              aria-label={t('input.send')}
              disabled={!hasContent}
              className={cn(
                'flex h-7 items-center justify-center rounded-s px-2 transition-colors',
                hasContent
                  ? 'bg-slack-btn text-white hover:bg-slack-btn-hover'
                  : 'text-slack-disabled',
              )}
            >
              <SendHorizontal className="h-4 w-4 rtl:-scale-x-100" />
            </button>
            <button
              data-testid={`${prefix}schedule-button`}
              onClick={() => hasContent && setShowScheduleMenu((v) => !v)}
              disabled={!hasContent}
              className={cn(
                'flex h-7 w-5 items-center justify-center rounded-e border-s transition-colors',
                hasContent
                  ? 'bg-slack-btn text-white hover:bg-slack-btn-hover border-slack-btn-hover'
                  : 'text-slack-disabled border-slack-border',
              )}
              title={t('input.scheduleMessage')}
              aria-label={t('input.scheduleMessage')}
            >
              <ChevronDown className="h-3 w-3" />
            </button>

            {showScheduleMenu && (
              <ScheduleMenu
                onSchedule={handleSchedule}
                onCustom={handleCustomSchedule}
                isScheduling={isScheduling}
              />
            )}
          </div>
        </EditorToolbar>
      </div>

      <p className="mt-1 text-xs text-slack-hint">
        <Trans
          t={t}
          i18nKey="input.hint"
          components={{
            kbd: <kbd className="rounded bg-slack-active-tab px-1 py-0.5 text-[10px] font-medium" />,
          }}
        />
      </p>

      {sendError && <ErrorBanner message={sendError} onDismiss={clearSendError} />}
      {editor.uploadError && <ErrorBanner message={editor.uploadError} onDismiss={() => editor.setUploadError(null)} />}
      {scheduleError && <ErrorBanner message={scheduleError} onDismiss={() => setScheduleError(null)} />}
      {scheduleConfirm && <SuccessBanner message={scheduleConfirm} data-testid="schedule-confirm" />}

      {showScheduleModal && (
        <ScheduleModal
          onSchedule={handleSchedule}
          onClose={() => setShowScheduleModal(false)}
          isScheduling={isScheduling}
        />
      )}

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
    </div>
  );
});
