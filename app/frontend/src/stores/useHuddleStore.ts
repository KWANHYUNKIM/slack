import { create } from 'zustand';
import { getSocket } from '@/lib/socket';

export interface IncomingInvite {
  inviteId: string;
  fromUserId: number;
  fromName: string;
  fromAvatar: string | null;
  expiresAt: string;
}

interface PeerInfo {
  userId: number;
  name: string;
  avatar: string | null;
  isMuted: boolean;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

interface HuddleState {
  userId: number | null;

  // Invite state
  outgoingInvite: { inviteId: string; toUserId: number } | null;
  incomingInvites: IncomingInvite[];

  // Active huddle state
  huddleId: string | null;
  peer: PeerInfo | null;
  isMuted: boolean;
  isConnecting: boolean;
  localStream: MediaStream | null;
  peerConnection: RTCPeerConnection | null;
  audioElement: HTMLAudioElement | null;
  error: string | null;

  // Actions
  sendInvite: (toUserId: number) => Promise<void>;
  cancelInvite: () => void;
  acceptInvite: (inviteId: string) => Promise<void>;
  declineInvite: (inviteId: string) => void;
  leaveHuddle: () => void;
  toggleMute: () => void;

  // Socket event handlers
  onInviteSent: (data: { inviteId: string; toUserId: number }) => void;
  onInviteReceived: (data: IncomingInvite) => void;
  onInviteCancelled: (data: { inviteId: string; reason: string }) => void;
  onHuddleConnected: (data: { huddleId: string; isInitiator: boolean; peer: PeerInfo }) => void;
  onSignal: (data: { huddleId: string; fromUserId: number; signal: { type: string; sdp?: string; candidate?: unknown } }) => void;
  onMuteChanged: (data: { huddleId: string; userId: number; isMuted: boolean }) => void;
  onHuddleEnded: (data: { huddleId: string }) => void;
  cleanup: () => void;
}

export const useHuddleStore = create<HuddleState>((set, get) => ({
  userId: null,
  outgoingInvite: null,
  incomingInvites: [],
  huddleId: null,
  peer: null,
  isMuted: false,
  isConnecting: false,
  localStream: null,
  peerConnection: null,
  audioElement: null,
  error: null,

  sendInvite: async (toUserId: number) => {
    const state = get();
    if (state.huddleId) {
      set({ error: 'Leave your current huddle first' });
      return;
    }
    if (state.outgoingInvite) {
      set({ error: 'Cancel your current invite first' });
      return;
    }

    set({ error: null });

    // Acquire mic early so failure is surfaced before invite is sent
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      set({ localStream: stream });
    } catch {
      set({ error: 'Microphone access denied' });
      return;
    }

    const socket = getSocket();
    if (socket) {
      socket.emit('huddle:invite', { toUserId });
    }
  },

  cancelInvite: () => {
    const { outgoingInvite, localStream } = get();
    if (!outgoingInvite) return;

    const socket = getSocket();
    if (socket) {
      socket.emit('huddle:invite:cancel', { inviteId: outgoingInvite.inviteId });
    }

    // Stop mic since we acquired it at invite time
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }

    set({ outgoingInvite: null, localStream: null });
  },

  acceptInvite: async (inviteId: string) => {
    const state = get();
    if (state.huddleId) {
      set({ error: 'Leave your current huddle first' });
      return;
    }

    set({ isConnecting: true, error: null });

    // Acquire mic
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      set({ localStream: stream });
    } catch {
      set({ isConnecting: false, error: 'Microphone access denied' });
      return;
    }

    const socket = getSocket();
    if (socket) {
      socket.emit('huddle:invite:accept', { inviteId });
    }

    // Remove from incoming invites
    set((s) => ({
      incomingInvites: s.incomingInvites.filter((inv) => inv.inviteId !== inviteId),
    }));
  },

  declineInvite: (inviteId: string) => {
    const socket = getSocket();
    if (socket) {
      socket.emit('huddle:invite:decline', { inviteId });
    }
    set((s) => ({
      incomingInvites: s.incomingInvites.filter((inv) => inv.inviteId !== inviteId),
    }));
  },

  leaveHuddle: () => {
    const { huddleId } = get();
    if (!huddleId) return;

    const socket = getSocket();
    if (socket) {
      socket.emit('huddle:leave', { huddleId });
    }

    get().cleanup();
  },

