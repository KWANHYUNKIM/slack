import { useState, useEffect } from 'react';
import { Mic, MicOff, PhoneOff, Headphones } from 'lucide-react';
import { useHuddleStore } from '@/stores/useHuddleStore';
import { Avatar } from '@/components/ui/avatar';

export function HuddleBar() {
  const { huddleId, peer, isMuted, leaveHuddle, toggleMute, error } = useHuddleStore();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!huddleId) {
      setElapsed(0);
      return;
    }
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, [huddleId]);

  if (!huddleId || !peer) return null;

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-green-300 bg-green-50 px-4 py-2 sm:left-auto sm:right-4 sm:bottom-4 sm:rounded-xl sm:border sm:shadow-lg sm:w-72">
      {error && (
        <div className="text-xs text-red-600 mb-1">{error}</div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Avatar
            src={peer.avatar ?? undefined}
            alt={peer.name}
            fallback={peer.name}
            size="sm"
            className="ring-2 ring-green-300 flex-shrink-0"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium text-green-800 truncate">{peer.name}</div>
            <div className="flex items-center gap-1.5 text-xs text-green-600">
              <Headphones className="h-3 w-3" />
              <span>{timeStr}</span>
              {peer.isMuted && <span className="text-red-500">(muted)</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={toggleMute}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
              isMuted
                ? 'bg-red-100 text-red-600 hover:bg-red-200'
                : 'bg-green-200 text-green-700 hover:bg-green-300'
            }`}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </button>

          <button
            onClick={leaveHuddle}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors"
            title="Leave huddle"
          >
            <PhoneOff className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
