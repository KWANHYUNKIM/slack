import { create } from 'zustand';
import { useMessageStore } from '@/stores/useMessageStore';
import { countUnreadFrom, previousTimelineId } from '@/lib/unread';

/**
 * 안 읽음 구분선의 기준점. 채널을 열 때 서버에서 한 번 받아 고정하고, 채널을 떠나면 버린다.
 * 열자마자 /read가 커서를 옮겨도 이 값은 그대로라서 읽은 뒤에도 구분선 위치를 잃지 않는다.
 */
interface UnreadState {
  channelId: number | null;
  /** 기준점을 받았다. false면 구분선을 그리지 않고 읽음 처리도 미룬다 */
  ready: boolean;
  /** 이 메시지까지 읽었다. null이면 처음부터 안 읽음 */
  lastReadId: number | null;
  /** 열 때 서버가 센 안 읽음 수(내 메시지 포함) */
  total: number;
  /** "읽지 않음으로 표시"한 메시지. 내 메시지여도 그 앞에 선을 긋는다 */
  pinnedBeforeId: number | null;
  begin: (channelId: number) => void;
  setBaseline: (channelId: number, lastReadId: number | null, total: number) => void;
  /** 기준점을 알 수 없어도(실패, 비멤버) 읽음 처리가 막히지 않게 구분선 없이 준비 완료로 만든다 */
  setUnknown: (channelId: number) => void;
  markUnreadFrom: (channelId: number, messageId: number) => void;
  /** 이 id까지 읽은 것으로 보고 구분선을 지운다 */
  markReadUpTo: (channelId: number, messageId: number) => void;
  reset: () => void;
}

const EMPTY = { channelId: null, ready: false, lastReadId: null, total: 0, pinnedBeforeId: null };

export const useUnreadStore = create<UnreadState>((set, get) => ({
  ...EMPTY,
  begin: (channelId) => set({ ...EMPTY, channelId }),
  setBaseline: (channelId, lastReadId, total) => {
    if (get().channelId !== channelId) return; // 응답이 오기 전에 다른 채널로 옮겼다
    set({ ready: true, lastReadId, total, pinnedBeforeId: null });
  },
  setUnknown: (channelId) => {
    if (get().channelId !== channelId) return;
    set({ ready: true, lastReadId: Number.MAX_SAFE_INTEGER, total: 0, pinnedBeforeId: null });
  },
  markUnreadFrom: (channelId, messageId) => {
    if (get().channelId !== channelId) return;
    const messages = useMessageStore.getState().messages.filter((m) => m.channelId === channelId);
    const total = countUnreadFrom(messages, messageId);
    set({ ready: true, lastReadId: previousTimelineId(messages, messageId), total, pinnedBeforeId: messageId });
  },
  markReadUpTo: (channelId, messageId) => {
    if (get().channelId !== channelId) return;
    set({ lastReadId: messageId, total: 0, pinnedBeforeId: null });
  },
  reset: () => set({ ...EMPTY }),
}));
