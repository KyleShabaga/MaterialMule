/// <reference types="node" />
import { readFileSync } from 'node:fs';

// Test helper: the colour tokens in effect for each theme, read from disk (Vitest does not load
// stylesheet contents). strata-theme.css holds the raw values; styles.css maps the Field Ledger
// names onto them with var(). Only hex values count (the display-p3 overrides are skipped).

const strata = readFileSync(new URL('../strata-theme.css', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

/** Declarations in every rule whose selector is exactly `selector` (rules without nested braces). */
export function declarationsFor(css: string, selector: string): [string, string][] {
  const out: [string, string][] = [];
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const rule of css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^{}]*)\\}`, 'g'))) {
    for (const m of rule[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) out.push([m[1]!, m[2]!.trim()]);
  }
  return out;
}

const hexOnly = (pairs: [string, string][]) =>
  pairs.filter(([, value]) => !value.startsWith('color('));

const light = {
  ...Object.fromEntries(hexOnly(declarationsFor(strata, ':root'))),
  ...Object.fromEntries(declarationsFor(styles, ':root')),
};
const dark = {
  ...light,
  ...Object.fromEntries(hexOnly(declarationsFor(strata, ":root[data-theme='dark']"))),
};

/** The hex colour a token resolves to in a theme, following var() references. */
export function resolveToken(theme: 'light' | 'dark', name: string): string {
  const tokens: Record<string, string> = theme === 'light' ? light : dark;
  let value = tokens[name];
  for (let hops = 0; value && hops < 10; hops++) {
    const ref = value.match(/^var\(--([\w-]+)\)$/);
    if (!ref) break;
    value = tokens[ref[1]!];
  }
  if (!value || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(
      `--${name} does not resolve to a hex colour in ${theme} (${value ?? 'missing'})`,
    );
  }
  return value.toLowerCase();
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export const themeSources = { strata, styles };
