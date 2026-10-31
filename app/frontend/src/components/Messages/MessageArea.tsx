import { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Hash, Menu } from 'lucide-react';
import { useMobileStore } from '@/stores/useMobileStore';
import { useChannelStore } from '@/stores/useChannelStore';
import { useMessageStore } from '@/stores/useMessageStore';
import { MessageHeader } from './MessageHeader';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';

import { MembersPanel } from './MembersPanel';
import { ThreadPanel } from './ThreadPanel';
import { DMConversation } from './DMConversation';
import { PinsPanel } from './PinsPanel';
import { FilesPanel } from './FilesPanel';

export function MessageArea() {
  const { t } = useTranslation('messages');
  const { activeChannelId, activeDMId, getActiveChannel, getActiveDM } = useChannelStore();
  const activeChannel = getActiveChannel();
  const activeDM = getActiveDM();
  const { sendMessage, sendError, clearSendError } = useMessageStore();
  const joinChannel = useChannelStore((s) => s.joinChannel);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const activeGroupId = useChannelStore((s) => s.activeGroupId);
  const [showMembers, setShowMembers] = useState(false);
  const [showPins, setShowPins] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);

  const location = useLocation();
  // ?reply=<id>가 있으면 스레드 패널에서 그 답글을 강조한다(퍼말링크 07과 같은 쿼리)
  const highlightReplyId = Number(new URLSearchParams(location.search).get('reply')) || null;

  // Close side panels when switching channels
  useEffect(() => {
    setShowMembers(false);
    setShowPins(false);
    setShowFiles(false);
    setActiveThreadId(null);
  }, [activeChannelId]);

  // 스레드 모아보기 카드에서 넘어오면 그 스레드를 연다(위 초기화 뒤에 실행되도록 아래에 둔다)
  const openThreadId = (location.state as { openThreadId?: number } | null)?.openThreadId;
  useEffect(() => {
    if (openThreadId) setActiveThreadId(openThreadId);
  }, [location.key, activeChannelId, openThreadId]);

  const handleOpenThread = useCallback((messageId: number) => {
    setActiveThreadId(messageId);
    setShowMembers(false);
  }, []);

  const handleCloseThread = useCallback(() => {
    setActiveThreadId(null);
  }, []);

  const handleReplyCountChange = useCallback((messageId: number, count: number) => {
    useMessageStore.setState((state) => ({
      messages: state.messages.map((m) =>
        m.id === messageId ? { ...m, threadCount: count } : m
      ),
    }));
  }, []);

  // Stabilize onSend callback to prevent MessageInput re-renders
  const handleSendMessage = useCallback(
    async (content: string, fileIds?: number[]) => {
      if (activeChannelId) {
        await sendMessage(activeChannelId, content, fileIds);
      }
    },
    [activeChannelId, sendMessage]
  );

  // Memoize placeholder to prevent MessageInput re-renders
  const activeChannelName = activeChannel?.name;
  const placeholder = useMemo(
    () => (activeChannelName ? t('area.placeholder', { channel: activeChannelName }) : ''),
    [activeChannelName, t]
  );

  // Show group DM conversation if a group DM is active (멤버 목록은 대화를 열면서 받아 온다)
  if (activeGroupId) {
    return <DMConversation groupId={activeGroupId} />;
  }

  // Show DM conversation if a DM is active
  if (activeDMId && activeDM) {
    return <DMConversation userId={activeDM.userId} userName={activeDM.userName} userAvatar={activeDM.userAvatar || undefined} />;
  }

  if (!activeChannel) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-slack-hint">
        <button
          onClick={useMobileStore.getState().openSidebar}
          aria-label={t('area.openMenu')}
          className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-slack-hover md:hidden"
        >
          <Menu className="h-5 w-5 text-slack-secondary" />
        </button>
        {t('area.selectChannel')}
      </div>
    );
  }

  const readOnly = !activeChannel.isMember;

  return (
    <div className="relative flex h-full">
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <MessageHeader
          channel={activeChannel}
          showMembers={showMembers}
          showPins={showPins}
          showFiles={showFiles}
          readOnly={readOnly}
          onToggleMembers={() => {
            setShowMembers(!showMembers);
            if (!showMembers) {
              setActiveThreadId(null);
              setShowPins(false);
              setShowFiles(false);
            }
          }}
          onTogglePins={() => {
            setShowPins(!showPins);
            if (!showPins) {
              setShowMembers(false);
              setShowFiles(false);
              setActiveThreadId(null);
            }
          }}
          onToggleFiles={() => {
            setShowFiles(!showFiles);
            if (!showFiles) {
              setShowMembers(false);
              setShowPins(false);
              setActiveThreadId(null);
            }
          }}
        />
        <MessageList channelId={activeChannelId!} onOpenThread={handleOpenThread} readOnly={readOnly} />
        {readOnly ? (
          <div className="px-5 pb-4 pt-3 bg-white border-t border-slack-border">
            <div className="flex items-center justify-center gap-3 rounded-lg border border-slack-border p-4">
              <Hash className="h-4 w-4 text-slack-secondary" />
              <span className="text-[15px] text-slack-secondary">{t('area.viewing', { channel: activeChannel.name })}</span>
              <button
                onClick={async () => { await joinChannel(activeChannelId!); await fetchChannels(); }}
                className="rounded bg-slack-btn px-4 py-1.5 text-sm font-medium text-white hover:bg-slack-btn-hover"
              >
                {t('area.joinChannel')}
              </button>
            </div>
          </div>
        ) : (
          <MessageInput
            placeholder={placeholder}
            onSend={handleSendMessage}
            sendError={sendError}
            clearSendError={clearSendError}
            channelId={activeChannelId!}
          />
        )}
      </div>
      {showMembers && (
        <MembersPanel
          key={activeChannelId}
          channelId={activeChannelId!}
          onClose={() => setShowMembers(false)}
        />
      )}
      {showPins && (
        <PinsPanel
          key={activeChannelId}
          channelId={activeChannelId!}
          onClose={() => setShowPins(false)}
        />
      )}
      {showFiles && (
        <FilesPanel
          key={activeChannelId}
          channelId={activeChannelId!}
          onClose={() => setShowFiles(false)}
        />
      )}
      {activeThreadId && (
        <ThreadPanel
          key={activeThreadId}
          messageId={activeThreadId}
          onClose={handleCloseThread}
          onReplyCountChange={handleReplyCountChange}
          highlightReplyId={highlightReplyId}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}
