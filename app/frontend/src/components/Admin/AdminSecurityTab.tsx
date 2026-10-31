import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as api from '@/lib/api';
import type { SecuritySettings } from '@/lib/api';
import { apiErrorMessage } from '@/lib/apiErrors';
import { useToastStore } from '@/stores/useToastStore';

// 조직 보안 정책(E7b): 모든 사용자 2FA 필수. 켜는 관리자는 자기 2FA가 먼저 있어야 한다(서버가 MFA_NOT_ENABLED로 막는다).
export function AdminSecurityTab() {
  const { t } = useTranslation('admin');
  const showToast = useToastStore((s) => s.show);
  const [settings, setSettings] = useState<SecuritySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminGetSecuritySettings()
      .then(setSettings)
      .catch(() => setError(t('security.errors.loadFailed')));
  }, [t]);

  const handleToggle = async (requireMfa: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.adminUpdateSecuritySettings(requireMfa));
      showToast(t('security.saved'));
    } catch (err) {
      setError(apiErrorMessage(err, 'admin:security.errors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl">
      <h2 className="mb-3 text-base font-bold text-slack-primary">{t('security.title')}</h2>
      {error && <p role="alert" className="mb-3 text-sm text-slack-error">{error}</p>}
      {!settings ? (
        !error && <p className="text-sm text-slack-hint">{t('security.loading')}</p>
      ) : (
        <>
          {!settings.mfaAvailable && (
            <p data-testid="mfa-unavailable" className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              {t('security.unavailable')}
            </p>
          )}
          <label className="flex items-start gap-3 rounded-lg border border-slack-border p-4">
            <input
              type="checkbox"
              data-testid="require-mfa-toggle"
              className="mt-1"
              checked={settings.requireMfa}
              disabled={busy || (!settings.mfaAvailable && !settings.requireMfa)}
              onChange={(e) => void handleToggle(e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium text-slack-primary">{t('security.requireMfa')}</span>
              <span className="block text-xs text-slack-secondary">{t('security.requireMfaHint')}</span>
            </span>
          </label>
        </>
      )}
    </div>
  );
}
