import { create } from 'zustand';
import type { PermalinkKind } from '@/lib/permalink';

/** 퍼말링크로 열어야 하는 스레드. usePermalinkSync가 놓고, 해당 대화 화면이 한 번 쓰고 비운다. */
export interface PendingThread {
  kind: PermalinkKind;
  conversationId: number;
  parentId: number;
  replyId?: number;
}

interface PermalinkState {
  pendingThread: PendingThread | null;
  setPendingThread: (p: PendingThread | null) => void;
}

export const usePermalinkStore = create<PermalinkState>((set) => ({
  pendingThread: null,
  setPendingThread: (pendingThread) => set({ pendingThread }),
}));
