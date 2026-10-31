import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { getCollator } from '@/lib/i18n/format';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  Bookmark,
  ChevronDown,
  ChevronRight,
  Plus,
  SquarePen,
  Bell,
  BellOff,
  LogOut,
  Star,
  User,
  Shield,
  Inbox,
  MessagesSquare,
  Search,
  KeyRound,
  Laptop,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useChannelStore } from '@/stores/useChannelStore';
import { useActivityStore } from '@/stores/useActivityStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useAuthStore } from '@/stores/useAuthStore';
import { useProfileStore } from '@/stores/useProfileStore';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { Avatar } from '@/components/ui/avatar';
import { UserMenuStatus } from '@/components/Profile/UserMenuStatus';
import { DesktopServerMenuItem } from '@/components/Sidebar/DesktopServerMenuItem';
import { DesktopNotificationMenuItem } from '@/components/Sidebar/DesktopNotificationMenuItem';
import { getDesktop } from '@/lib/desktop';
import { StatusDialog } from '@/components/Profile/StatusDialog';
import { AccessTokensDialog } from '@/components/Profile/AccessTokensDialog';
import { SessionsDialog } from '@/components/Profile/SessionsDialog';
import { TwoFactorDialog } from '@/components/Profile/TwoFactorDialog';
import { useCustomStatus, useIsDnd } from '@/stores/useStatusStore';
import { Button } from '@/components/ui/button';
import { ChannelItem } from './ChannelItem';
import { DirectMessageItem } from './DirectMessageItem';
import { GroupDMItem } from './GroupDMItem';
import { AddChannelDialog } from './AddChannelDialog';
import { AddTeammatesDialog } from './AddTeammatesDialog';
import type { Channel } from '@/lib/types';
import { getChannels, createDMGroup } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import type { AuthUser } from '@/lib/api';
import { useMobileStore } from '@/stores/useMobileStore';
import { useSwitcherStore } from '@/stores/useSwitcherStore';
import { sidebarSections } from '@/lib/switcher';
// HuddleBar moved to global render in App.tsx

