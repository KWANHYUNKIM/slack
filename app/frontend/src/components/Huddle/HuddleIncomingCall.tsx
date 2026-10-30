import { useEffect, useState } from 'react';
import { Phone, PhoneOff, Headphones } from 'lucide-react';
import { useHuddleStore } from '@/stores/useHuddleStore';
import { Avatar } from '@/components/ui/avatar';

export function HuddleIncomingCall() {
  const { incomingInvites, acceptInvite, declineInvite, huddleId } = useHuddleStore();

  // Don't show incoming calls if already in a huddle
  if (huddleId || incomingInvites.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-sm:left-4 max-sm:right-4">
      {incomingInvites.map((invite) => (
        <IncomingCallCard
          key={invite.inviteId}
          invite={invite}
          onAccept={() => acceptInvite(invite.inviteId)}
          onDecline={() => declineInvite(invite.inviteId)}
        />
      ))}
    </div>
  );
}

function IncomingCallCard({
  invite,
  onAccept,
  onDecline,
}: {
  invite: { inviteId: string; fromName: string; fromAvatar: string | null; expiresAt: string };
  onAccept: () => void;
  onDecline: () => void;
}) {
  const [remaining, setRemaining] = useState(60);

  useEffect(() => {
    const interval = setInterval(() => {
      const left = Math.max(0, Math.round((new Date(invite.expiresAt).getTime() - Date.now()) / 1000));
      setRemaining(left);
    }, 1000);
    return () => clearInterval(interval);
  }, [invite.expiresAt]);

  return (
    <div data-testid="huddle-incoming-call" className="bg-white rounded-xl shadow-xl border border-green-200 p-4 animate-in slide-in-from-top-2 fade-in duration-300 sm:w-80">
      <div className="flex items-center gap-3 mb-3">
        <div className="relative">
          <Avatar
            src={invite.fromAvatar ?? undefined}
            alt={invite.fromName}
            fallback={invite.fromName}
            size="md"
            className="ring-2 ring-green-400"
          />
          <div className="absolute -bottom-0.5 -right-0.5 bg-green-500 rounded-full p-0.5">
            <Headphones className="h-2.5 w-2.5 text-white" />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-gray-900 truncate">{invite.fromName}</div>
          <div className="text-xs text-green-600">Huddle invite</div>
        </div>
        {remaining > 0 && (
          <span className="text-xs text-gray-400 tabular-nums">{remaining}s</span>
        )}
      </div>

      <div className="flex gap-2">
        <button
          onClick={onDecline}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
        >
          <PhoneOff className="h-4 w-4" />
          Decline
        </button>
        <button
          onClick={onAccept}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-green-500 px-3 py-2 text-sm font-medium text-white hover:bg-green-600 transition-colors"
        >
          <Phone className="h-4 w-4" />
          Accept
        </button>
      </div>
    </div>
  );
}
