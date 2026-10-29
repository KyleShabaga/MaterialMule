import { expect, test, type Locator } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertInventoryFixture } from './support/inventory';
import { signInAsLabStation } from './support/lab-station';
import { bucket, openWizard } from './support/receiving';

// MM-T78: the keyboard-highlighted option (aria-activedescendant, marked aria-selected) must be
// clearly visible in every picker, in both colour schemes. In light mode it used to be painted
// with --inset, the same #f8fafc as the list (--card-head), so it was invisible. Fictional data
// only: DEMO-2601, TH26-01, AT, and per-test inventory fixtures.

interface Highlight {
  list: string;
  active: string;
  /** Highlight fill against the list background (AC1: at least 3:1). */
  fillRatio: number;
  /** Option text against the highlight fill (WCAG AA, 4.5:1). */
  textRatio: number;
  /** The non-colour cue (AC2): the inset left bar. */
  boxShadow: string;
}

async function highlightOf(listbox: Locator): Promise<Highlight> {
  return listbox.evaluate((list) => {
    const parse = (value: string): number[] => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return [0, 0, 0, 0];
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
    const ratio = (x: number[], y: number[]): number => {
      const [hi, lo] = [luminance(x), luminance(y)].sort((m, n) => n - m);
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    };
    const active = list.querySelector('[role="option"][aria-selected="true"]');
    if (!active) throw new Error('no highlighted option');
    const listStyle = getComputedStyle(list);
    const activeStyle = getComputedStyle(active);
    const listBg = parse(listStyle.backgroundColor);
    const activeBg = parse(activeStyle.backgroundColor);
    if (listBg[3] < 0.99 || activeBg[3] < 0.99) throw new Error('expected opaque fills');
    return {
      list: listStyle.backgroundColor,
      active: activeStyle.backgroundColor,
      fillRatio: ratio(activeBg, listBg),
      textRatio: ratio(parse(activeStyle.color), activeBg),
      boxShadow: activeStyle.boxShadow,
    };
  });
}

function expectVisibleHighlight(highlight: Highlight, where: string) {
  expect(highlight.fillRatio, `${where}: ${JSON.stringify(highlight)}`).toBeGreaterThanOrEqual(3);
  expect(highlight.textRatio, `${where}: ${JSON.stringify(highlight)}`).toBeGreaterThanOrEqual(4.5);
  expect(highlight.boxShadow, `${where}: left bar`).toMatch(/inset/);
}

/** AC3: an option under the pointer never looks like the keyboard highlight. */
async function expectHoverDiffers(listbox: Locator, where: string) {
  const options = listbox.locator('[role="option"]:not([aria-disabled="true"])');
  await expect(options.nth(1)).toBeVisible();
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await options.nth(1).hover();
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'false');
  const [active, hovered] = await Promise.all(
    [options.nth(0), options.nth(1)].map((option) =>
      option.evaluate((el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, boxShadow: style.boxShadow };
      }),
    ),
  );
  expect(hovered.background, `${where}: hover fill`).not.toBe(active.background);
  expect(hovered.boxShadow, `${where}: hover has no bar`).toBe('none');

  // The pointer resting on the highlighted option must not hide the highlight.
  await options.nth(0).hover();
  expectVisibleHighlight(await highlightOf(listbox), `${where}: highlighted and hovered`);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`T1: receiver, project and test-hole highlights reach 3:1 in ${colorScheme} mode`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await signInAsLabStation(page);
    await openWizard(page);

    const receiver = page.getByRole('combobox', { name: 'Received by', exact: true });
    await receiver.fill('AT');
    await expect(page.getByRole('option', { name: /^AT · Alex Tester/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expectVisibleHighlight(
      await highlightOf(page.getByRole('listbox', { name: 'Received by options' })),
      `receiver (${colorScheme})`,
    );
    await receiver.press('Enter');

    const project = page.getByRole('combobox', { name: /Find project/ });
    await project.fill('DEMO-2601');
    await expect(
      page.getByRole('option', { name: 'DEMO-2601 · Riverbank investigation · Example Client' }),
    ).toHaveAttribute('aria-selected', 'true');
    expectVisibleHighlight(
      await highlightOf(page.getByRole('listbox', { name: 'Matching projects' })),
      `project (${colorScheme})`,
    );
    await project.press('Enter');
    await expect(page.getByLabel('Project number')).toHaveValue('DEMO-2601');

    const unit = bucket(page, 1);
    const hole = unit.getByRole('combobox', { name: 'Find or add a test hole' });
    await hole.fill('TH26-0');
    const holes = unit.getByRole('listbox', { name: 'Test holes' });
    await expect(holes.getByRole('option', { name: 'TH26-01', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expectVisibleHighlight(await highlightOf(holes), `test hole (${colorScheme})`);
    await expectHoverDiffers(holes, `test hole (${colorScheme})`);
  });

  test(`T1: the Correct details project highlight reaches 3:1 in ${colorScheme} mode`, async ({
    page,
  }) => {
    const data = await insertInventoryFixture();
    await page.emulateMedia({ colorScheme });
    await signInAs(page, 'at');
    await page.goto(`/sample-storage/${data.a1}`);
    await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();

    await page.getByRole('button', { name: 'Correct details' }).click();
    const form = page.getByRole('form', { name: 'Correct details' });
    await form.getByRole('button', { name: 'Change project' }).click();
    // The fixture's two projects share the tag, so both match and the first is highlighted.
    await form.getByRole('combobox', { name: /Find project/ }).fill(data.tag);
    const projects = form.getByRole('listbox', { name: 'Matching projects' });
    await expect(projects.getByRole('option')).toHaveCount(2);
    expectVisibleHighlight(await highlightOf(projects), `correction project (${colorScheme})`);
    await expectHoverDiffers(projects, `correction project (${colorScheme})`);
  });
}