  toggleMute: () => {
    const { isMuted, localStream, huddleId } = get();
    if (!localStream || !huddleId) return;

    const newMuted = !isMuted;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = !newMuted;
    });

    set({ isMuted: newMuted });

    const socket = getSocket();
    if (socket) {
      socket.emit('huddle:mute', { huddleId, isMuted: newMuted });
    }
  },

  // ── Socket event handlers ──

  onInviteSent: (data) => {
    set({ outgoingInvite: { inviteId: data.inviteId, toUserId: data.toUserId } });
  },

  onInviteReceived: (data) => {
    set((s) => ({
      incomingInvites: [...s.incomingInvites.filter((inv) => inv.inviteId !== data.inviteId), data],
    }));
  },

  onInviteCancelled: (data) => {
    const { outgoingInvite, localStream } = get();

    // If it was our outgoing invite that got cancelled
    if (outgoingInvite && (outgoingInvite.inviteId === data.inviteId || data.inviteId === 'none')) {
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
      set({ outgoingInvite: null, localStream: null });

      let errorMsg: string | null = null;
      if (data.reason === 'busy') errorMsg = 'They are in another huddle';
      else if (data.reason === 'declined') errorMsg = 'Invite was declined';
      else if (data.reason === 'timeout') errorMsg = 'Invite expired';

      if (errorMsg) {
        set({ error: errorMsg });
        setTimeout(() => {
          if (useHuddleStore.getState().error === errorMsg) {
            useHuddleStore.setState({ error: null });
          }
        }, 5000);
      }
      return;
    }

    // Remove from incoming invites
    set((s) => ({
      incomingInvites: s.incomingInvites.filter((inv) => inv.inviteId !== data.inviteId),
    }));
  },

  onHuddleConnected: (data) => {
    const state = get();

    // If we had an outgoing invite, clear it (we're now connected)
    set({
      huddleId: data.huddleId,
      peer: data.peer,
      outgoingInvite: null,
      isConnecting: false,
      isMuted: false,
      error: null,
    });

    // Get mic — the inviter should already have it from sendInvite, accepter from acceptInvite
    const { localStream } = get();
    if (!localStream) {
      // Shouldn't happen but handle gracefully
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
          useHuddleStore.setState({ localStream: stream });
          if (data.isInitiator) {
            setupPeerConnection(data.huddleId, data.peer.userId, true);
          }
        })
        .catch(() => {
          // Mic failed — must leave
          const socket = getSocket();
          if (socket) socket.emit('huddle:leave', { huddleId: data.huddleId });
          get().cleanup();
          set({ error: 'Microphone access denied' });
        });
      return;
    }

    if (data.isInitiator) {
      setupPeerConnection(data.huddleId, data.peer.userId, true);
    }
    // Non-initiator waits for the offer signal
  },

  onSignal: (data) => {
    const state = get();
    if (data.huddleId !== state.huddleId) return;

    const { signal } = data;

    if (signal.type === 'offer') {
      // We're the non-initiator, set up peer connection and answer
      const pc = setupPeerConnection(data.huddleId, data.fromUserId, false);
      if (!pc) return;

      const sdpDesc = new RTCSessionDescription({ type: 'offer', sdp: signal.sdp! });
      pc.setRemoteDescription(sdpDesc)
        .then(() => pc.createAnswer())
        .then((answer) => pc.setLocalDescription(answer))
        .then(() => {
          const socket = getSocket();
          if (socket && pc.localDescription) {
            socket.emit('huddle:signal', {
              huddleId: data.huddleId,
              signal: { type: 'answer', sdp: pc.localDescription.sdp },
            });
          }
        })
        .catch((err) => console.error('Huddle answer error:', err));
    } else if (signal.type === 'answer') {
      const { peerConnection } = get();
      if (peerConnection) {
        const sdpDesc = new RTCSessionDescription({ type: 'answer', sdp: signal.sdp! });
        peerConnection.setRemoteDescription(sdpDesc)
          .catch((err) => console.error('Huddle set answer error:', err));
      }
    } else if (signal.type === 'ice-candidate') {
      const { peerConnection } = get();
      if (peerConnection && signal.candidate) {
        peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate as RTCIceCandidateInit))
          .catch((err) => console.error('Huddle ICE error:', err));
      }
    }
  },

  onMuteChanged: (data) => {
    const state = get();
    if (data.huddleId !== state.huddleId) return;

    // Update peer's mute state
    if (state.peer && data.userId === state.peer.userId) {
      set({ peer: { ...state.peer, isMuted: data.isMuted } });
    }
    // Update own mute state if echoed back
    if (data.userId === state.userId) {
      set({ isMuted: data.isMuted });
    }
  },

  onHuddleEnded: (data) => {
    const { huddleId } = get();
    if (data.huddleId === huddleId) {
      get().cleanup();
    }
  },

  cleanup: () => {
    const { peerConnection, audioElement, localStream } = get();

    if (peerConnection) {
      peerConnection.close();
    }
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }

    set({
      huddleId: null,
      peer: null,
      isMuted: false,
      isConnecting: false,
      localStream: null,
      peerConnection: null,
      audioElement: null,
      outgoingInvite: null,
      error: null,
    });
  },
}));

// ── WebRTC Peer Connection Setup ─────────────────────────────────────

function setupPeerConnection(huddleId: string, remoteUserId: number, isInitiator: boolean): RTCPeerConnection | null {
  const state = useHuddleStore.getState();
  const { localStream } = state;
  if (!localStream) return null;

  // Close existing peer connection if any
  if (state.peerConnection) {
    state.peerConnection.close();
  }

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Add audio tracks
  localStream.getAudioTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const socket = getSocket();
      if (socket) {
        socket.emit('huddle:signal', {
          huddleId,
          signal: { type: 'ice-candidate' as const, candidate: event.candidate.toJSON() },
        });
      }
    }
  };

  pc.ontrack = (event) => {
    const stream = event.streams[0];
    const audio = document.createElement('audio');
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.play().catch(() => {});
    useHuddleStore.setState({ audioElement: audio });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      console.warn('Huddle peer connection state:', pc.connectionState);
    }
  };

  useHuddleStore.setState({ peerConnection: pc });

  if (isInitiator) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        const socket = getSocket();
        if (socket && pc.localDescription) {
          socket.emit('huddle:signal', {
            huddleId,
            signal: { type: 'offer' as const, sdp: pc.localDescription.sdp },
          });
        }
      })
      .catch((err) => console.error('Huddle offer error:', err));
  }

  return pc;
}

export function setHuddleUserId(userId: number): void {
  useHuddleStore.setState({ userId });
}
