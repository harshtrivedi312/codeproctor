'use client';
import * as React from 'react';

/** Pixels of slack: browsers round scroll positions, and zoomed pages land a pixel short. */
const SLACK_PX = 4;

export function isAtEnd(
  el: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>,
): boolean {
  // A container with no size is not laid out yet: that is not "the end", so fail closed.
  return el.scrollHeight > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - SLACK_PX;
}

/**
 * True once the candidate has seen the end of a scroll container (FR-401, TC-095). Three ways to
 * get there, so nobody is stuck: scrolling (mouse, touch, keyboard), an end marker coming into view
 * (screen-reader virtual cursor), and a document short enough to need no scrolling at all.
 * Once reached it stays reached, even if the window is resized or the text re-wraps.
 */
export function useScrolledToEnd(): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  endMarkerRef: React.RefObject<HTMLDivElement | null>;
  reachedEnd: boolean;
  recheck: () => void;
} {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const endMarkerRef = React.useRef<HTMLDivElement>(null);
  const [reachedEnd, setReachedEnd] = React.useState(false);

  const recheck = React.useCallback(() => {
    const el = containerRef.current;
    if (el && isAtEnd(el)) setReachedEnd(true);
  }, []);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    recheck();
    el.addEventListener('scroll', recheck, { passive: true });
    window.addEventListener('resize', recheck);
    let observer: IntersectionObserver | null = null;
    const marker = endMarkerRef.current;
    if (marker && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) setReachedEnd(true);
        },
        { root: el, threshold: 1 },
      );
      observer.observe(marker);
    }
    return () => {
      el.removeEventListener('scroll', recheck);
      window.removeEventListener('resize', recheck);
      observer?.disconnect();
    };
  }, [recheck]);

  return { containerRef, endMarkerRef, reachedEnd, recheck };
}
