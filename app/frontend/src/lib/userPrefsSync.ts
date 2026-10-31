import i18n from '@/lib/i18n';
import { ApiError, updateMyProfile } from '@/lib/api';
import { useAuthStore } from '@/stores/useAuthStore';
import { diffUserPrefs, isPermanentRejection, retryDelayMs, type AckedPrefs } from '@/lib/userPrefsDiff';

/**
 * 클라이언트 언어와 브라우저 시간대를 서버(User.locale, User.timeZone)에 저장한다.
 * 서버는 이 값으로 푸시 문구 언어와 날짜 경계(검색 tz 기본값)를 정한다.
 * 값이 바뀌었을 때만 PATCH한다(비교 규칙은 lib/userPrefsDiff.ts).
 * 값 자체를 서버가 거부하면(400 INVALID_*) 같은 요청을 반복하지 않는다. 네트워크 오류, 429, 5xx는 백오프를 두고 다시 시도한다.
 */

export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

let inFlight = false;
let lastRejected = '';
let acked: AckedPrefs = {};
let failures = 0;
let retryAt = 0;

/** 로그아웃할 때 모듈 상태를 비운다(다음 사용자의 동기화에 이어지지 않게). */
export function resetUserPrefsSync(): void {
  inFlight = false;
  lastRejected = '';
  acked = {};
  failures = 0;
  retryAt = 0;
}

export async function syncUserPrefs(): Promise<void> {
  const { user, isAuthenticated, isHydrating, updateUser } = useAuthStore.getState();
  // 하이드레이션 전의 임시 사용자(email 없음)에는 저장하지 않는다
  if (!isAuthenticated || isHydrating || !user || !user.email || inFlight) return;
  if (Date.now() < retryAt) return;
  const patch = diffUserPrefs(user, { locale: i18n.language || null, timeZone: browserTimeZone() }, acked);
  const key = JSON.stringify(patch);
  if (key === '{}' || key === lastRejected) return;
  inFlight = true;
  try {
    const saved = await updateMyProfile(patch);
    if (patch.locale) acked = { ...acked, locale: { browser: patch.locale, saved: saved.locale ?? null } };
    if (patch.timeZone) acked = { ...acked, timeZone: { browser: patch.timeZone, saved: saved.timeZone ?? null } };
    failures = 0;
    retryAt = 0;
    updateUser({ locale: saved.locale ?? null, timeZone: saved.timeZone ?? null });
  } catch (err) {
    if (err instanceof ApiError && isPermanentRejection(err.status, err.code)) {
      lastRejected = key;
    } else {
      failures += 1;
      retryAt = Date.now() + retryDelayMs(failures);
    }
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
  const unsubscribe = useAuthStore.subscribe((state, prev) => {
    // 로그아웃(인증 해제)이면 상태를 비운다
    if (prev.isAuthenticated && !state.isAuthenticated) resetUserPrefsSync();
    run();
  });
  run();
  return () => {
    i18n.off('languageChanged', run);
    window.removeEventListener('focus', run);
    document.removeEventListener('visibilitychange', run);
    unsubscribe();
  };
}
