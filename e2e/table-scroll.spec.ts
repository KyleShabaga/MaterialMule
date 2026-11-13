import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { DEMO, receiptsDescribed, receiveThroughApi, uniqueTag } from './support/receiving';
import { removeTestedTube, testedTube } from './support/tested-tube';

// MTR-58: Sample Storage never hides a column's content from the person. STRATA-79 rebuilt it on
// the Strata DataTable, which never scrolls sideways: attribute columns hide by the list's width
// (DESIGN.md › Tables: column priority), identity and state columns (ID, project, stage) always
// show, IDs are never cut, and a cell that clips its text keeps the full text in a title.
// MTR-93: no page scrolls sideways at any width. Desktop only: the widths are set here.

test.skip(({ isMobile }) => isMobile, 'Sets its own widths');

const CSRF = { 'x-materialmule-csrf': '1' };

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * The table card holds every visible cell (no sideways scroll needed), each ID shows in full, and
 * every clipped piece of text carries its full text in a title. Returns the problems found.
 */
async function tableProblems(page: Page): Promise<string[]> {
  return page.locator('[data-slot="data-table"]').evaluate((card) => {
    const problems: string[] = [];
    const right = card.getBoundingClientRect().right;
    if (card.scrollWidth > card.clientWidth + 1) problems.push('the table card scrolls sideways');
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    for (const cell of card.querySelectorAll('th, td')) {
      if (!visible(cell)) continue;
      const box = cell.getBoundingClientRect();
      const text = (cell.textContent ?? '').slice(0, 40);
      if (box.right > right + 0.5) problems.push(`${cell.tagName} "${text}" past the card`);
      for (const el of [cell, ...cell.querySelectorAll<HTMLElement>('*')]) {
        if (!visible(el) || el.scrollWidth <= el.clientWidth + 1) continue;
        // Controls aren't clipped text; a title (on it or around it in the cell) holds the rest.
        if (el.closest('button, [role="checkbox"]')) continue;
        if (el.closest('[title]') && cell.contains(el.closest('[title]'))) continue;
        problems.push(`${cell.tagName} "${text}" clipped without its full text`);
      }
    }
    return problems;
  });
}

test('MTR-58: Standard view scrolls inside its card or wraps; nothing is clipped', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const tag = uniqueTag('mtr58');
  // A disposed-after-testing Shelby tube and two bulk soil buckets ("bucket 1 of 2").
  const tube = await testedTube(page);
  await removeTestedTube(page, tube);
  const receipt = await page.request.post('/api/receipts', {
    headers: CSRF,
    data: {
      idempotencyKey: randomUUID(),
      projectId: DEMO.projectId,
      receivedDate: '2026-10-20',
      receiverUserId: DEMO.at,
      bulkGroups: [
        {
          key: 'b1',
          sourceType: 'standalone_location',
          sourceLocationReference: `Stockpile ${tag}`,
          sampleReference: 'B1',
          depthFrom: 1.5,
          depthTo: 2,
          depthUnit: 'm',
        },
      ],
      units: [1, 2].map((n) => ({
        clientRowId: `row-${n}`,
        unitType: 'bucket',
        bulkGroup: { newGroupKey: 'b1' },
      })),
    },
  });
  expect(receipt.status(), await receipt.text()).toBe(201);

  for (const [search, shows] of [
    [tube.readableId, /Disposed after testing/i],
    [tag, /bucket 2 of 2/i],
  ] as const) {
    for (const width of [1280, 1281, 820, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/sample-storage?status=all&pageSize=50&search=${encodeURIComponent(search)}`,
      );
      const units = page.getByRole('table', { name: 'Storage units' });
      // The tube's stage tag always shows; a bulk bucket's position is in its Test hole cell
      // (and that cell's title), which hides with its column on narrow lists.
      if (search === tube.readableId) await expect(units.getByText(shows).first()).toBeVisible();
      else await expect(units.getByTitle(shows).first()).toBeAttached();
      const what = `${search} at ${width}px`;

      expect(await pageOverflow(page), what).toBeLessThanOrEqual(0);
      expect(await tableProblems(page), what).toEqual([]);
      // Identity and state columns never hide; the IDs show in full.
      for (const heading of ['ID', 'Project', 'Stage']) {
        await expect(units.getByRole('columnheader', { name: heading }), what).toBeVisible();
      }
      for (const link of await units.locator('tbody tr a[href^="/sample-storage/"]').all()) {
        await expect(link, what).toBeVisible();
        expect(
          await link.evaluate((el) => {
            const cell = el.closest('td')!.getBoundingClientRect();
            return el.getBoundingClientRect().right <= cell.right + 0.5;
          }),
          `${what}: an ID is cut`,
        ).toBe(true);
      }
    }
  }
});

const SWEEP = [320, 375, 640, 770, 820, 870, 1024, 1280, 1281, 1440];

test('MTR-93: table pages never scroll sideways from 320 to 1440 px', async ({ page }) => {
  test.setTimeout(120_000);
  const tag = uniqueTag('mtr93');
  await signInAs(page, 'at');
  await receiveThroughApi(page, { description: tag });
  const [receipt] = await receiptsDescribed(tag);
  // `null`: a Strata DataTable page (STRATA-102), which has no scroll region; only the page
  // overflow is swept. `{ table }`: a Strata DataTable page whose table is found by its caption
  // (STRATA-78 rebuilt the receiving log and receipt page on DataTable, which clips per cell
  // instead of scrolling); the page overflow is swept at every width as before.
  const routes: [Parameters<typeof signInAs>[1], string, string | { table: string } | null][] = [
    ['at', '/sample-storage', { table: 'Storage units' }],
    ['at', '/receiving-log', { table: 'Confirmed receipts' }],
    ['at', `/receiving-log/${receipt!.receipt_id}`, { table: 'Storage units in this receipt' }],
    ['at', '/lab-testing?view=list', 'Workboard table'],
    ['lab', '/lab-testing?view=list', 'Workboard table'],
    ['admin', '/admin/lab-tests', null],
    ['admin', '/admin/staff', null],
  ];
  for (const [who, route, table] of routes) {
    await signInAs(page, who);
    await page.setViewportSize({ width: SWEEP[0]!, height: 900 });
    await page.goto(route);
    if (table && typeof table === 'object') {
      await expect(page.getByRole('table', { name: table.table, exact: true })).toBeVisible();
    } else if (table) {
      const region = page.getByRole('region', { name: table, exact: true });
      await expect(region).toBeVisible();
      await expect(region).toHaveAttribute('tabindex', '0');
    } else {
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    for (const width of SWEEP) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => pageOverflow(page), { message: `${who} ${route} at ${width}px` })
        .toBeLessThanOrEqual(0);
    }
  }
});
