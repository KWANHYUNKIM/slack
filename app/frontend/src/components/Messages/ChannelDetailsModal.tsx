import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getChannel } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { useChannelStore } from '@/stores/useChannelStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { Button } from '@/components/ui/button';
import {
  CHANNEL_NAME_ADMIN_MAX,
  CHANNEL_NAME_MAX,
  channelNameErrorMessage,
  checkChannelName,
  normalizeChannelName,
} from '@/lib/channelName';
import type { Channel } from '@/lib/types';

const TOPIC_MAX = 250;
const DESCRIPTION_MAX = 500;

interface ChannelDetailsModalProps {
  channel: Channel;
  onClose: () => void;
}

// 채널 이름·토픽·설명 편집. 권한이 없으면 읽기 전용으로 보여 준다.
export function ChannelDetailsModal({ channel, onClose }: ChannelDetailsModalProps) {
  const { t } = useTranslation('messages');
  const { t: tChannels } = useTranslation('channels');
  const updateChannelMeta = useChannelStore((s) => s.updateChannelMeta);
  const user = useAuthStore((s) => s.user);
  const isWorkspaceAdmin = user?.role === 'ADMIN' || user?.role === 'OWNER';

  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [description, setDescription] = useState(channel.description ?? '');
  const [memberRole, setMemberRole] = useState<'OWNER' | 'MODERATOR' | 'MEMBER' | null>(null);
  const [createdByName, setCreatedByName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 내 채널 역할과 만든 사람을 서버에서 확인한다
  useEffect(() => {
    let cancelled = false;
    getChannel(channel.id)
      .then((detail) => {
        if (cancelled) return;
        const mine = detail.members.find((m) => m.userId === user?.id);
        setMemberRole(mine?.role ?? null);
        const creator = detail.members.find((m) => m.userId === detail.createdBy);
        setCreatedByName(creator?.user.name ?? null);
      })
      .catch(() => { /* 읽기 전용으로 남는다 */ });
    return () => {
      cancelled = true;
    };
  }, [channel.id, user?.id]);

  const canEdit = isWorkspaceAdmin || memberRole === 'OWNER' || memberRole === 'MODERATOR';
  const nameMax = isWorkspaceAdmin ? CHANNEL_NAME_ADMIN_MAX : CHANNEL_NAME_MAX;
  // 이름을 바꾸지 않았으면 이름 검사로 저장을 막지 않는다(길이·대문자 규칙이 달랐던 옛 이름 보호)
  const nameChanged = name !== channel.name;
  const nameReason = !nameChanged ? null : name.trim().length > 0 ? checkChannelName(name, nameMax) : 'required';
  const nameError = nameReason ? channelNameErrorMessage(tChannels, nameReason, nameMax) : '';

  const handleSave = async () => {
    if (!canEdit || nameReason) return;
    setSaving(true);
    setError('');
    try {
      await updateChannelMeta(channel.id, {
        ...(nameChanged ? { name: normalizeChannelName(name) } : {}),
        topic: topic.trim() || null,
        description: description.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(apiErrorMessage(err, 'messages:details.saveFailed', nameMax));
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    'w-full rounded border border-slack-input-border px-3 py-2 text-[15px] text-slack-primary outline-none focus:border-slack-link focus:ring-1 focus:ring-slack-link read-only:bg-slack-hover';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="channel-details-modal">
      <div role="dialog" aria-label={t('details.title')} className="w-[520px] max-w-[95vw] rounded-lg bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-[22px] font-bold text-slack-primary">{t('details.title')}</h2>

        <label className="mb-1 block text-[14px] font-bold text-slack-primary" htmlFor="channel-details-name">
          {t('details.name')}
        </label>
        <input
          id="channel-details-name"
          data-testid="channel-details-name"
          value={name}
          readOnly={!canEdit}
          onChange={(e) => setName(e.target.value)}
          className={fieldClass}
        />
        {canEdit && nameError && <p className="mt-1 text-[13px] text-slack-error">{nameError}</p>}

        <label className="mb-1 mt-4 block text-[14px] font-bold text-slack-primary" htmlFor="channel-details-topic">
          {t('details.topic')}
        </label>
        <input
          id="channel-details-topic"
          data-testid="channel-details-topic"
          value={topic}
          readOnly={!canEdit}
          maxLength={TOPIC_MAX}
          placeholder={canEdit ? t('details.topicPlaceholder') : undefined}
          onChange={(e) => setTopic(e.target.value)}
          className={fieldClass}
        />

        <label className="mb-1 mt-4 block text-[14px] font-bold text-slack-primary" htmlFor="channel-details-description">
          {t('details.description')}
        </label>
        <textarea
          id="channel-details-description"
          data-testid="channel-details-description"
          value={description}
          readOnly={!canEdit}
          maxLength={DESCRIPTION_MAX}
          rows={3}
          placeholder={canEdit ? t('details.descriptionPlaceholder') : undefined}
          onChange={(e) => setDescription(e.target.value)}
          className={fieldClass}
        />

        {createdByName && (
          <p className="mt-3 text-[13px] text-slack-hint">{t('details.createdBy', { name: createdByName })}</p>
        )}
        {!canEdit && <p className="mt-3 text-[13px] text-slack-hint">{t('details.readOnly')}</p>}
        {error && <p role="alert" className="mt-3 text-[13px] text-slack-error">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('details.cancel')}
          </Button>
          {canEdit && (
            <Button
              data-testid="channel-details-save"
              onClick={handleSave}
              disabled={saving || !!nameReason}
            >
              {t('details.save')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
