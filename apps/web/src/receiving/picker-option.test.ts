// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PICKER_OPTION_CLASS } from './picker-option';

// MM-T78 in the Strata project and test-hole pickers: the keyboard highlight uses the same
// --option-active fill (3:1 against the list, picker-highlight-tokens.test.ts) and an inset left
// bar as the receiver picker, and hover never paints the highlighted option.
// (e2e/picker-highlight.spec.ts checks the computed colours in a real browser.)

const classes = PICKER_OPTION_CLASS.split(/\s+/);

describe('picker option highlight', () => {
  it('paints the highlighted option with the shared tokens, not the 1.1:1 accent', () => {
    expect(classes).toContain('aria-selected:bg-(--option-active)');
    expect(classes).toContain('aria-selected:text-(--on-option-active)');
    expect(PICKER_OPTION_CLASS).not.toMatch(/aria-selected:bg-accent/);
  });

  it('adds a non-colour cue: an inset left bar', () => {
    expect(classes).toContain('aria-selected:[box-shadow:inset_4px_0_0_currentColor]');
  });

  it('hover skips the highlighted and disabled options', () => {
    const hover = classes.filter((c) => c.includes(':hover:'));
    expect(hover.length).toBeGreaterThanOrEqual(2);
    for (const c of hover) {
      expect(c).toContain(':not([aria-selected=true])');
      expect(c).toContain(':not([aria-disabled=true])');
    }
  });
});
