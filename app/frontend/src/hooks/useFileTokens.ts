import { useEffect, useSyncExternalStore } from 'react';
import { subscribeDownloadTokens, getFileTokenState, prefetchFileTokens } from '@/lib/api';
import { buildFileUrl } from '@/lib/fileTokens';

const DENIED = '\u0000denied';

/**
 * 파일 하나의 다운로드 URL을 돌려준다. 구독 단위가 파일이라 토큰이 바뀐 파일만 다시 그려진다.
 * url이 null이면 아직 토큰이 없는 것(pending)이거나 접근 불가(denied)이다. 호출한 쪽이 자리표시자를 그린다.
 */
export function useFileUrl(fileId: number, { download = false }: { download?: boolean } = {}): { url: string | null; denied: boolean } {
  // 스냅샷은 원시 문자열이라 토큰이 같으면 다시 그리지 않는다
  const snap = useSyncExternalStore(subscribeDownloadTokens, () => {
    const s = getFileTokenState(fileId);
    return s.status === 'ready' ? s.token : s.status === 'denied' ? DENIED : '';
  });

  useEffect(() => {
    if (snap === '') prefetchFileTokens([fileId]);
  }, [fileId, snap]);

  if (snap === DENIED) return { url: null, denied: true };
  if (snap === '') return { url: null, denied: false };
  return { url: buildFileUrl(fileId, { status: 'ready', token: snap }, { download }), denied: false };
}
