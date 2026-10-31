import { useState } from 'react';
import { Hash, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChannelStore } from '@/stores/useChannelStore';
import { ChannelDetailsModal } from './ChannelDetailsModal';

interface ChannelIntroProps {
  channelId: number;
  readOnly?: boolean;
}

// 채널 첫 화면의 소개 블록: 이름, 설명, 설명 편집 진입점
export function ChannelIntro({ channelId, readOnly }: ChannelIntroProps) {
  const { t } = useTranslation('messages');
  const channel = useChannelStore((s) => s.channels.find((ch) => ch.id === channelId));
  const [showDetails, setShowDetails] = useState(false);
  if (!channel) return null;

  return (
    <div data-testid="channel-intro" className="px-5 pb-4">
      <h2 className="flex items-center gap-1 text-[22px] font-black text-slack-primary">
        {channel.isPrivate ? <Lock className="h-5 w-5" /> : <Hash className="h-5 w-5" />}
        <span>{t('intro.title', { name: channel.name })}</span>
      </h2>
      <p className="mt-1 text-[15px] text-slack-secondary">
        {channel.description || t('intro.noDescription')}
      </p>
      {!readOnly && (
        <button
          data-testid="channel-intro-edit"
          onClick={() => setShowDetails(true)}
          className="mt-2 text-[14px] text-slack-link hover:underline"
        >
          {t('intro.editDescription')}
        </button>
      )}
      {showDetails && <ChannelDetailsModal channel={channel} onClose={() => setShowDetails(false)} />}
    </div>
  );
}
