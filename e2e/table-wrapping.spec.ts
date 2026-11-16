import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertInventoryFixture } from './support/inventory';

// MM-T58 and MM-T60 (STRATA-79 for Sample Storage): at tablet widths the Projects and Sample Storage tables keep headers, IDs,
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

/**
 * Strata stage tags are fixed-height pills with leading-none (DESIGN.md › Components), so the
 * line-height check above can't measure them: the text inside each one must fit one line box.
 */
async function expectOnePillLine(items: Locator, what: string) {
  const lines = await items.evaluateAll((elements) =>
    elements
      .filter((element) => (element as HTMLElement).offsetParent !== null)
      .map((element) => {
        // Only the words: a wrapped label gives its text node a second line box.
        const tops = new Set<number>();
        for (const node of element.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
        }
        return { text: element.textContent ?? '', lines: tops.size };
      }),
  );
  expect(lines.length, `${what}: something to check`).toBeGreaterThan(0);
  for (const { text, lines: count } of lines)
    expect(count, `${what} "${text}"`).toBeLessThanOrEqual(1);
}

test('T1/T2: Sample Storage and Projects keep words whole from 641 to 1024 px', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1024 });

    await signInAs(page, 'at');
    await page.goto(`/sample-storage?search=${data.tag}`);
    const units = page.getByRole('table', { name: 'Storage units' });
    await expect(units.getByRole('link', { name: data.a1, exact: true })).toBeVisible();
    // STRATA-79: the Strata DataTable hides lower-priority columns instead of wrapping words.
    await expectOneLine(
      units.getByRole('link', { name: /^(BKT|ST|CRE|CT)-/ }),
      `storage unit ID at ${width}px`,
    );
    await expectOneLine(
      units.getByText(data.projectA, { exact: true }),
      `project number at ${width}px`,
    );
    await expectOnePillLine(units.locator('[data-slot="badge"]'), `stage tag at ${width}px`);
    if (await units.getByRole('columnheader', { name: 'Received' }).isVisible()) {
      await expectOneLine(
        units.locator('td').getByText(/^\d{4}-\d{2}-\d{2}$/),
        `received date at ${width}px`,
      );
    }
    // The select-all column holds a checkbox, not words.
    await expectOneLine(units.locator('th:not(:has([role="checkbox"]))'), `header at ${width}px`);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await signInAs(page, 'pe');
    await page.goto(`/projects?search=${data.tag}`);
    // STRATA-83: the Strata DataTable hides lower-priority columns instead of wrapping words.
    const projects = page.getByRole('table', { name: 'All projects' });
    const openA = projects.getByRole('link', { name: `Open project ${data.projectA}` });
    await expect(openA).toBeVisible();
    await expectOneLine(
      projects.getByRole('link', { name: /^Open project / }),
      `project number at ${width}px`,
    );
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await openA.click();
    await page.getByRole('tab', { name: /Storage units/ }).click();
    const projectUnits = page.getByRole('table', { name: `Storage units on ${data.projectA}` });
    await expect(projectUnits.getByRole('link', { name: data.a1, exact: true })).toBeVisible();
    await expectOneLine(
      projectUnits.getByRole('link', { name: /^(BKT|ST|CRE|CT)-/ }),
      `project unit ID at ${width}px`,
    );
    await expectOnePillLine(
      projectUnits.locator('[data-slot="badge"]'),
      `project unit stage at ${width}px`,
    );
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  }
});
