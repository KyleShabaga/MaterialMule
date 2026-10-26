import { describe, expect, it } from 'vitest';
import { ELLIPSIS, measureText, truncateToWidth, wrapList } from './text-fit.js';

describe('measureText', () => {
  it('scales with font height and is wider for wide letters', () => {
    expect(measureText('TH26-01', 60)).toBe(2 * measureText('TH26-01', 30));
    expect(measureText('MMMM', 30)).toBeGreaterThan(measureText('iiii', 30));
  });
});

describe('truncateToWidth', () => {
  it('leaves text that fits alone', () => {
    expect(truncateToWidth('DEMO-2601', 500, 30)).toEqual({ text: 'DEMO-2601', truncated: false });
  });

  it('shortens with an ellipsis to within the width', () => {
    const result = truncateToWidth('Abcdefghij klmnopqrstuvwxyz', 200, 30);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(ELLIPSIS)).toBe(true);
    expect(measureText(result.text, 30)).toBeLessThanOrEqual(200);
  });
});

describe('wrapList', () => {
  it('fills lines in order', () => {
    const result = wrapList(['TH26-01', 'TH26-02', 'TH26-03'], 300, 30, 3);
    expect(result).toEqual({
      lines: ['TH26-01, TH26-02', 'TH26-03'],
      hiddenCount: 0,
      shortenedCount: 0,
    });
  });

  it('ends the last line with "+N more" when items are left over', () => {
    const items = Array.from({ length: 10 }, (_, i) => `TH26-${String(i + 1).padStart(2, '0')}`);
    const result = wrapList(items, 200, 30, 2);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[1]).toMatch(/\+\d+ more$/);
    expect(result.lines[1]).toContain(`+${result.hiddenCount} more`);
    const shown = result.lines
      .join(', ')
      .split(', ')
      .filter((part) => !part.endsWith('more'));
    expect(shown.length + result.hiddenCount).toBe(items.length);
    for (const line of result.lines) expect(measureText(line, 30)).toBeLessThanOrEqual(200);
  });

  it('shortens a single name that is wider than a line', () => {
    const result = wrapList(['A'.repeat(40)], 200, 30, 3);
    expect(result.shortenedCount).toBe(1);
    expect(result.lines[0]!.endsWith(ELLIPSIS)).toBe(true);
  });

  it('returns no lines for no items', () => {
    expect(wrapList([], 200, 30, 3)).toEqual({ lines: [], hiddenCount: 0, shortenedCount: 0 });
  });
});
