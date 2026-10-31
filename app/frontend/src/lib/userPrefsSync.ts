import i18n from '@/lib/i18n';
import { updateMyProfile } from '@/lib/api';
import { useAuthStore } from '@/stores/useAuthStore';

/**
 * 클라이언트 언어와 브라우저 시간대를 서버(User.locale, User.timeZone)에 저장한다.
 * 서버는 이 값으로 푸시 문구 언어와 날짜 경계(검색 tz 기본값)를 정한다.
 * 값이 바뀌었을 때만 PATCH한다. 실패하면 조용히 넘기고 다음 기회(언어 변경, 창 포커스)에 다시 시도한다.
 */

export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** 서버에 보낼 변경분. 서버가 이미 같은 값을 갖고 있으면 비어 있다. */
export function diffUserPrefs(
  saved: { locale?: string | null; timeZone?: string | null },
  current: { locale: string | null; timeZone: string | null },
): { locale?: string; timeZone?: string } {
  const patch: { locale?: string; timeZone?: string } = {};
  if (current.locale && current.locale !== saved.locale) patch.locale = current.locale;
  if (current.timeZone && current.timeZone !== saved.timeZone) patch.timeZone = current.timeZone;
  return patch;
}

let inFlight = false;
let lastRejected = '';

export async function syncUserPrefs(): Promise<void> {
  const { user, isAuthenticated, isHydrating, updateUser } = useAuthStore.getState();
  // 하이드레이션 전의 임시 사용자(email 없음)에는 저장하지 않는다
  if (!isAuthenticated || isHydrating || !user || !user.email || inFlight) return;
  const patch = diffUserPrefs(user, { locale: i18n.language || null, timeZone: browserTimeZone() });
  const key = JSON.stringify(patch);
  if (key === '{}' || key === lastRejected) return;
  inFlight = true;
  try {
    const saved = await updateMyProfile(patch);
    updateUser({ locale: saved.locale ?? null, timeZone: saved.timeZone ?? null });
  } catch {
    // 같은 값을 서버가 거부하면 같은 요청을 반복하지 않는다
    lastRejected = key;
  } finally {
    inFlight = false;
  }
}

/** 앱이 뜰 때 한 번 부른다. 로그인 상태가 되거나 언어·시간대가 바뀌면 동기화한다. 해제 함수를 돌려준다. */
export function startUserPrefsSync(): () => void {
  const run = () => void syncUserPrefs();
  i18n.on('languageChanged', run);
  window.addEventListener('focus', run);
  document.addEventListener('visibilitychange', run);
  const unsubscribe = useAuthStore.subscribe(run);
  run();
  return () => {
    i18n.off('languageChanged', run);
    window.removeEventListener('focus', run);
    document.removeEventListener('visibilitychange', run);
    unsubscribe();
  };
}
