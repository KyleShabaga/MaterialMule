import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertInventoryFixture } from './support/inventory';

// MM-T58 and MM-T60: at tablet widths the Projects and Sample Storage tables keep headers, IDs,
// project numbers, dates and badges on one line, and the page never scrolls sideways. Desktop
// only: the widths are set here, and the phone project already covers 412 px.

const WIDTHS = [641, 768, 900, 1024];

test.skip(({ isMobile }) => isMobile, 'Sets its own tablet widths');

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Every visible match is a single line box (not split mid-word onto a second line). */
async function expectOneLine(items: Locator, what: string) {
  const heights = await items.evaluateAll((elements) =>
    elements
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .map((element) => {
        const style = getComputedStyle(element);
        const lineHeight = Number.parseFloat(style.lineHeight) || 20;
        const box = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'] as const;
        const inner = box.reduce(
          (height, side) => height - (Number.parseFloat(style[side]) || 0),
          element.getBoundingClientRect().height,
        );
        return { text: element.textContent ?? '', lines: Math.round(inner / lineHeight) };
      }),
  );
  expect(heights.length, `${what}: something to check`).toBeGreaterThan(0);
  for (const { text, lines } of heights) expect(lines, `${what} "${text}"`).toBeLessThanOrEqual(1);
}

test('T1/T2: Sample Storage and Projects keep words whole from 641 to 1024 px', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1024 });

    await signInAs(page, 'at');
    await page.goto(`/sample-storage?status=all&search=${data.tag}`);
    const units = page.getByRole('table', { name: 'Storage units' });
    await expect(units.getByRole('link', { name: data.a1, exact: true })).toBeVisible();
    await expectOneLine(units.locator('.unit-link'), `storage unit ID at ${width}px`);
    await expectOneLine(units.locator('.project-number'), `project number at ${width}px`);
    await expectOneLine(units.locator('.badge'), `status badge at ${width}px`);
    await expectOneLine(units.locator('.nowrap'), `received date at ${width}px`);
    // Stacked cards (narrow content box) hide the header row; a visible one stays on one line.
    if (await units.locator('thead').isVisible()) {
      await expectOneLine(units.locator('th'), `header at ${width}px`);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await signInAs(page, 'pe');
    await page.goto(`/projects?search=${data.tag}`);
    const projects = page.getByRole('table', { name: 'Projects' });
    await expect(
      projects.getByRole('link', { name: `Open project ${data.projectA}` }),
    ).toBeVisible();
    await expectOneLine(projects.locator('.project-link'), `project number at ${width}px`);
    await expectOneLine(projects.locator('.number'), `count or date at ${width}px`);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await projects.getByRole('link', { name: `Open project ${data.projectA}` }).click();
    const projectUnits = page.getByRole('table', { name: 'Storage units' });
    await expect(projectUnits.getByRole('link', { name: data.a1, exact: true })).toBeVisible();
    await expectOneLine(projectUnits.locator('.unit-link'), `project unit ID at ${width}px`);
    await expectOneLine(projectUnits.locator('.badge'), `project unit badge at ${width}px`);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  }
});
