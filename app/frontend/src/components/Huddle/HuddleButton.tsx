import { useTranslation } from 'react-i18next';
import { Headphones, PhoneOff } from 'lucide-react';
import { useHuddleStore } from '@/stores/useHuddleStore';

interface HuddleButtonProps {
  userId: number;
}

export function HuddleButton({ userId }: HuddleButtonProps) {
  const { t } = useTranslation('huddle');
  const { huddleId, peer, outgoingInvite, sendInvite, cancelInvite, error } = useHuddleStore();

  const isInHuddleWithThisPerson = huddleId !== null && peer?.userId === userId;
  const isCallingThisPerson = outgoingInvite?.toUserId === userId;
  const isInAnyHuddle = huddleId !== null;
  const hasOutgoingInvite = outgoingInvite !== null;

  const handleClick = () => {
    if (isInHuddleWithThisPerson) return;
    if (isCallingThisPerson) {
      cancelInvite();
      return;
    }
    if (isInAnyHuddle || hasOutgoingInvite) {
      useHuddleStore.setState({ error: isInAnyHuddle ? t('button.leaveFirstError') : t('button.cancelInviteFirstError') });
      return;
    }
    sendInvite(userId);
  };

  if (isCallingThisPerson) {
    return (
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors bg-yellow-100 text-yellow-700 hover:bg-yellow-200"
        title={t('button.cancelInvite')}
        aria-label={t('button.cancelInvite')}
      >
        <PhoneOff className="h-4 w-4" />
        <span className="text-xs font-medium">{t('button.calling')}</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleClick}
        disabled={isInHuddleWithThisPerson}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors ${
          isInHuddleWithThisPerson
            ? 'bg-green-100 text-green-700'
            : isInAnyHuddle || hasOutgoingInvite
              ? 'text-slack-secondary opacity-50 cursor-not-allowed'
              : 'text-slack-secondary hover:bg-slack-hover'
        }`}
        title={isInHuddleWithThisPerson ? t('button.inHuddle') : isInAnyHuddle ? t('button.leaveCurrentFirst') : t('button.start')}
        aria-label={isInHuddleWithThisPerson ? t('button.inHuddle') : isInAnyHuddle ? t('button.leaveCurrentFirst') : t('button.start')}
      >
        <Headphones className="h-4 w-4" />
      </button>
      {error && !huddleId && (
        <span data-testid="huddle-error" className="text-xs text-red-600">{error}</span>
      )}
    </div>
  );
}
