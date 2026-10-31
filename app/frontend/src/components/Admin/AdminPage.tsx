import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, Users, Link2, Hash, Menu, ScrollText, Webhook, Archive, ShieldCheck, ShieldAlert, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAdminStore } from '@/stores/useAdminStore';
import { useMobileStore } from '@/stores/useMobileStore';
import { AdminMembersTab } from './AdminMembersTab';
import { AdminInvitesTab } from './AdminInvitesTab';
import { AdminChannelsTab } from './AdminChannelsTab';
import { AdminWebhooksTab } from './AdminWebhooksTab';
import { AdminAuditLogTab } from './AdminAuditLogTab';
import { AdminRetentionTab } from './AdminRetentionTab';
import { AdminSecurityTab } from './AdminSecurityTab';
import { AdminDlpTab } from './AdminDlpTab';
import { AdminLegalHoldsTab } from './AdminLegalHoldsTab';

type Tab = 'members' | 'invites' | 'channels' | 'webhooks' | 'audit' | 'retention' | 'security' | 'dlp' | 'legalHolds';

const TABS: { id: Tab; labelKey: string; icon: typeof Users }[] = [
  { id: 'members', labelKey: 'page.tabs.members', icon: Users },
  { id: 'invites', labelKey: 'page.tabs.invites', icon: Link2 },
  { id: 'channels', labelKey: 'page.tabs.channels', icon: Hash },
  { id: 'webhooks', labelKey: 'page.tabs.webhooks', icon: Webhook },
  { id: 'audit', labelKey: 'page.tabs.audit', icon: ScrollText },
  { id: 'retention', labelKey: 'page.tabs.retention', icon: Archive },
  { id: 'security', labelKey: 'page.tabs.security', icon: ShieldCheck },
  { id: 'dlp', labelKey: 'page.tabs.dlp', icon: ShieldAlert },
  { id: 'legalHolds', labelKey: 'page.tabs.legalHolds', icon: Lock },
];

export function AdminPage() {
  const { t } = useTranslation('admin');
  const [activeTab, setActiveTab] = useState<Tab>('members');
  const { fetchUsers, fetchChannels, fetchInvites, fetchWebhooks } = useAdminStore();

  useEffect(() => {
    fetchUsers();
    fetchChannels();
    fetchInvites();
    fetchWebhooks();
  }, [fetchUsers, fetchChannels, fetchInvites, fetchWebhooks]);

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-slack-border px-6 py-3">
        <button
          onClick={useMobileStore.getState().openSidebar}
          aria-label={t('page.openSidebar')}
          className="me-1 flex h-8 w-8 items-center justify-center rounded hover:bg-slack-hover md:hidden"
        >
          <Menu className="h-5 w-5 text-slack-secondary" />
        </button>
        <Shield className="h-5 w-5 text-slack-primary" />
        <h1 className="text-lg font-bold text-slack-primary">{t('page.title')}</h1>
      </div>

      {/* Tabs */}
      <div className="flex overflow-x-auto border-b border-slack-border px-6">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
              activeTab === tab.id
                ? 'border-slack-btn text-slack-btn'
                : 'border-transparent text-slack-secondary hover:text-slack-primary hover:border-gray-300'
            )}
          >
            <tab.icon className="h-4 w-4" />
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'members' && <AdminMembersTab />}
        {activeTab === 'invites' && <AdminInvitesTab />}
        {activeTab === 'channels' && <AdminChannelsTab />}
        {activeTab === 'webhooks' && <AdminWebhooksTab />}
        {activeTab === 'audit' && <AdminAuditLogTab />}
        {activeTab === 'retention' && <AdminRetentionTab />}
        {activeTab === 'security' && <AdminSecurityTab />}
        {activeTab === 'dlp' && <AdminDlpTab />}
        {activeTab === 'legalHolds' && <AdminLegalHoldsTab />}
      </div>
    </div>
  );
}
