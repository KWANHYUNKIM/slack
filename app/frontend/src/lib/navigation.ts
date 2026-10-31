// 라우터 밖(렌더 함수 등)에서 앱 안 이동을 할 때 쓴다. AppShell이 React Router의 navigate를 등록한다.
type NavigateFn = (to: string) => void;

let navigateFn: NavigateFn | null = null;

export function registerNavigate(fn: NavigateFn | null): void {
  navigateFn = fn;
}

/** 등록된 라우터로 이동한다. 아직 없으면 false를 돌려 호출자가 기본 동작(링크 이동)을 하게 한다. */
export function navigateInApp(to: string): boolean {
  if (!navigateFn) return false;
  navigateFn(to);
  return true;
}
