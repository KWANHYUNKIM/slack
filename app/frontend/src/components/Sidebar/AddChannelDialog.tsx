import { useState } from 'react';
import { Hash, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { Channel } from '@/lib/types';
import { CHANNEL_NAME_MAX, channelNameErrorMessage, checkChannelName, normalizeChannelName } from '@/lib/channelName';

interface AddChannelDialogProps {
  open: boolean;
  onClose: () => void;
  onCreateChannel: (name: string, isPrivate?: boolean) => Promise<void>;
  browseChannels: Channel[];
  onJoinChannel: (channelId: number) => Promise<void>;
  onNavigateToChannel: (channelId: number) => void;
  onBrowse: () => void;
}

export function AddChannelDialog({
  open,
  onClose,
  onCreateChannel,
  browseChannels,
  onJoinChannel,
  onNavigateToChannel,
  onBrowse,
}: AddChannelDialogProps) {
  const { t } = useTranslation('channels');
  const [addChannelMode, setAddChannelMode] = useState<'create' | 'browse'>('create');
  const [newChannelName, setNewChannelName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [createChannelError, setCreateChannelError] = useState('');

  // Reset state when dialog opens
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setAddChannelMode('create');
      setNewChannelName('');
      setIsPrivate(false);
      setCreateChannelError('');
    }
  }

  if (!open) return null;

  // 정규화는 렌더마다 한 번만 한다(글자 수 표시와 제출이 같은 값을 쓴다)
  const normalizedName = normalizeChannelName(newChannelName);
  const nameLength = [...normalizedName].length;
  const nameErrorFor = (name: string) => {
    const reason = name.length > 0 ? checkChannelName(name) : null;
    return reason ? channelNameErrorMessage(t, reason) : '';
  };

  const handleClose = () => {
    setNewChannelName('');
    setCreateChannelError('');
    onClose();
  };

  const handleBrowse = () => {
    setAddChannelMode('browse');
    onBrowse();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[520px] rounded-lg bg-white shadow-xl">
        {/* Tabs */}
        <div className="flex border-b border-slack-border">
          <button
            onClick={() => setAddChannelMode('create')}
            className={cn(
              'flex-1 px-4 py-3 text-[14px] font-medium transition-colors',
              addChannelMode === 'create'
                ? 'border-b-2 border-slack-link text-slack-link'
                : 'text-slack-hint hover:text-slack-primary'
            )}
          >
            {t('dialog.tabCreate')}
          </button>
          <button
            onClick={handleBrowse}
            className={cn(
              'flex-1 px-4 py-3 text-[14px] font-medium transition-colors',
              addChannelMode === 'browse'
                ? 'border-b-2 border-slack-link text-slack-link'
                : 'text-slack-hint hover:text-slack-primary'
            )}
          >
            {t('dialog.tabBrowse')}
          </button>
        </div>

        <div className="p-6">
          {addChannelMode === 'create' ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!normalizedName) return;
                const nameError = nameErrorFor(normalizedName);
                if (nameError) {
                  setCreateChannelError(nameError);
                  return;
                }
                try {
                  await onCreateChannel(normalizedName, isPrivate);
                  setNewChannelName('');
                  setCreateChannelError('');
                } catch (err) {
                  setCreateChannelError(
                    err instanceof Error ? err.message : t('dialog.errors.createFailed')
                  );
                }
              }}
            >
              <label className="block text-[14px] font-medium text-slack-primary mb-1">
                {t('dialog.nameLabel')}
              </label>
              <input
                type="text"
                value={newChannelName}
                onChange={(e) => {
                  // 입력 중에는 NFKC를 적용하지 않는다(한글 조합 중 글자를 깨뜨릴 수 있음). 검증과 제출 때만 정규화한다.
                  const val = e.target.value.toLowerCase();
                  setNewChannelName(val);
                  setCreateChannelError(nameErrorFor(normalizeChannelName(val)));
                }}
                placeholder={t('dialog.namePlaceholder')}
                autoFocus
                className="w-full rounded border border-slack-input-border px-3 py-2 text-[15px] text-slack-primary outline-none focus:border-slack-link focus:ring-1 focus:ring-slack-link"
              />
              <div className="mt-1 flex items-center justify-between">
                {createChannelError ? (
                  <p data-testid="channel-error" className="text-[13px] text-slack-error">
                    {createChannelError}
                  </p>
                ) : <span />}
                <span className={cn(
                  'text-[12px]',
                  nameLength > CHANNEL_NAME_MAX ? 'text-slack-error' : 'text-slack-hint'
                )}>
                  {nameLength}/{CHANNEL_NAME_MAX}
                </span>
              </div>

              <div className="mt-3">
                <label className="block text-[14px] font-medium text-slack-primary mb-2">
                  {t('dialog.visibility')}
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setIsPrivate(false)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-3 py-2 text-[13px] transition-colors',
                      !isPrivate
                        ? 'border-slack-link bg-slack-highlight text-slack-link font-medium'
                        : 'border-slack-border text-slack-secondary hover:border-slack-link'
                    )}
                  >
                    <Hash className="h-3.5 w-3.5" />
                    {t('dialog.public')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPrivate(true)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-3 py-2 text-[13px] transition-colors',
                      isPrivate
                        ? 'border-slack-link bg-slack-highlight text-slack-link font-medium'
                        : 'border-slack-border text-slack-secondary hover:border-slack-link'
                    )}
                  >
                    <Lock className="h-3.5 w-3.5" />
                    {t('dialog.private')}
                  </button>
                </div>
                <p className="mt-1 text-[12px] text-slack-hint">
                  {isPrivate
                    ? t('dialog.privateHint')
                    : t('dialog.publicHint')}
                </p>
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" type="button" onClick={handleClose}>
                  {t('dialog.cancel')}
                </Button>
                <Button type="submit" disabled={!newChannelName.trim() || !!createChannelError}>
                  {t('dialog.create')}
                </Button>
              </div>
            </form>
          ) : (
            <div>
              {browseChannels.length === 0 ? (
                <p className="text-center text-slack-hint py-8">{t('dialog.noChannels')}</p>
              ) : (
                <div className="max-h-[300px] overflow-y-auto space-y-1">
                  {browseChannels.map((ch) => (
                    <div
                      key={ch.id}
                      data-channel-name={ch.name}
                      className="flex items-center justify-between rounded px-3 py-2 hover:bg-slack-hover cursor-pointer"
                      onClick={() => {
                        onNavigateToChannel(ch.id);
                        handleClose();
                      }}
                    >
                      <div className="flex items-center gap-2">
                        {ch.isPrivate ? <Lock className="h-3.5 w-3.5 text-slack-disabled" /> : <Hash className="h-3.5 w-3.5 text-slack-disabled" />}
                        <span className="text-[15px] text-slack-primary">{ch.name}</span>
                        <span className="text-[12px] text-slack-hint">{t('dialog.memberCount', { count: ch.memberCount })}</span>
                      </div>
                      {ch.isMember ? (
                        <span data-testid="joined-badge" className="text-[12px] text-slack-hint font-medium px-2 py-1">{t('dialog.joined')}</span>
                      ) : (
                        <Button size="sm" onClick={() => { onJoinChannel(ch.id).then(() => { onNavigateToChannel(ch.id); handleClose(); }); }}>
                          {t('dialog.join')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 flex justify-end">
                <Button variant="ghost" onClick={handleClose}>
                  {t('dialog.close')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
