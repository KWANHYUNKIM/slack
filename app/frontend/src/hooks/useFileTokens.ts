import { useSyncExternalStore } from 'react';
import { subscribeDownloadTokens, getDownloadTokenVersion } from '@/lib/api';

/**
 * getFileUrl/getAuthFileUrl을 렌더에서 쓰는 컴포넌트가 호출한다.
 * 파일별 토큰이 도착하거나 만료될 때 다시 그려서 URL에 새 토큰이 실리게 한다.
 */
export function useFileTokens(): number {
  return useSyncExternalStore(subscribeDownloadTokens, getDownloadTokenVersion);
}
