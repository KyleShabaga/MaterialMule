import type { SampleTag } from '@materialmule/shared';
import { useLayoutEffect, useState } from 'react';

// Sample ID tags (MM-T69): the text fitting that shrinks long card values to a legible minimum
// before printing, and the tests line a card prints.

const MIN_FONT_PT = 6.5;

export const testNames = (tag: SampleTag) => tag.tests.map((test) => test.name).join(', ');

/**
 * Shrinks each card value that doesn't fit, down to a legible minimum, and reports the cards
 * whose text still doesn't fit so the preview can say so before anything is printed.
 */
export function useFitText(
  root: React.RefObject<HTMLElement | null>,
  deps: unknown[],
): Set<string> {
  const [overflowing, setOverflowing] = useState<Set<string>>(new Set());
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const found = root.current ? fitValues(root.current) : new Set<string>();
      setOverflowing((current) =>
        current.size === found.size && [...found].every((key) => current.has(key))
          ? current
          : found,
      );
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return overflowing;
}

/** Fits every card value in `container`; returns the keys of cards that still overflow. */
function fitValues(container: HTMLElement): Set<string> {
  const found = new Set<string>();
  for (const value of container.querySelectorAll<HTMLElement>('.tag-value')) {
    value.style.fontSize = '';
    const fits = () =>
      value.scrollWidth <= value.clientWidth + 0.5 &&
      value.scrollHeight <= value.clientHeight + 0.5;
    let size = parseFloat(getComputedStyle(value).fontSize) * 0.75; // px → pt
    while (!fits() && size > MIN_FONT_PT) {
      size = Math.max(MIN_FONT_PT, size - 0.5);
      value.style.fontSize = `${size}pt`;
    }
    if (!fits()) {
      const key = value.closest<HTMLElement>('[data-tag-key]')?.dataset.tagKey;
      if (key) found.add(key);
    }
  }
  return found;
}
