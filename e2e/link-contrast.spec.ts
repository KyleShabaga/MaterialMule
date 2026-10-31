import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket } from './support/db';
import { insertInventoryFixture } from './support/inventory';

// MM-T57: content links follow the theme. In dark mode they used to keep the browser's default
// blue on the dark page (about 2:1). Every visible link must reach WCAG AA (4.5:1) against the
// background it sits on, in both colour schemes. `a { color }` also covers :visited, and the
// browser hides visited styles from scripts, so unvisited colours are what can be measured.

interface LinkContrast {
  text: string;
  color: string;
  background: string;
  ratio: number;
}

async function linkContrasts(page: Page): Promise<LinkContrast[]> {
  return page.evaluate(() => {
    const parse = (value: string): number[] | null => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    const luminance = ([r, g, b]: number[]): number => {
      const channel = (c: number): number => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    // The first opaque background behind the element, ending at the page.
    const backgroundOf = (element: Element): number[] => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        const rgba = parse(getComputedStyle(node).backgroundColor);
        if (rgba && rgba[3] >= 0.99) return rgba;
      }
      return parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
    };
    return Array.from(document.querySelectorAll('a[href]'))
      .filter((a) => {
        const box = a.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && (a.textContent ?? '').trim() !== '';
      })
      .map((a) => {
        const color = parse(getComputedStyle(a).color) ?? [0, 0, 0, 1];
        const background = backgroundOf(a);
        const [hi, lo] = [luminance(color), luminance(background)].sort((x, y) => y - x);
        return {
          text: (a.textContent ?? '').trim().slice(0, 40),
          color: getComputedStyle(a).color,
          background: `rgb(${background.slice(0, 3).join(', ')})`,
          ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
        };
      });
  });
}

for (const colorScheme of ['dark', 'light'] as const) {
  test(`T1/T2: every content link reaches 4.5:1 in ${colorScheme} mode`, async ({ page }) => {
    const data = await insertInventoryFixture();
    await page.emulateMedia({ colorScheme });
    await signInAs(page, 'pe');

    const pages: { path: string; ready: () => Promise<void> }[] = [
      {
        path: '/',
        ready: () => expect(page.getByRole('heading', { level: 1 })).toBeVisible(),
      },
      {
        path: `/projects?search=${encodeURIComponent(data.tag)}`,
        ready: () =>
          expect(page.getByRole('link', { name: `Open project ${data.projectA}` })).toBeVisible(),
      },
      {
        path: `/sample-storage?search=${encodeURIComponent(data.tag)}`,
        ready: () => expect(page.getByRole('link', { name: data.a1 }).first()).toBeVisible(),
      },
      {
        path: `/sample-storage/${data.a1}`,
        ready: () => expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible(),
      },
      {
        path: '/receiving-log',
        ready: () =>
          expect(page.getByRole('heading', { level: 1, name: 'Receiving Log' })).toBeVisible(),
      },
    ];

    let checked = 0;
    for (const { path, ready } of pages) {
      await page.goto(path);
      await ready();
      const links = await linkContrasts(page);
      checked += links.length;
      const failing = links.filter((link) => link.ratio < 4.5);
      expect(failing, `${path} in ${colorScheme} mode`).toEqual([]);
    }
    expect(checked).toBeGreaterThan(5);

    // The project page's links (project numbers, "N units", Back to Projects) were the QA repro.
    await page.goto(`/projects?search=${encodeURIComponent(data.tag)}`);
    await page.getByRole('link', { name: `Open project ${data.projectA}` }).click();
    await expect(page.getByRole('heading', { level: 1, name: data.projectA })).toBeVisible();
    const projectLinks = await linkContrasts(page);
    expect(projectLinks.length).toBeGreaterThan(0);
    expect(projectLinks.filter((link) => link.ratio < 4.5)).toEqual([]);
  });
}

test('T3: keyboard focus on a content link shows an outline in both themes', async ({ page }) => {
  await signInAs(page, 'pe');
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/projects');
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    const link = page.getByRole('main').getByRole('link').first();
    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    const outline = await link.evaluate((a) => {
      const style = getComputedStyle(a);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(outline.style, colorScheme).not.toBe('none');
    expect(outline.width, colorScheme).toBeGreaterThanOrEqual(2);
  }
});

test('MM-T79: on the storage unit page a hovered link darkens with no underline; other pages keep it', async ({
  page,
}) => {
  const unit = await insertConfirmedBucket();
  await signInAs(page, 'pe');
  const decoration = (link: ReturnType<Page['getByRole']>) =>
    link.evaluate((a) => getComputedStyle(a).textDecorationLine);

  await page.goto(`/sample-storage/${unit.readableId}`);
  await expect(page.getByRole('heading', { level: 1, name: unit.readableId })).toBeVisible();
  const back = page.getByRole('link', { name: '← Back to Sample Storage' });
  const before = await back.evaluate((a) => getComputedStyle(a).color);
  await back.hover();
  await expect.poll(() => decoration(back)).toBe('none');
  expect(await back.evaluate((a) => getComputedStyle(a).color)).not.toBe(before);
  // Keyboard focus still shows its outline.
  await back.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(back).toBeFocused();
  expect(await back.evaluate((a) => getComputedStyle(a).outlineStyle)).not.toBe('none');

  // Elsewhere UI-01's hover underline stays.
  await page.goto('/projects');
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  const other = page.getByRole('main').getByRole('link').first();
  await other.hover();
  await expect.poll(() => decoration(other)).toContain('underline');
});
