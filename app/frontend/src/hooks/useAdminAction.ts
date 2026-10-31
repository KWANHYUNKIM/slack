import { useCallback, useRef, useState } from 'react';
import { apiErrorMessage } from '@/lib/apiErrors';

/**
 * 관리자 화면의 변경 동작 하나를 감싼다. 대화상자나 폼마다 인스턴스를 하나씩 쓴다.
 * - run: 작업을 실행한다. 진행 중이면 두 번째 호출은 무시하고 false를 돌려준다(중복 제출 방지).
 *   성공하면 true, 실패하면 번역된 문구를 error에 담고 false를 돌려준다. 호출한 쪽은 true일 때만 대화상자를 닫는다.
 * - fallbackKey: 서버 코드에 맞는 문구가 없을 때 쓸 번역 키. run에서 다른 키를 줄 수 있다.
 */
export function useAdminAction(fallbackKey: string) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 렌더 사이에도 중복 호출을 막으려고 state와 따로 ref를 둔다.
  const busyRef = useRef(false);

  const run = useCallback(
    async (task: () => Promise<void>, key: string = fallbackKey): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setError('');
      try {
        await task();
        return true;
      } catch (err) {
        setError(apiErrorMessage(err, key));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fallbackKey],
  );

  const reset = useCallback(() => setError(''), []);

  return { error, busy, run, reset };
}
