import { useCallback, useEffect, useRef, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Picker } from 'emoji-mart';
import { loadEmojiData } from '@/lib/emoji/emojiData';
import { useTranslation } from 'react-i18next';
import { useClickOutside } from '@/hooks/useClickOutside';
import { cn } from '@/lib/utils';
import { alignInline, isRtlDocument } from '@/lib/popoverPosition';
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
  const errorRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation('common');
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

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
      // data와 i18n은 서로 의존하지 않으므로 병렬로 읽는다.
      const [dataResult, i18nResult] = await Promise.allSettled([
        loadEmojiData(),
        loadEmojiMartI18n(i18n.language),
      ]);
      if (cancelled) return;
      if (dataResult.status === 'rejected') {
        console.warn('emoji data load failed, picker not shown', dataResult.reason);
        setLoadFailed(true);
        return;
      }
      const data = dataResult.value;
      let locale = 'en';
      let pickerI18n: Record<string, unknown> | undefined;
      if (i18nResult.status === 'fulfilled') {
        ({ locale, i18n: pickerI18n } = i18nResult.value);
      } else {
        console.warn('emoji-mart i18n load failed, falling back to en', i18nResult.reason);
      }
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
  }, [attempt]);

  // 로드 실패 안내도 바깥 클릭과 Esc로 닫힌다 (피커 자체의 바깥 클릭은 emoji-mart가 처리)
  const closeOnFailure = useCallback(() => onClickOutsideRef.current?.(), []);
  useClickOutside(errorRef, closeOnFailure, loadFailed);
  useEffect(() => {
    if (!loadFailed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeOnFailure();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [loadFailed, closeOnFailure]);

  return (
    <>
      <div ref={containerRef} />
      {loadFailed && (
        <div
          ref={errorRef}
          role="alert"
          className="flex w-[352px] flex-col items-center gap-3 rounded-lg border border-slack-border bg-white p-6 text-sm text-slack-primary shadow-lg"
        >
          <p>{t('emojiPicker.loadFailed')}</p>
          <button
            type="button"
            onClick={() => {
              setLoadFailed(false);
              setAttempt((n) => n + 1);
            }}
            className="rounded border border-slack-border px-3 py-1 hover:bg-slack-hover"
          >
            {t('emojiPicker.retry')}
          </button>
        </div>
      )}
    </>
  );
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

    const left = alignInline(anchorRect, pickerWidth, window.innerWidth, isRtlDocument());

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
