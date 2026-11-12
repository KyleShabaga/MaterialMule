// @vitest-environment node
/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { contrast, resolveToken, themeSources } from './theme/css-tokens.testing';

// MM-T78: the picker highlight used --inset on a --card-head list, both #f8fafc in light mode,
// so the keyboard-highlighted option was invisible. Check the tokens themselves in both themes:
// the highlight fill must reach 3:1 against the list and its text 4.5:1 against the fill.
// Strata: the Field Ledger names in styles.css resolve through var() to strata-theme.css.
// (e2e/picker-highlight.spec.ts checks the computed colours in a real browser.)

const css = themeSources.styles;

describe.each(['light', 'dark'] as const)('picker highlight tokens in %s mode', (theme) => {
  it('the highlight fill differs from the list by at least 3:1', () => {
    expect(
      contrast(resolveToken(theme, 'option-active'), resolveToken(theme, 'card-head')),
    ).toBeGreaterThanOrEqual(3);
  });

  it('the highlighted text reaches 4.5:1 on the fill', () => {
    expect(
      contrast(resolveToken(theme, 'on-option-active'), resolveToken(theme, 'option-active')),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('hover is a different colour from the highlight', () => {
    expect(resolveToken(theme, 'option-hover')).not.toBe(resolveToken(theme, 'option-active'));
    expect(resolveToken(theme, 'option-hover')).not.toBe(resolveToken(theme, 'card-head'));
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
