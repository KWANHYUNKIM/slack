import { create } from 'zustand';
import { getSocket } from '@/lib/socket';
import { getHuddleConfig } from '@/lib/api';

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

// ICE servers come from our own backend (/huddles/config: built-in STUN + optional TURN),
// never from external hosts. Cached with a TTL; on failure we return an empty list (same-LAN
// peers still connect through host candidates) and back off briefly before retrying.
const ICE_CACHE_TTL_MS = 10 * 60 * 1000;
const ICE_FAILURE_BACKOFF_MS = 30 * 1000;
let iceServersCache: { servers: RTCIceServer[]; expiresAt: number } | null = null;
let iceRetryAfter = 0;
let iceInflight: Promise<RTCIceServer[]> | null = null;

async function loadIceServers(): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (iceServersCache && now < iceServersCache.expiresAt) return iceServersCache.servers;
  if (now < iceRetryAfter) return [];
  if (!localStorage.getItem('token')) return [];
  if (!iceInflight) {
    iceInflight = getHuddleConfig()
      .then((data) => {
        if (!Array.isArray(data.iceServers)) throw new Error('invalid huddle config');
        iceServersCache = { servers: data.iceServers, expiresAt: Date.now() + ICE_CACHE_TTL_MS };
        return data.iceServers;
      })
      .catch(() => {
        iceRetryAfter = Date.now() + ICE_FAILURE_BACKOFF_MS;
        return [] as RTCIceServer[];
      })
      .finally(() => { iceInflight = null; });
  }
  return iceInflight;
}

// ICE candidates that arrive before the peer connection has its remote description are
// queued and applied right after it is set.
let pendingCandidates: RTCIceCandidateInit[] = [];

function flushPendingCandidates(pc: RTCPeerConnection): void {
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const c of queued) {
    pc.addIceCandidate(new RTCIceCandidate(c)).catch((err) => console.error('Huddle ICE error:', err));
  }
}

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
    void loadIceServers(); // warm the cache before the call connects

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
    void loadIceServers(); // warm the cache before the call connects

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
    pendingCandidates = [];
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
            setupPeerConnection(data.huddleId, true);
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
      setupPeerConnection(data.huddleId, true);
    }
    // Non-initiator waits for the offer signal
  },

  onSignal: (data) => {
    const state = get();
    if (data.huddleId !== state.huddleId) return;

    const { signal } = data;

    if (signal.type === 'offer') {
      // We're the non-initiator, set up peer connection and answer
      const sdpDesc = new RTCSessionDescription({ type: 'offer', sdp: signal.sdp! });
      setupPeerConnection(data.huddleId, false)
        .then(async (pc) => {
          if (!pc) return;
          await pc.setRemoteDescription(sdpDesc);
          flushPendingCandidates(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          // The huddle may have ended while we were negotiating
          if (useHuddleStore.getState().peerConnection !== pc) return;
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
          .then(() => flushPendingCandidates(peerConnection))
          .catch((err) => console.error('Huddle set answer error:', err));
      }
    } else if (signal.type === 'ice-candidate') {
      const { peerConnection } = get();
      if (!signal.candidate) return;
      if (peerConnection && peerConnection.remoteDescription) {
        peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate as RTCIceCandidateInit))
          .catch((err) => console.error('Huddle ICE error:', err));
      } else if (pendingCandidates.length < 100) {
        pendingCandidates.push(signal.candidate as RTCIceCandidateInit);
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
    pendingCandidates = [];
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

async function setupPeerConnection(huddleId: string, isInitiator: boolean): Promise<RTCPeerConnection | null> {
  const iceServers = await loadIceServers();
  // The huddle may have ended or changed while we waited for the ICE config: discard in that case
  const state = useHuddleStore.getState();
  if (state.huddleId !== huddleId) return null;
  const { localStream } = state;
  if (!localStream) return null;

  // Close existing peer connection if any
  if (state.peerConnection) {
    state.peerConnection.close();
  }

  const pc = new RTCPeerConnection({ iceServers });

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
        if (useHuddleStore.getState().peerConnection !== pc) return;
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