export function Sidebar() {
  const { t, i18n } = useTranslation('sidebar');
  const navigate = useNavigate();
  const location = useLocation();
  const { channels, directMessages, groupDMs, activeChannelId, activeDMId, activeGroupId, startDM, createChannel, joinChannel } =
    useChannelStore();
  const { user, logout } = useAuthStore();
  const { openProfile } = useProfileStore();
  const { permission, isSubscribed, subscribe, unsubscribe } = useNotificationStore();
  const closeSidebar = useMobileStore((s) => s.closeSidebar);
  const openSwitcher = useSwitcherStore((s) => s.openSwitcher);
  const sidebarCollapsed = useChannelStore((s) => s.sidebarCollapsed);
  const toggleSection = useChannelStore((s) => s.toggleSection);
  const channelsExpanded = !sidebarCollapsed.channels;
  const dmsExpanded = !sidebarCollapsed.dms;
  const starredExpanded = !sidebarCollapsed.starred;
  const activeNav = location.pathname === '/activity' ? 'activity' : location.pathname === '/unreads' ? 'unreads' : location.pathname === '/threads' ? 'threads' : location.pathname === '/files' ? 'files' : location.pathname === '/later' ? 'later' : location.pathname === '/admin' ? 'admin' : 'dms';
  const [showAvatarMenu, setShowAvatarMenu] = useState(false);
  const [showStatusDialog, setShowStatusDialog] = useState(false);
  const [showTokensDialog, setShowTokensDialog] = useState(false);
  const [showSessionsDialog, setShowSessionsDialog] = useState(false);
  const [showTwoFactorDialog, setShowTwoFactorDialog] = useState(false);
  const myCustomStatus = useCustomStatus(user?.id);
  const myDndOn = useIsDnd(user?.id);
  const [showAddChannelDialog, setShowAddChannelDialog] = useState(false);
  const [browseChannels, setBrowseChannels] = useState<Channel[]>([]);
  const [showAddTeammates, setShowAddTeammates] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const avatarMenuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);

  // Calculate total unread count across all channels
  const totalUnreadCount = channels.reduce((sum, ch) => sum + ch.unreadCount, 0);

  const activityUnread = useActivityStore((s) => s.unreadTotal);
  const threadsUnread = useThreadStore((s) => s.unreadCount);

  const navItems = [
    { icon: Bell, label: t('nav.activity'), id: 'activity', badge: activityUnread > 0 ? activityUnread : undefined },
    { icon: MessagesSquare, label: t('nav.threads'), id: 'threads', badge: threadsUnread > 0 ? threadsUnread : undefined },
    { icon: Inbox, label: t('nav.unreads'), id: 'unreads', badge: totalUnreadCount > 0 ? totalUnreadCount : undefined },
    { icon: Bookmark, label: t('nav.later'), id: 'later' },
    { icon: FileText, label: t('nav.files'), id: 'files' },
  ];

  // Close avatar menu when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target as Node)) {
        setShowAvatarMenu(false);
      }
    }
    if (showAvatarMenu) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showAvatarMenu]);

  // Close workspace menu when clicking outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
        setShowWorkspaceMenu(false);
      }
    }
    if (showWorkspaceMenu) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showWorkspaceMenu]);

  const handleOpenAddChannel = () => {
    setShowAddChannelDialog(true);
  };

  const handleBrowseChannels = async () => {
    try {
      const apiChannels = await getChannels();
      const allPublic: Channel[] = apiChannels
        .filter((ch) => !ch.isPrivate)
        .map((ch) => ({
          id: ch.id,
          name: ch.name,
          isPrivate: ch.isPrivate,
          memberCount: ch._count.members,
          unreadCount: ch.unreadCount,
          mentionCount: ch.mentionCount ?? 0,
          isMember: ch.isMember,
        }));
      setBrowseChannels(allPublic);
    } catch {
      setBrowseChannels([]);
    }
  };

  const handleCreateChannel = async (name: string, isPrivate?: boolean) => {
    const channelId = await createChannel(name, isPrivate);
    setShowAddChannelDialog(false);
    navTo(`/c/${channelId}`);
  };

  const handleJoinChannel = async (channelId: number) => {
    try {
      await joinChannel(channelId);
      setShowAddChannelDialog(false);
      navTo(`/c/${channelId}`);
    } catch {
      // error already logged in store
    }
  };

  const handleOpenAddTeammates = () => {
    setStartError(null);
    setShowAddTeammates(true);
  };

  const handleSelectUser = (u: AuthUser) => {
    startDM(u.id, u.name, u.avatar ?? undefined);
    setShowAddTeammates(false);
    navTo(`/d/${u.id}`);
  };

  // 1명을 고르면 1:1, 2명 이상이면 그룹 DM(같은 멤버면 기존 그룹이 열린다)
  const handleStartConversation = async (users: AuthUser[]) => {
    if (users.length === 1) {
      handleSelectUser(users[0]);
      return;
    }
    try {
      setStartError(null);
      const { group } = await createDMGroup(users.map((u) => u.id));
      useChannelStore.getState().upsertGroupDM(group);
      setShowAddTeammates(false);
      navTo(`/g/${group.id}`);
    } catch (err) {
      setStartError(apiErrorMessage(err, 'sidebar:groupDM.createError'));
    }
  };

  // Navigate and close sidebar on mobile
  // Rail item click: open the page, or go back to the first channel when it is already open
  const toggleNav = (path: string) => {
    if (location.pathname === path) {
      const firstChannel = channels.find((ch) => ch.isMember);
      if (firstChannel) navTo(`/c/${firstChannel.id}`);
    } else {
      navTo(path);
    }
  };

  const navTo = (path: string) => {
    navigate(path);
    closeSidebar();
  };

  const collator = getCollator(i18n.language);
  const { starredChannels, starredDMs, starredGroups, publicChannels, privateChannels, plainDMs, plainGroups } =
    sidebarSections({ channels, directMessages, groupDMs }, collator.compare);
  const sectionToggleLabel = (expanded: boolean, label: string) =>
    expanded ? t('sections.collapse', { section: label }) : t('sections.expand', { section: label });

  return (
    <div className="flex h-full">
      {/* 상태 대화상자는 아바타 메뉴 밖에 둔다(메뉴의 바깥 클릭 처리에 휘말려 닫히지 않게) */}
      {showStatusDialog && <StatusDialog onClose={() => setShowStatusDialog(false)} />}
      {showTokensDialog && <AccessTokensDialog onClose={() => setShowTokensDialog(false)} />}
      {showSessionsDialog && <SessionsDialog onClose={() => setShowSessionsDialog(false)} />}
      {showTwoFactorDialog && <TwoFactorDialog onClose={() => setShowTwoFactorDialog(false)} />}
      {/* Nav Rail - 70px wide, darker purple */}
      <div className="flex w-[70px] flex-col items-center bg-slack-sidebar-dark pt-[max(0.5rem,env(safe-area-inset-top))] gap-0">
        {/* Workspace Icon - 36x36px */}
        <button className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg overflow-hidden hover:rounded-xl transition-all">
          <img src="/favicon-192.png" alt={t('workspace.name')} className="h-full w-full object-cover" />
        </button>

        {/* Nav Items - 52x68px each with icon + label */}
        {navItems.map((item) => (
          <button
            key={item.id}
            data-testid={`nav-item-${item.id}`}
            onClick={() => {
              if (item.id === 'dms') {
                handleOpenAddTeammates();
              } else {
                toggleNav(`/${item.id}`);
              }
            }}
            className={cn(
              'relative flex flex-col h-[68px] w-[52px] items-center justify-center gap-1 rounded-lg transition-colors',
              activeNav === item.id
                ? 'bg-slack-sidebar-hover/50 text-white'
                : 'text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            <item.icon className="h-5 w-5" />
            <span className="text-[11px] font-medium">{item.label}</span>
            {item.badge && (
              <span className="absolute top-2 end-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] text-white">
                {item.badge}
              </span>
            )}
          </button>
        ))}

        {/* Admin Nav Item - only visible to admins and owner */}
        {(user?.role === 'ADMIN' || user?.role === 'OWNER') && (
          <button
            data-testid="nav-item-admin"
            onClick={() => {
              if (activeNav === 'admin') {
                const firstChannel = channels.find((ch) => ch.isMember);
                if (firstChannel) navTo(`/c/${firstChannel.id}`);
              } else {
                navTo('/admin');
              }
            }}
            className={cn(
              'relative flex flex-col h-[68px] w-[52px] items-center justify-center gap-1 rounded-lg transition-colors',
              activeNav === 'admin'
                ? 'bg-slack-sidebar-hover/50 text-white'
                : 'text-white/70 hover:bg-white/10 hover:text-white'
            )}
          >
            <Shield className="h-5 w-5" />
            <span className="text-[11px] font-medium">{t('nav.admin')}</span>
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* User Avatar */}
        {user && (
          <div className="relative mb-3" ref={avatarMenuRef}>
            <button
              data-testid="user-menu-button"
              onClick={() => setShowAvatarMenu(!showAvatarMenu)}
            >
              <Avatar
                src={user.avatar}
                alt={user.name}
                fallback={user.name}
                size="md"
                status={user.status}
                statusEmoji={myCustomStatus?.emoji}
                dnd={myDndOn}
                className="cursor-pointer"
              />
            </button>
            {showAvatarMenu && (
              <div className="absolute bottom-10 start-0 z-50 w-56 rounded-lg border border-slack-border bg-white py-1 shadow-lg">
                <div className="px-4 py-2 border-b border-slack-border-light">
                  <p className="text-sm font-medium text-slack-primary">{user.name}</p>
                  <p className="text-xs text-slack-hint">{user.email}</p>
                </div>
                <UserMenuStatus onDone={() => setShowAvatarMenu(false)} onOpenStatusDialog={() => setShowStatusDialog(true)} />
                <Button variant="menu-item" onClick={() => { setShowAvatarMenu(false); openProfile(); }}>
                  <User className="h-4 w-4" />
                  {t('userMenu.profile')}
                </Button>
                <Button variant="menu-item" data-testid="access-tokens-menu-item" onClick={() => { setShowAvatarMenu(false); setShowTokensDialog(true); }}>
                  <KeyRound className="h-4 w-4" />
                  {t('userMenu.accessTokens')}
                </Button>
                <Button variant="menu-item" data-testid="sessions-menu-item" onClick={() => { setShowAvatarMenu(false); setShowSessionsDialog(true); }}>
                  <Laptop className="h-4 w-4" />
                  {t('userMenu.sessions')}
                </Button>
                <Button variant="menu-item" data-testid="two-factor-menu-item" onClick={() => { setShowAvatarMenu(false); setShowTwoFactorDialog(true); }}>
                  <ShieldCheck className="h-4 w-4" />
                  {t('userMenu.twoFactor')}
                </Button>
                {/* 데스크톱 앱은 웹 푸시 대신 자체 알림 설정을 쓴다 */}
                {getDesktop() ? (
                  <DesktopNotificationMenuItem onDone={() => setShowAvatarMenu(false)} />
                ) : permission === 'unsupported' ? null : permission === 'denied' ? (
                  <Button variant="menu-item" className="text-slack-hint cursor-default" onClick={() => setShowAvatarMenu(false)}>
                    <BellOff className="h-4 w-4" />
                    {t('userMenu.notificationsBlocked')}
                  </Button>
                ) : (
                  <Button variant="menu-item" onClick={() => { setShowAvatarMenu(false); if (isSubscribed) unsubscribe(); else subscribe(); }}>
                    {isSubscribed ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                    {isSubscribed ? t('userMenu.disableNotifications') : t('userMenu.enableNotifications')}
                  </Button>
                )}
                <DesktopServerMenuItem onDone={() => setShowAvatarMenu(false)} />
                <Button variant="menu-item" onClick={() => { setShowAvatarMenu(false); logout(); }}>
                  <LogOut className="h-4 w-4 rtl:-scale-x-100" />
                  {t('userMenu.signOut')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Channel Sidebar - lighter/warmer purple with overlay effect */}
      <div data-testid="sidebar" className="flex w-[260px] flex-col bg-slack-sidebar text-white/70">
        {/* Workspace Header - 44px height, 6px 16px padding */}
        <div className="flex h-[44px] items-center justify-between border-b border-white/10 px-4 py-[6px] mt-[env(safe-area-inset-top)]">
          <span className="text-[18px] font-bold text-white">{t('workspace.name')}</span>
          <button onClick={handleOpenAddTeammates} aria-label={t('workspace.newMessage')} title={t('workspace.newMessage')} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20">
            <SquarePen className="h-4 w-4" />
          </button>
        </div>

        {/* 대화 찾기: 빠른 전환기(06)를 연다 */}
        <button
          type="button"
          data-testid="sidebar-find-conversation"
          onClick={() => {
            closeSidebar();
            openSwitcher();
          }}
          aria-label={t('findConversation')}
          className="mx-3 mt-2 flex h-8 items-center gap-2 rounded-md bg-white/10 px-3 text-[14px] text-white/70 hover:bg-white/20"
        >
          <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{t('findConversation')}</span>
        </button>

        {/* Scrollable Content - 0 0 16px 0 padding */}
        <div className="flex-1 overflow-y-auto pb-4">
          {/* Starred Section */}
          <div data-testid="starred-section" className="mb-3 mt-3">
            <button
              data-testid="starred-section-toggle"
              onClick={() => toggleSection('starred')}
              aria-expanded={starredExpanded}
              aria-label={sectionToggleLabel(starredExpanded, t('sections.starred'))}
              className="flex w-full items-center gap-1.5 ps-4 pe-2 py-[6px] text-[15px] hover:bg-slack-sidebar-hover/70"
            >
              {starredExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3 rtl:-scale-x-100" />}
              <Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
              <span>{t('sections.starred')}</span>
            </button>
            {starredExpanded && (
              <div>
                {starredChannels.length === 0 && starredDMs.length === 0 && starredGroups.length === 0 && (
                  <p data-testid="starred-empty" className="px-4 py-1 text-[13px] text-white/50">
                    {t('sections.starredEmpty')}
                  </p>
                )}
                {starredChannels.map((channel) => (
                  <ChannelItem
                    key={channel.id}
                    channel={channel}
                    isActive={activeChannelId === channel.id}
                    onClick={() => navTo(`/c/${channel.id}`)}
                    isPrivate={channel.isPrivate}
                  />
                ))}
                {starredDMs.map((dm) => (
                  <DirectMessageItem
                    key={dm.id}
                    dm={dm}
                    isActive={activeDMId === dm.id}
                    onClick={() => navTo(`/d/${dm.userId}`)}
                  />
                ))}
                {starredGroups.map((group) => (
                  <GroupDMItem
                    key={`g-${group.id}`}
                    group={group}
                    isActive={activeGroupId === group.id}
                    onClick={() => navTo(`/g/${group.id}`)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Channels Section */}
          <div className="mb-3 mt-3">
            <button
              onClick={() => toggleSection('channels')}
              aria-expanded={channelsExpanded}
              aria-label={sectionToggleLabel(channelsExpanded, t('sections.channels'))}
              data-testid="channels-section-toggle"
              className="flex w-full items-center gap-1.5 ps-4 pe-2 py-[6px] text-[15px] hover:bg-slack-sidebar-hover/70"
            >
              {channelsExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3 rtl:-scale-x-100" />
              )}
              <span>{t('sections.channels')}</span>
            </button>

            {channelsExpanded && (
              <div>
                {publicChannels.map((channel) => (
                  <ChannelItem
                    key={channel.id}
                    channel={channel}
                    isActive={activeChannelId === channel.id}
                    onClick={() => navTo(`/c/${channel.id}`)}
                  />
                ))}
                {privateChannels.map((channel) => (
                  <ChannelItem
                    key={channel.id}
                    channel={channel}
                    isActive={activeChannelId === channel.id}
                    onClick={() => navTo(`/c/${channel.id}`)}
                    isPrivate
                  />
                ))}
                {user?.role !== 'GUEST' && (
                  <button
                    onClick={handleOpenAddChannel}
                    className="flex items-center gap-2 mx-2 w-[calc(100%-16px)] px-4 h-[28px] text-[15px] rounded-[6px] text-start text-white/70 hover:bg-slack-sidebar-hover hover:text-white"
                  >
                    <Plus className="w-4 h-4 flex-shrink-0" />
                    <span>{t('sections.addChannels')}</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Direct Messages Section */}
          <div>
            <button
              onClick={() => toggleSection('dms')}
              aria-expanded={dmsExpanded}
              aria-label={sectionToggleLabel(dmsExpanded, t('sections.directMessages'))}
              data-testid="dms-section-toggle"
              className="flex w-full items-center gap-1.5 ps-4 pe-2 py-[6px] text-[15px] hover:bg-slack-sidebar-hover/70"
            >
              {dmsExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3 rtl:-scale-x-100" />
              )}
              <span>{t('sections.directMessages')}</span>
            </button>

            {dmsExpanded && (
              <div>
                {plainDMs.map((dm) => (
                  <DirectMessageItem
                    key={dm.id}
                    dm={dm}
                    isActive={activeDMId === dm.id}
                    onClick={() => navTo(`/d/${dm.userId}`)}
                  />
                ))}
                {plainGroups.map((group) => (
                  <GroupDMItem
                    key={`g-${group.id}`}
                    group={group}
                    isActive={activeGroupId === group.id}
                    onClick={() => navTo(`/g/${group.id}`)}
                  />
                ))}
                <button
                  onClick={handleOpenAddTeammates}
                  className="flex items-center gap-2 mx-2 w-[calc(100%-16px)] px-4 h-[28px] text-[15px] rounded-[6px] text-start text-white/70 hover:bg-slack-sidebar-hover hover:text-white"
                >
                  <Plus className="w-5 h-5 flex-shrink-0" />
                  <span>{t('sections.addTeammates')}</span>
                </button>
              </div>
            )}
          </div>
        </div>
        {/* HuddleBar now rendered globally in App.tsx for mobile visibility */}
      </div>

      {/* Add Channel Dialog (Create + Browse) */}
      <AddChannelDialog
        open={showAddChannelDialog}
        onClose={() => setShowAddChannelDialog(false)}
        onCreateChannel={handleCreateChannel}
        browseChannels={browseChannels}
        onJoinChannel={handleJoinChannel}
        onNavigateToChannel={(channelId) => {
          setShowAddChannelDialog(false);
          navTo(`/c/${channelId}`);
        }}
        onBrowse={handleBrowseChannels}
      />

      {/* Add Teammates Dialog */}
      <AddTeammatesDialog
        open={showAddTeammates}
        onClose={() => setShowAddTeammates(false)}
        onSelectUser={handleSelectUser}
        onConfirm={handleStartConversation}
        error={startError}
      />
    </div>
  );
}
