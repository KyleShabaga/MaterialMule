// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY } from './theme';

// MISC-09: the stylesheet and index.html side of the light/dark choice. Read from disk: Vitest
// doesn't load stylesheet contents.

describe('styles.css theme blocks', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const tokens = (block: string) =>
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => `${m[1]}=${m[2]}`);

  it('the OS dark block yields to an explicit light choice, and the explicit dark block matches it', () => {
    const mediaStart = css.indexOf('@media (prefers-color-scheme: dark)');
    const media = css.slice(mediaStart, css.indexOf('color-scheme: dark;', mediaStart));
    expect(media).toContain(":root:not([data-theme='light'])");
    const explicitStart = css.indexOf(":root[data-theme='dark'] {");
    expect(explicitStart).toBeGreaterThan(mediaStart);
    const explicit = css.slice(explicitStart, css.indexOf('color-scheme: dark;', explicitStart));
    expect(tokens(explicit)).toEqual(tokens(media));
    expect(tokens(media).length).toBeGreaterThan(20);
  });

  it('index.html applies the stored choice before the app loads', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    const inline = html.indexOf(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
    expect(inline).toBeGreaterThan(-1);
    expect(inline).toBeLessThan(html.indexOf('src="/src/main.tsx"'));
  });
});
