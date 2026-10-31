// 팝오버(메뉴, 이모지 선택기)의 가로 위치를 계산한다. 읽는 방향(dir)에 따라 기준 변이 바뀐다.
// LTR: 앵커의 오른쪽 끝에 팝오버 오른쪽 끝을 맞추고, RTL: 앵커의 왼쪽 끝에 팝오버 왼쪽 끝을 맞춘다(= 앵커의 end 변).
// 화면 밖으로 나가면 반대쪽 변에 맞추고, 그래도 넘치면 화면 안으로 끌어온다.

export interface InlineAnchor {
  left: number;
  right: number;
}

export function isRtlDocument(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
}

/** 팝오버의 left 좌표(px)를 돌려준다. */
export function alignInline(anchor: InlineAnchor, width: number, viewportWidth: number, rtl: boolean): number {
  const preferred = rtl ? anchor.left : anchor.right - width;
  const alternate = rtl ? anchor.right - width : anchor.left;
  const fits = (x: number) => x >= 0 && x + width <= viewportWidth;
  const left = fits(preferred) ? preferred : fits(alternate) ? alternate : preferred;
  return Math.max(0, Math.min(left, Math.max(0, viewportWidth - width)));
}
