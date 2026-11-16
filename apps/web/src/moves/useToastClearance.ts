import { useEffect, useState, type RefObject } from 'react';

// The Move screen's sticky Save bar sits at the bottom, where the app's single toaster (lane 1B,
// bottom right; full width on phones) shows "4 moves saved · Undo". A toast must never cover the
// primary button, so while toasts are on screen the bar is lifted just above the highest one.
// The toaster itself isn't moved: it belongs to the shell.

const GAP_PX = 8;

function scrollportBottom(element: HTMLElement): number {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') {
      return Math.min(node.getBoundingClientRect().bottom, window.innerHeight);
    }
  }
  return window.innerHeight;
}

/** Pixels to keep between the bar's sticky bottom and the scrollport bottom (0 with no toast). */
export function useToastClearance(ref: RefObject<HTMLElement | null>): number {
  const [clearance, setClearance] = useState(0);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bar = ref.current;
        if (!bar) return;
        const box = bar.getBoundingClientRect();
        let top = Infinity;
        for (const toast of document.querySelectorAll<HTMLElement>('[data-sonner-toast]')) {
          if (toast.getAttribute('data-removed') === 'true') continue;
          const rect = toast.getBoundingClientRect();
          if (rect.height === 0 || rect.right <= box.left || rect.left >= box.right) continue;
          top = Math.min(top, rect.top);
        }
        const next =
          top === Infinity ? 0 : Math.max(0, Math.ceil(scrollportBottom(bar) - top + GAP_PX));
        setClearance((current) => (current === next ? current : next));
      });
    };
    const observer = new MutationObserver(measure);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-mounted', 'data-removed', 'data-expanded', 'data-front', 'style'],
    });
    // Toasts slide in: measure again once their transition settles.
    document.addEventListener('transitionend', measure, true);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('transitionend', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [ref]);
  return clearance;
}
