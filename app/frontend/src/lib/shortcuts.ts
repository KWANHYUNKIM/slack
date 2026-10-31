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
  /** true면 전역 판정에서 제외하고 도움말에만 보인다(Esc는 각 모달의 onKeyDown이 처리한다) */
  docOnly?: boolean;
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
  { id: 'closeTop', key: 'Escape', inEditable: true, docOnly: true, group: 'general', labelKey: 'shortcuts.items.closeTop' },
];

/** 판정에 필요한 이벤트 필드만 (테스트에서 객체로 흉내 낸다) */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** 있으면 AltGraph 판별에 우선 쓴다 */
  getModifierState?: (key: string) => boolean;
}

/** navigator.platform 대신 userAgent로 판별한다(platform은 지원 중단 예정). */
export function detectMac(userAgent: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(userAgent);
}

/** Windows/Linux의 AltGr(= Ctrl+Alt로 보고되는 경우가 있다) 여부 */
export function isAltGr(e: KeyLike, isMac: boolean): boolean {
  const state = e.getModifierState?.('AltGraph');
  if (state !== undefined) return state;
  return !isMac && e.ctrlKey && e.altKey;
}

// Shift로 입력되는 기호 문자(`?` 등): e.key가 이미 Shift를 반영하므로 Shift 상태는 보지 않는다
const isShiftedSymbol = (key: string) => key.length === 1 && !/[\p{L}\p{N}]/u.test(key);

/**
 * 이벤트가 어느 단축키인지. 해당 없으면 null. 입력 중 허용 여부는 호출자가 isEditableElement로 거른다.
 * - 보조키(mod/alt/shift)는 정확히 일치해야 한다(Cmd+Shift+K는 전환기가 아니다).
 * - AltGr로 입력한 글자(`?` 등)는 보조키 없는 글자 단축키로 취급한다.
 */
export function matchShortcut(e: KeyLike, isMac: boolean, defs: readonly ShortcutDef[] = SHORTCUTS): ShortcutDef | null {
  const altGr = isAltGr(e, isMac);
  const key = e.key.toLowerCase();
  for (const d of defs) {
    if (d.docOnly || d.key.toLowerCase() !== key) continue;
    const plainChar = !d.mod && !d.alt && isShiftedSymbol(d.key);
    if (altGr) {
      if (plainChar) return d; // AltGr+기호: 보조키를 무시
      continue;
    }
    // 다른 쪽 보조키가 같이 눌려 있으면(Mac에서 Ctrl+K 등) 다른 동작이므로 제외
    if (isMac ? e.ctrlKey : e.metaKey) continue;
    if (!!d.mod !== (isMac ? e.metaKey : e.ctrlKey)) continue;
    if (!!d.alt !== e.altKey) continue;
    if (!isShiftedSymbol(d.key) && (d.shift ?? false) !== e.shiftKey) continue;
    return d;
  }
  return null;
}

// 글자를 입력받는 input 종류. checkbox, radio, button 등은 편집 요소가 아니다.
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** 이벤트 대상이 글자를 입력받는 요소인가(텍스트 입력 계열 input, textarea, contenteditable 안) */
export function isEditableElement(
  el: { tagName?: string; type?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null,
): boolean {
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((el.type ?? 'text').toLowerCase());
  if (el.isContentEditable) return true;
  return !!el.closest?.('[contenteditable="true"], [contenteditable=""]');
}

export type KeyLabelId = 'ctrl' | 'alt' | 'shift' | 'esc' | 'enter';

/** 도움말에 보여 줄 키 조각. ⌘⌥⇧↑↓ 기호는 그대로, 이름(Ctrl, Alt, Shift, Esc, Enter)은 label로 번역한다. */
export function shortcutKeys(d: ShortcutDef, isMac: boolean, label: (id: KeyLabelId) => string = (id) => id[0].toUpperCase() + id.slice(1)): string[] {
  const parts: string[] = [];
  if (d.mod) parts.push(isMac ? '⌘' : label('ctrl'));
  if (d.alt) parts.push(isMac ? '⌥' : label('alt'));
  if (d.shift) parts.push(isMac ? '⇧' : label('shift'));
  const names: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', Escape: label('esc'), Enter: label('enter') };
  parts.push(names[d.key] ?? d.key.toUpperCase());
  return parts;
}
