import { useState, useRef, useEffect } from 'react';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/apiErrors';

interface UseMessageEditOptions {
  onSave: (messageId: number, content: string) => Promise<void>;
}

/**
 * Shared edit state and handlers for message editing (used by Message and DMConversation).
 */
export function useMessageEdit({ onSave }: UseMessageEditOptions) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingId !== null && editInputRef.current) {
      editInputRef.current.focus();
      const length = editInputRef.current.value.length;
      editInputRef.current.setSelectionRange(length, length);
    }
  }, [editingId]);

  const startEdit = (messageId: number, content: string) => {
    setEditingId(messageId);
    setEditError(null);
    // Convert <@id|name> mention tokens to readable @name for editing
    setEditContent(content.replace(/<@\d+\|([^>]+)>/g, '@$1'));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent('');
    setEditError(null);
  };

  const saveEdit = async (originalContent?: string) => {
    if (editingId === null) return;
    const trimmed = editContent.trim();
    if (!trimmed) {
      setEditError(t('messages:errors.messageEmpty'));
      return;
    }
    if (trimmed !== originalContent) {
      try {
        await onSave(editingId, trimmed);
      } catch (err) {
        // 저장하지 못하면 편집 상태와 입력 내용을 그대로 두고 이유를 보여 준다(예: 데이터 유출 방지 규칙)
        setEditError(apiErrorMessage(err, 'messages:errors.editFailed'));
        return;
      }
    }
    setEditError(null);
    setEditingId(null);
  };

  const handleEditKeyDown = (e: React.KeyboardEvent, originalContent?: string) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit(originalContent);
    }
    if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  return {
    editingId,
    editContent,
    editError,
    setEditContent,
    editInputRef,
    startEdit,
    cancelEdit,
    saveEdit,
    handleEditKeyDown,
  };
}
