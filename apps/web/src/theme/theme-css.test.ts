// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { declarationsFor, themeSources } from './css-tokens.testing';
import { THEME_STORAGE_KEY } from './theme';

// MISC-09: the stylesheet and index.html side of the light/dark choice. Read from disk: Vitest
// doesn't load stylesheet contents.

describe('strata-theme.css theme blocks', () => {
  const css = themeSources.strata;

  it('the OS dark blocks yield to an explicit light choice, and the explicit dark blocks match them', () => {
    const media = declarationsFor(css, ":root:not([data-theme='light'])");
    const explicit = declarationsFor(css, ":root[data-theme='dark']");
    expect(media.length).toBeGreaterThan(100);
    expect(explicit).toEqual(media);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it('index.html applies the stored choice before the app loads', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const inline = html.indexOf(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
    expect(inline).toBeGreaterThan(-1);
    expect(inline).toBeLessThan(html.indexOf('src="/src/main.tsx"'));
  });
});
