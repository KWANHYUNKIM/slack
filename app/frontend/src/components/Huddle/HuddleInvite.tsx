import { useTranslation } from 'react-i18next';
import { Headphones, PhoneOff } from 'lucide-react';
import { useAuthStore } from '@/stores/useAuthStore';

interface HuddleSystemMessageProps {
  content: string;
  fromUserId: number;
}

/** "2m 34s" 같은 저장된 통화 시간을 현재 언어 문구로 바꾼다. 형식이 다르면 원문 그대로 둔다. */
function formatDuration(raw: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const match = raw.match(/^(?:(\d+)m )?(\d+)s$/);
  if (!match) return raw;
  const seconds = Number(match[2]);
  if (match[1] === undefined) return t('system.durationSeconds', { seconds });
  return t('system.durationMinutesSeconds', { minutes: Number(match[1]), seconds });
}

export function HuddleSystemMessage({ content, fromUserId }: HuddleSystemMessageProps) {
  const { t } = useTranslation('huddle');
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isSender = currentUserId === fromUserId;

  // Backward compat for old huddle DMs
  if (content === 'Started a huddle. Join to talk!') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 my-1">
        <Headphones className="h-5 w-5 text-gray-500 flex-shrink-0" />
        <span className="text-sm text-gray-600">
          {isSender ? t('system.youStarted') : t('system.started')}
        </span>
        <span className="ms-auto text-xs text-gray-500">{t('system.ended')}</span>
      </div>
    );
  }

  if (content === '[huddle:invite]') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 my-1">
        <Headphones className="h-5 w-5 text-green-600 flex-shrink-0" />
        <span className="text-sm text-green-800">
          {isSender ? t('system.youSentInvite') : t('system.sentInvite')}
        </span>
      </div>
    );
  }

  if (content === '[huddle:started]') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 my-1">
        <Headphones className="h-5 w-5 text-green-600 flex-shrink-0" />
        <span className="text-sm text-green-800">
          {t('system.huddleStarted')}
        </span>
      </div>
    );
  }

  // [huddle:ended:2m 34s]
  const endedMatch = content.match(/^\[huddle:ended:(.+)\]$/);
  if (endedMatch) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 my-1">
        <PhoneOff className="h-5 w-5 text-gray-500 flex-shrink-0" />
        <span className="text-sm text-gray-600">
          {t('system.huddleEnded', { duration: formatDuration(endedMatch[1], t) })}
        </span>
      </div>
    );
  }

  return null;
}
