import { useState, useEffect, useCallback } from 'react';
import { Clock, Hash, Pencil, Send, Trash2, X } from 'lucide-react';
import { format } from 'date-fns';
import {
  getScheduledMessages,
  cancelScheduledMessage,
  editScheduledMessage,
  sendScheduledMessageNow,
  type ApiScheduledMessage,
} from '@/lib/api';
import { renderMessageContent } from '@/lib/renderMessageContent';
import { Button } from '@/components/ui/button';

export function ScheduledMessagesTab() {
  const [messages, setMessages] = useState<ApiScheduledMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editTime, setEditTime] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchMessages = useCallback(() => {
    setIsLoading(true);
    getScheduledMessages()
      .then((data) => {
        setMessages(data);
        setLoadError(null);
      })
      .catch(() => setLoadError('Failed to load scheduled messages.'))
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  const handleCancel = async (id: number) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setActionError(null);
    try {
      await cancelScheduledMessage(id);
    } catch {
      fetchMessages();
      setActionError('Failed to cancel message.');
    }
  };

  const handleSendNow = async (id: number) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    setActionError(null);
    try {
      await sendScheduledMessageNow(id);
    } catch {
      fetchMessages();
      setActionError('Failed to send message.');
    }
  };

  const openEdit = (msg: ApiScheduledMessage) => {
    setEditingId(msg.id);
    setEditContent(msg.content);
    // Format for datetime-local input
    const d = new Date(msg.scheduledAt);
    setEditTime(format(d, "yyyy-MM-dd'T'HH:mm"));
    setActionError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    setActionError(null);
    try {
      const data: { content?: string; scheduledAt?: string } = {};
      const original = messages.find((m) => m.id === editingId);
      if (original && editContent !== original.content) data.content = editContent;
      const newDate = new Date(editTime);
      if (original && newDate.toISOString() !== new Date(original.scheduledAt).toISOString()) {
        data.scheduledAt = newDate.toISOString();
      }
      if (!data.content && !data.scheduledAt) {
        setEditingId(null);
        return;
      }
      const updated = await editScheduledMessage(editingId, data);
      setMessages((prev) => prev.map((m) => (m.id === editingId ? updated : m)));
      setEditingId(null);
    } catch {
      setActionError('Failed to save changes.');
    }
  };

  if (isLoading) {
    return <div className="text-center text-sm text-slack-hint p-8">Loading...</div>;
  }

  if (loadError) {
    return <div className="text-center text-sm text-slack-error p-8">{loadError}</div>;
  }

  if (messages.length === 0) {
    return (
      <div className="text-center text-sm text-slack-hint py-8">
        No scheduled messages. Use the clock icon in the message composer to schedule one.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {actionError && (
        <div className="mx-4 mb-2 rounded bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">
          {actionError}
        </div>
      )}
      {messages.map((msg) => (
        <div
          key={msg.id}
          data-testid={`scheduled-msg-${msg.id}`}
          className="group rounded-lg p-3 hover:bg-slack-hover mx-1"
        >
          {editingId === msg.id ? (
            /* Edit mode */
            <div className="space-y-3">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full rounded border border-slack-border p-2 text-[15px] text-slack-primary min-h-[80px] resize-y"
              />
              <div className="flex items-center gap-2">
                <label className="text-[13px] text-slack-secondary">Send at:</label>
                <input
                  type="datetime-local"
                  value={editTime}
                  onChange={(e) => setEditTime(e.target.value)}
                  min={format(new Date(), "yyyy-MM-dd'T'HH:mm")}
                  className="rounded border border-slack-border px-2 py-1 text-[13px]"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleSaveEdit}
                  className="bg-slack-btn text-white hover:bg-slack-btn-hover text-sm px-3 py-1"
                >
                  Save
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setEditingId(null)}
                  className="text-sm px-3 py-1"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            /* View mode */
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-[15px] text-slack-primary leading-[22px] whitespace-pre-wrap break-words line-clamp-3">
                    {renderMessageContent(msg.content)}
                  </div>
                  <div className="flex items-center gap-3 mt-1.5 text-[12px] text-slack-hint">
                    <span className="flex items-center gap-1">
                      <Hash className="h-3 w-3" />
                      {msg.channel.name}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {format(new Date(msg.scheduledAt), 'MMM d, h:mm a')}
                    </span>
                  </div>
                </div>

                {/* Hover actions */}
                <div className="flex-shrink-0 flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => openEdit(msg)}
                    className="flex h-7 w-7 items-center justify-center rounded hover:bg-slack-border-light"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5 text-slack-secondary" />
                  </button>
                  <button
                    onClick={() => handleSendNow(msg.id)}
                    className="flex h-7 w-7 items-center justify-center rounded hover:bg-slack-border-light"
                    title="Send now"
                  >
                    <Send className="h-3.5 w-3.5 text-slack-secondary" />
                  </button>
                  <button
                    onClick={() => handleCancel(msg.id)}
                    className="flex h-7 w-7 items-center justify-center rounded hover:bg-slack-border-light"
                    title="Cancel"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-slack-error" />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
