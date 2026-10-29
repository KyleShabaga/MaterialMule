// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// MM-T78: the picker highlight used --inset on a --card-head list, both #f8fafc in light mode,
// so the keyboard-highlighted option was invisible. Check the tokens themselves in both themes:
// the highlight fill must reach 3:1 against the list and its text 4.5:1 against the fill.
// (e2e/picker-highlight.spec.ts checks the computed colours in a real browser.)

// Read from disk: Vitest does not load stylesheet contents, not even with ?raw.
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[match[1]!] = match[2]!;
  }
  return out;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function token(theme: Record<string, string>, name: string): string {
  const value = theme[name];
  if (!value) throw new Error(`--${name} is not defined`);
  return value;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const lightBlock = css.slice(
  css.indexOf(':root {'),
  css.indexOf('@media (prefers-color-scheme: dark)'),
);
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkBlock = css.slice(darkStart, css.indexOf('color-scheme: dark;', darkStart));
const light = tokens(lightBlock);
const dark = { ...light, ...tokens(darkBlock) };

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('picker highlight tokens in %s mode', (_name, theme) => {
  it('the highlight fill differs from the list by at least 3:1', () => {
    expect(
      contrast(token(theme, 'option-active'), token(theme, 'card-head')),
    ).toBeGreaterThanOrEqual(3);
  });

  it('the highlighted text reaches 4.5:1 on the fill', () => {
    expect(
      contrast(token(theme, 'on-option-active'), token(theme, 'option-active')),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('hover is a different colour from the highlight', () => {
    expect(token(theme, 'option-hover')).not.toBe(token(theme, 'option-active'));
    expect(token(theme, 'option-hover')).not.toBe(token(theme, 'card-head'));
  });
});

describe('picker option rules', () => {
  it('every picker uses the shared highlight with a non-colour cue', () => {
    const rule = css.match(
      /\.listbox li\[aria-selected='true'\],\s*\.receiver-options li\[aria-selected='true'\]\s*\{([^}]*)\}/,
    );
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain('var(--option-active)');
    expect(rule![1]).toMatch(/box-shadow:\s*inset/);
  });

  it('hover never applies to the highlighted option, so the pointer cannot hide it', () => {
    // Each rule's selector list, one selector per line (Prettier's layout).
    const hoverSelectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
      .flatMap((m) => m[1]!.split(/,\s*\n/))
      .map((sel) => sel.trim())
      .filter((sel) => /^\.(listbox|receiver-options) li\b.*:hover$/.test(sel));
    expect(hoverSelectors.length).toBeGreaterThanOrEqual(2);
    for (const selector of hoverSelectors) {
      expect(selector).toMatch(/:not\([^)]*\[aria-selected='true'\]/);
    }
  });

  it('no option rule paints the highlight with --inset any more', () => {
    expect(css).not.toMatch(/li\[aria-selected='true'\][^{]*\{[^}]*var\(--inset\)/);
  });
});
