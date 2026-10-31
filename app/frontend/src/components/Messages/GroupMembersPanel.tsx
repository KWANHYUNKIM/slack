import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Users, UserPlus, LogOut, Pencil } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { AddTeammatesDialog } from '@/components/Sidebar/AddTeammatesDialog';
import { useAuthStore } from '@/stores/useAuthStore';
import { useChannelStore } from '@/stores/useChannelStore';
import { useDMStore, groupConversationKey } from '@/stores/useDMStore';
import { useProfileStore } from '@/stores/useProfileStore';
import { addDMGroupMembers, leaveDMGroup, renameDMGroup, type AuthUser } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { MAX_GROUP_SIZE } from '@/lib/groupDM';
import type { GroupDM } from '@/lib/types';
import { PanelHeader } from './PanelHeader';
const NAME_MAX = 100;

interface GroupMembersPanelProps {
  group: GroupDM;
  onClose: () => void;
}

/** 그룹 DM 멤버 패널: 멤버 목록, 사람 추가, 이름 바꾸기, 나가기 */
export function GroupMembersPanel({ group, onClose }: GroupMembersPanelProps) {
  const { t } = useTranslation('channels');
  const navigate = useNavigate();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const openProfile = useProfileStore((s) => s.openProfile);
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(group.name ?? '');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memberIds = group.members.map((m) => m.id);

  const handleAdd = async (users: AuthUser[]) => {
    try {
      setAddError(null);
      const { group: updated } = await addDMGroupMembers(group.id, users.map((u) => u.id));
      useChannelStore.getState().upsertGroupDM(updated);
      setShowAdd(false);
    } catch (err) {
      setAddError(apiErrorMessage(err, 'channels:groupDM.addError'));
    }
  };

  const handleRename = async () => {
    try {
      setError(null);
      const trimmed = nameDraft.trim();
      await renameDMGroup(group.id, trimmed || null);
      useChannelStore.getState().renameGroupDM(group.id, trimmed || null);
      setIsRenaming(false);
    } catch (err) {
      setError(apiErrorMessage(err, 'channels:groupDM.renameError'));
    }
  };

  const handleLeave = async () => {
    try {
      setError(null);
      await leaveDMGroup(group.id);
      useChannelStore.getState().removeGroupDM(group.id);
      useDMStore.getState().clearConversation(groupConversationKey(group.id));
      navigate('/');
    } catch (err) {
      setError(apiErrorMessage(err, 'channels:groupDM.leaveError'));
    }
  };

  return (
    <div
      data-testid="group-members-panel"
      className="flex w-full md:w-[300px] flex-col border-s border-slack-border bg-white absolute inset-0 md:static md:inset-auto z-30 md:z-auto"
    >
      <PanelHeader icon={Users} title={t('groupDM.members', { count: group.members.length })} onClose={onClose} />
      <div className="flex-1 overflow-y-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {/* 이름 */}
        <div className="mb-3 rounded border border-slack-border p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[13px] font-bold text-slack-primary">{t('groupDM.nameLabel')}</span>
            {!isRenaming && (
              <Button
                variant="toolbar"
                size="icon-xs"
                data-testid="group-rename-button"
                aria-label={t('groupDM.rename')}
                title={t('groupDM.rename')}
                onClick={() => { setNameDraft(group.name ?? ''); setIsRenaming(true); }}
              >
                <Pencil className="h-3.5 w-3.5 text-slack-secondary" />
              </Button>
            )}
          </div>
          {isRenaming ? (
            <div>
              <input
                data-testid="group-name-input"
                value={nameDraft}
                maxLength={NAME_MAX}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleRename();
                  if (e.key === 'Escape') setIsRenaming(false);
                }}
                placeholder={t('groupDM.namePlaceholder')}
                autoFocus
                className="w-full rounded border border-slack-input-border px-2 py-1 text-[14px] text-slack-primary outline-none focus:border-slack-link"
              />
              <div className="mt-2 flex justify-end gap-2 text-[12px]">
                <button onClick={() => setIsRenaming(false)} className="text-slack-secondary hover:underline">
                  {t('common:actions.cancel')}
                </button>
                <button
                  data-testid="group-name-save"
                  onClick={() => void handleRename()}
                  className="rounded bg-slack-btn px-3 py-1 text-white hover:bg-slack-btn-hover"
                >
                  {t('common:actions.save')}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[14px] text-slack-primary">{group.name ?? <span className="text-slack-hint">{t('groupDM.noName')}</span>}</p>
          )}
        </div>

        {/* 멤버 */}
        {group.members.length < MAX_GROUP_SIZE && (
          <button
            data-testid="group-add-people"
            onClick={() => { setAddError(null); setShowAdd(true); }}
            className="mb-2 flex w-full items-center gap-2 rounded px-2 py-1.5 text-[14px] text-slack-link hover:bg-slack-hover"
          >
            <UserPlus className="h-4 w-4" />
            {t('groupDM.addPeople')}
          </button>
        )}
        <ul>
          {group.members.map((m) => (
            <li key={m.id}>
              <button
                onClick={() => openProfile(m.id)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start hover:bg-slack-hover"
              >
                <Avatar src={m.avatar ?? undefined} alt={m.name} fallback={m.name} size="sm" status={m.status} />
                <span className="truncate text-[14px] text-slack-primary">
                  {m.name}{m.id === currentUserId && <span className="text-slack-hint"> {t('dm.you')}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {error && <p className="mt-2 text-[13px] text-slack-error">{error}</p>}

        {/* 나가기 */}
        <div className="mt-4 border-t border-slack-border-light pt-3">
          {confirmLeave ? (
            <div className="text-[13px]">
              <p className="mb-2 text-slack-primary">{t('groupDM.leaveConfirm')}</p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setConfirmLeave(false)} className="text-slack-secondary hover:underline">
                  {t('common:actions.cancel')}
                </button>
                <button
                  data-testid="group-leave-confirm"
                  onClick={() => void handleLeave()}
                  className="rounded bg-red-600 px-3 py-1 text-white hover:bg-red-700"
                >
                  {t('groupDM.leave')}
                </button>
              </div>
            </div>
          ) : (
            <button
              data-testid="group-leave"
              onClick={() => setConfirmLeave(true)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[14px] text-red-600 hover:bg-slack-hover"
            >
              <LogOut className="h-4 w-4" />
              {t('groupDM.leave')}
            </button>
          )}
        </div>
      </div>

      <AddTeammatesDialog
        open={showAdd}
        mode="pick"
        onClose={() => setShowAdd(false)}
        onConfirm={handleAdd}
        excludeIds={memberIds}
        maxSelected={MAX_GROUP_SIZE - group.members.length}
        title={t('groupDM.addPeople')}
        confirmLabel={t('groupDM.add')}
        error={addError}
      />
    </div>
  );
}
