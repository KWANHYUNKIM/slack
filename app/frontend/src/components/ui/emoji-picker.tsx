import { useCallback, useEffect, useRef, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Picker } from 'emoji-mart';
import { loadEmojiData } from '@/lib/emoji/emojiData';
import { cn } from '@/lib/utils';
import i18n from '@/lib/i18n';
import { loadEmojiMartI18n } from '@/lib/i18n/emojiI18n';

interface EmojiPickerProps {
  onEmojiSelect: (emoji: { native: string; id: string }) => void;
  onClickOutside?: () => void;
}

export function EmojiPicker({ onEmojiSelect, onClickOutside }: EmojiPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onEmojiSelectRef = useRef(onEmojiSelect);
  const onClickOutsideRef = useRef(onClickOutside);

  useLayoutEffect(() => {
    onEmojiSelectRef.current = onEmojiSelect;
    onClickOutsideRef.current = onClickOutside;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    // Delay picker creation to avoid the opening click triggering onClickOutside
    const timer = setTimeout(async () => {
      // 번들에 포함된 데이터(lazy 청크)와 번역을 넘겨 CDN 요청을 막는다 (규칙 17)
      // data를 안 넘기면 emoji-mart가 jsdelivr에서 받으므로 로드 실패 시에는 피커를 띄우지 않는다.
      // i18n이 실패하면 en으로 띄운다 (emoji-mart 내장 영어, 외부 요청 없음)
      let data;
      try {
        data = await loadEmojiData();
      } catch (err) {
        console.warn('emoji data load failed, picker not shown', err);
        return;
      }
      let locale = 'en';
      let pickerI18n: Record<string, unknown> | undefined;
      try {
        ({ locale, i18n: pickerI18n } = await loadEmojiMartI18n(i18n.language));
      } catch (err) {
        console.warn('emoji-mart i18n load failed, falling back to en', err);
      }
      if (cancelled) return;
      const picker = new Picker({
        data,
        i18n: pickerI18n,
        locale,
        onEmojiSelect: (emoji: { native: string; id: string }) => onEmojiSelectRef.current(emoji),
        onClickOutside: () => onClickOutsideRef.current?.(),
        set: 'native',
        theme: 'light',
        previewPosition: 'none',
        skinTonePosition: 'search',
        navPosition: 'top',
        perLine: 9,
        emojiSize: 24,
        emojiButtonSize: 32,
      });

      container.appendChild(picker as unknown as Node);
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      container.replaceChildren();
    };
  }, []);

  return <div ref={containerRef} />;
}

/**
 * Portal-rendered EmojiPicker that escapes overflow containers.
 * Uses an invisible anchor to measure position, then renders the picker
 * via createPortal with fixed positioning.
 */
interface PortalEmojiPickerProps extends EmojiPickerProps {
  anchorClassName?: string;
}

export function PortalEmojiPicker({
  onEmojiSelect,
  onClickOutside,
  anchorClassName,
}: PortalEmojiPickerProps) {
  const onClickOutsideRef = useRef(onClickOutside);
  useLayoutEffect(() => {
    onClickOutsideRef.current = onClickOutside;
  });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Measure the anchor as soon as it is attached (runs during commit, before paint)
  const anchorRef = useCallback((anchor: HTMLDivElement | null) => {
    if (!anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    // emoji-mart Picker renders at roughly 352x352 (v5.x, native set, perLine=9)
    const pickerHeight = 352;
    const pickerWidth = 352;

    let top = anchorRect.top;
    if (top + pickerHeight > window.innerHeight) {
      top = Math.max(0, anchorRect.top - pickerHeight);
    }

    let left = anchorRect.right - pickerWidth;
    if (left < 0) left = Math.max(0, anchorRect.left);

    setPos({ top, left });
  }, []);

  // Close on scroll so the picker doesn't float detached from its message
  useEffect(() => {
    const handleScroll = () => onClickOutsideRef.current?.();
    const timerId = setTimeout(() => {
      window.addEventListener('scroll', handleScroll, true);
    }, 0);
    return () => {
      clearTimeout(timerId);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, []);

  const pickerContent = (
    <div
      style={
        pos
          ? { position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }
          : { position: 'fixed', visibility: 'hidden' as const, top: -9999, left: -9999 }
      }
    >
      <EmojiPicker onEmojiSelect={onEmojiSelect} onClickOutside={onClickOutside} />
    </div>
  );

  return (
    <>
      <div
        ref={anchorRef}
        className={cn('pointer-events-none', anchorClassName)}
        style={{ height: 0, overflow: 'hidden' }}
      />
      {createPortal(pickerContent, document.body)}
    </>
  );
}
