import { Headphones, PhoneOff } from 'lucide-react';
import { useAuthStore } from '@/stores/useAuthStore';

interface HuddleSystemMessageProps {
  content: string;
  fromUserId: number;
}

export function HuddleSystemMessage({ content, fromUserId }: HuddleSystemMessageProps) {
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isSender = currentUserId === fromUserId;

  // Backward compat for old huddle DMs
  if (content === 'Started a huddle. Join to talk!') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 my-1">
        <Headphones className="h-5 w-5 text-gray-500 flex-shrink-0" />
        <span className="text-sm text-gray-600">
          {isSender ? 'You started a huddle.' : 'Started a huddle.'}
        </span>
        <span className="ml-auto text-xs text-gray-500">Ended</span>
      </div>
    );
  }

  if (content === '[huddle:invite]') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 my-1">
        <Headphones className="h-5 w-5 text-green-600 flex-shrink-0" />
        <span className="text-sm text-green-800">
          {isSender ? 'You sent a huddle invite.' : 'Sent you a huddle invite.'}
        </span>
      </div>
    );
  }

  if (content === '[huddle:started]') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 my-1">
        <Headphones className="h-5 w-5 text-green-600 flex-shrink-0" />
        <span className="text-sm text-green-800">
          Huddle started
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
          Huddle ended ({endedMatch[1]})
        </span>
      </div>
    );
  }

  return null;
}
