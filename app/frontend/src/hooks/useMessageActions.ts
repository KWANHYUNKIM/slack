import { useCallback } from 'react';
import { pinMessage, unpinMessage } from '@/lib/api';
import { useMessageStore } from '@/stores/useMessageStore';

export function useMessageActions() {
  const togglePin = useCallback(async (messageId: number, isPinned: boolean) => {
    try {
      if (isPinned) {
        await unpinMessage(messageId);
      } else {
        await pinMessage(messageId);
      }
      const { messages } = useMessageStore.getState();
      useMessageStore.setState({
        messages: messages.map((m) =>
          m.id === messageId ? { ...m, isPinned: !isPinned } : m
        ),
      });
    } catch (err) {
      console.error('Failed to pin/unpin:', err);
      throw err;
    }
  }, []);

  return { togglePin };
}
