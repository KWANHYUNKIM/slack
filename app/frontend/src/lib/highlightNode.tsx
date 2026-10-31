import { Children, cloneElement, isValidElement, type ReactNode } from 'react';
import { matchRanges, splitHighlights } from '@/lib/searchQuery';

/**
 * 이미 렌더된 React 노드 트리의 텍스트 노드마다 키워드를 다시 찾아 <mark>로 감싼다.
 * 서식(굵게, 코드, 링크, 멘션)은 그대로 두고 문자열만 쪼개므로 dangerouslySetInnerHTML이 필요 없다.
 */
export function highlightNode(node: ReactNode, terms: string[]): ReactNode {
  if (terms.length === 0) return node;
  if (typeof node === 'string') {
    const parts = splitHighlights(node, matchRanges(node, terms));
    if (parts.length === 1 && !parts[0].mark) return node;
    return parts.map((p, i) =>
      p.mark ? <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 text-slack-primary">{p.text}</mark> : p.text,
    );
  }
  if (Array.isArray(node)) {
    return Children.map(node, (child) => highlightNode(child, terms));
  }
  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children != null) {
    return cloneElement(node, undefined, highlightNode(node.props.children, terms));
  }
  return node;
}
