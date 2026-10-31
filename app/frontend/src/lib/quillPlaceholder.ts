// Quill은 placeholder를 생성할 때 root의 data-placeholder 속성에 한 번 넣고, 이후에는 다시 읽지 않는다.
// 언어를 바꾸면 CSS(::before)가 보여 줄 문구도 바뀌도록 속성을 직접 갱신한다.
// DOM 전체가 필요 없게 dataset만 받아서 node --test에서도 검사할 수 있게 한다.
export function syncQuillPlaceholder(root: { dataset: Record<string, string | undefined> }, placeholder: string): void {
  if (root.dataset.placeholder !== placeholder) root.dataset.placeholder = placeholder;
}
