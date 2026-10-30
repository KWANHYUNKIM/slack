import { Headphones, PhoneOff } from 'lucide-react';
import { useHuddleStore } from '@/stores/useHuddleStore';

interface HuddleButtonProps {
  userId: number;
}

export function HuddleButton({ userId }: HuddleButtonProps) {
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
      useHuddleStore.setState({ error: isInAnyHuddle ? 'Leave your current huddle first' : 'Cancel your current invite first' });
      return;
    }
    sendInvite(userId);
  };

  if (isCallingThisPerson) {
    return (
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors bg-yellow-100 text-yellow-700 hover:bg-yellow-200"
        title="Cancel invite"
      >
        <PhoneOff className="h-4 w-4" />
        <span className="text-xs font-medium">Calling...</span>
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
        title={isInHuddleWithThisPerson ? 'In huddle' : isInAnyHuddle ? 'Leave current huddle first' : 'Start huddle'}
      >
        <Headphones className="h-4 w-4" />
      </button>
      {error && !huddleId && (
        <span data-testid="huddle-error" className="text-xs text-red-600">{error}</span>
      )}
    </div>
  );
}
