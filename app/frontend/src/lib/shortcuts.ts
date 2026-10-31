// 전역 키보드 단축키 정의(06). 목록은 이 배열 한 곳에서만 고친다.
// 도움말 모달(ShortcutsHelpModal)과 판정(useGlobalShortcuts)이 모두 이 배열을 읽는다.
// 동작 자체는 Slack 실관찰이 아니라 공개 도움말 수준의 추정이다(검증 필요).

export type ShortcutId =
  | 'switcher'
  | 'closeTop'
  | 'help'
  | 'prevChannel'
  | 'nextChannel'
  | 'prevUnread'
  | 'nextUnread';

export interface ShortcutDef {
  id: ShortcutId;
  /** Cmd(Mac)/Ctrl(그 외) */
  mod?: boolean;
  alt?: boolean;
  /** 지정하면 정확히 일치해야 한다. 비우면 화살표 키는 Shift 없음, 문자 키는 상관없음. */
  shift?: boolean;
  /** KeyboardEvent.key 값 */
  key: string;
  /** 입력창·에디터에 포커스가 있어도 동작하는가 */
  inEditable: boolean;
  /** 도움말 모달의 묶음 */
  group: 'navigation' | 'general';
  /** 번역 키(common 네임스페이스) */
  labelKey: string;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'switcher', mod: true, key: 'k', inEditable: true, group: 'navigation', labelKey: 'shortcuts.items.switcher' },
  { id: 'prevChannel', alt: true, key: 'ArrowUp', inEditable: false, group: 'navigation', labelKey: 'shortcuts.items.prevChannel' },
  { id: 'nextChannel', alt: true, key: 'ArrowDown', inEditable: false, group: 'navigation', labelKey: 'shortcuts.items.nextChannel' },
  { id: 'prevUnread', alt: true, shift: true, key: 'ArrowUp', inEditable: false, group: 'navigation', labelKey: 'shortcuts.items.prevUnread' },
  { id: 'nextUnread', alt: true, shift: true, key: 'ArrowDown', inEditable: false, group: 'navigation', labelKey: 'shortcuts.items.nextUnread' },
  { id: 'help', key: '?', inEditable: false, group: 'general', labelKey: 'shortcuts.items.help' },
  { id: 'closeTop', key: 'Escape', inEditable: true, group: 'general', labelKey: 'shortcuts.items.closeTop' },
];

/** 판정에 필요한 이벤트 필드만 (테스트에서 객체로 흉내 낸다) */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** navigator.platform 대신 userAgent로 판별한다(platform은 지원 중단 예정). */
export function detectMac(userAgent: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(userAgent);
}

/** 이벤트가 어느 단축키인지. 해당 없으면 null. 입력 중 허용 여부는 호출자가 isEditableElement로 거른다. */
export function matchShortcut(e: KeyLike, isMac: boolean, defs: readonly ShortcutDef[] = SHORTCUTS): ShortcutDef | null {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  // 다른 쪽 보조키가 같이 눌려 있으면(Mac에서 Ctrl+K 등) 다른 동작이므로 제외
  const stray = isMac ? e.ctrlKey : e.metaKey;
  if (stray) return null;
  for (const d of defs) {
    if (d.key.toLowerCase() !== e.key.toLowerCase()) continue;
    if (!!d.mod !== mod) continue;
    if (!!d.alt !== e.altKey) continue;
    if (d.shift !== undefined) {
      if (d.shift !== e.shiftKey) continue;
    } else if (d.key.startsWith('Arrow') && e.shiftKey) {
      continue;
    }
    return d;
  }
  return null;
}

/** 이벤트 대상이 글자를 입력받는 요소인가(input, textarea, select, contenteditable 안) */
export function isEditableElement(
  el: { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null,
): boolean {
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return !!el.closest?.('[contenteditable="true"], [contenteditable=""]');
}

/** 도움말에 보여 줄 키 조각. 예: ['⌘','K'] 또는 ['Ctrl','K'] */
export function shortcutKeys(d: ShortcutDef, isMac: boolean): string[] {
  const parts: string[] = [];
  if (d.mod) parts.push(isMac ? '⌘' : 'Ctrl');
  if (d.alt) parts.push(isMac ? '⌥' : 'Alt');
  if (d.shift) parts.push(isMac ? '⇧' : 'Shift');
  const names: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc' };
  parts.push(names[d.key] ?? d.key.toUpperCase());
  return parts;
}
