// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// MISC-01: `.program-editor > * + * { display: block }` beat the UA's
// `dialog:not([open]) { display: none }`, so the closed "Discard this draft?" dialog showed under
// New program with live buttons. jsdom does not apply stylesheets, so check the rules as text:
// every selector that sets display or margin on program-editor children must exclude <dialog>.

// Read from disk: Vitest does not load stylesheet contents, not even with ?raw.
const css = readFileSync(new URL('./lab.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

describe('lab.css (MISC-01)', () => {
  it('no program-editor child rule can match a closed dialog', () => {
    const childSelectors = [...css.matchAll(/([^{}]+)\{[^}]*\}/g)]
      .flatMap((rule) => rule[1]!.split(','))
      .map((selector) => selector.trim())
      .filter((selector) => /^\.program-editor\s*>/.test(selector));
    expect(childSelectors.length).toBeGreaterThan(0);
    for (const selector of childSelectors) {
      expect(selector, selector).toMatch(/:not\(dialog\)\s*$/);
    }
  });
});
