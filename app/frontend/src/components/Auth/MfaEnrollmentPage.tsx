import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { useAuthStore } from '@/stores/useAuthStore';
import { TwoFactorSetup } from '@/components/Profile/TwoFactorSetup';

// 조직이 2FA를 필수로 했는데 아직 등록하지 않은 사용자에게 보이는 유일한 화면(E7b).
// 서버도 등록 API 말고는 MFA_ENROLLMENT_REQUIRED로 거부하므로, 이 화면을 우회해도 다른 기능은 쓸 수 없다.
export function MfaEnrollmentPage() {
  const { t } = useTranslation('auth');
  const { logout, finishMfaEnrollment } = useAuthStore();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-4" data-testid="mfa-enrollment-page">
      <div className="w-full max-w-[480px]">
        <div className="mb-6 text-center">
          <ShieldCheck className="mx-auto mb-3 h-10 w-10 text-slack-primary" />
          <h1 className="text-2xl font-bold text-slack-primary">{t('mfaEnrollment.title')}</h1>
          <p className="mt-2 text-sm text-gray-600">{t('mfaEnrollment.description')}</p>
        </div>
        <TwoFactorSetup onFinished={finishMfaEnrollment} />
        <button type="button" onClick={logout} className="mt-6 block w-full text-center text-sm text-slack-link hover:underline">
          {t('mfaEnrollment.signOut')}
        </button>
      </div>
    </div>
  );
}
