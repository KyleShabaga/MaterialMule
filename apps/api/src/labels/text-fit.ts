/**
 * Text measurement for the sticker. The printer uses ZPL font 0 (CG Triumvirate Bold Condensed),
 * whose metrics aren't available here, so widths come from a fixed table of per-character
 * advances as a fraction of the font height. The table deliberately overestimates, so text we
 * measure as fitting also fits on the printed label; the preview draws text at exactly the
 * measured width so it shows the space the layout reserves.
 */

const NARROW = new Set([..." !'(),-./:;I[]`fijlrt|"]);
const WIDE = new Set([...'%&@MWmw']);

/** Advance of one character, as a fraction of the font height. */
function charAdvance(char: string): number {
  if (NARROW.has(char)) return 0.34;
  if (WIDE.has(char)) return 0.86;
  if (char >= '0' && char <= '9') return 0.56;
  if (char >= 'A' && char <= 'Z') return 0.64;
  if (char >= 'a' && char <= 'z') return 0.56;
  // Accented letters, symbols and anything unknown: assume a wide-ish glyph.
  return 0.7;
}

/** Width in dots of `text` printed at font height `height` (dots). */
export function measureText(text: string, height: number): number {
  let width = 0;
  for (const char of text) width += charAdvance(char);
  return Math.ceil(width * height);
}

export const ELLIPSIS = '...';

/**
 * `text` unchanged if it fits in `maxWidth`, otherwise the longest prefix (trailing spaces
 * dropped) followed by an ellipsis that fits.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  height: number,
): { text: string; truncated: boolean } {
  if (measureText(text, height) <= maxWidth) return { text, truncated: false };
  const chars = [...text];
  for (let length = chars.length - 1; length > 0; length--) {
    const candidate = chars.slice(0, length).join('').trimEnd() + ELLIPSIS;
    if (measureText(candidate, height) <= maxWidth) return { text: candidate, truncated: true };
  }
  return { text: ELLIPSIS, truncated: true };
}

export interface WrappedList {
  lines: string[];
  /** Items left off the label and summarised as "+N more". */
  hiddenCount: number;
  /** Items that didn't fit on a line by themselves and were shortened. */
  shortenedCount: number;
}

const SEPARATOR = ', ';

function moreText(count: number) {
  return `+${count} more`;
}

/**
 * Lays out `items` in order, comma-separated, on at most `maxLines` lines of `maxWidth`. Items
 * that don't fit are dropped from the end and replaced by "+N more" on the last line.
 */
export function wrapList(
  items: readonly string[],
  maxWidth: number,
  height: number,
  maxLines: number,
): WrappedList {
  let shortenedCount = 0;
  const fitted = items.map((item) => {
    const result = truncateToWidth(item, maxWidth, height);
    if (result.truncated) shortenedCount++;
    return result.text;
  });

  const fits = (parts: string[]) => measureText(parts.join(SEPARATOR), height) <= maxWidth;
  const lines: string[][] = [];
  let placed = 0;
  for (const item of fitted) {
    const current = lines.at(-1);
    if (current && fits([...current, item])) {
      current.push(item);
    } else if (lines.length < maxLines) {
      lines.push([item]);
    } else {
      break;
    }
    placed++;
  }

  let hiddenCount = fitted.length - placed;
  if (hiddenCount > 0) {
    const last = lines[lines.length - 1]!;
    while (last.length > 0 && !fits([...last, moreText(hiddenCount)])) {
      last.pop();
      hiddenCount++;
    }
    last.push(moreText(hiddenCount));
  }

  return { lines: lines.map((parts) => parts.join(SEPARATOR)), hiddenCount, shortenedCount };
}
