import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { insertInventoryFixture } from './support/inventory';
import { receiveThroughApi } from './support/receiving';

// MM-T12 and STRATA-79: storage unit inventory with stage tabs, filter chips, server search and
// the unit drawer. Every row is fictional and tagged per test, so the desktop and phone runs never
// see each other's units. Fixture units sit in a warehouse with no storage term (Short-term), at
// the Receiving lab (Received), or are disposed.

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Opens the toolbar's search box if needed and types `text` (the server search is debounced). */
async function searchFor(page: Page, text: string) {
  const box = page.getByRole('searchbox', { name: 'Search storage units' });
  if (!(await box.isVisible())) {
    await page
      .getByRole('toolbar', { name: 'Storage unit tools' })
      .getByRole('button', { name: 'Search', exact: true })
      .click();
  }
  await box.fill(text);
}

/** Picks a stage tab, or the Stage select when the list is too narrow for the tabs. */
async function chooseStage(page: Page, label: string) {
  const name = new RegExp(`^${escape(label)} [\\d,]+$`);
  const tabs = page.getByRole('tablist', { name: 'Stage' });
  if (await tabs.isVisible()) {
    await tabs.getByRole('tab', { name }).click();
  } else {
    await page.getByRole('combobox', { name: 'Stage' }).click();
    await page.getByRole('option', { name }).click();
  }
}

/** Opens a unit from its row: the drawer on wide screens (then its full page), else the page. */
async function openUnitPage(page: Page, id: string) {
  await page.getByRole('link', { name: id, exact: true }).click();
  const drawer = page.getByRole('region', { name: id });
  if ((page.viewportSize()?.width ?? 1280) >= 1024) {
    await expect(drawer).toBeVisible();
    await drawer.getByRole('link', { name: 'Open as full page' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: id })).toBeVisible();
}

test('T6: search, tabs, filter chips, open a unit, Back keeps the view, then clear', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto('/sample-storage');
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeAttached();

  // AC1: every word must match somewhere. All includes the disposed unit; Short-term doesn't.
  await searchFor(page, `TH26-01 warehouse ${data.tag}`);
  const count = page.getByRole('status').filter({ hasText: 'storage unit' });
  await expect(count).toHaveText('3 storage units');
  const table = page.getByRole('table', { name: 'Storage units' });
  await expect(table.getByText(data.a1)).toBeVisible();
  await expect(table.getByText(data.b1)).toBeVisible();
  await expect(table.getByText(data.aDisposed)).toBeVisible();
  await chooseStage(page, 'Short-term');
  await expect(count).toHaveText('2 storage units');
  await expect(table.getByText(data.aDisposed)).toHaveCount(0);
  await expect(page).toHaveURL(/stage=short_term/);

  // Filter to project A with its chip's picker.
  await page.getByRole('button', { name: 'Add filter' }).click();
  await page.getByRole('menuitem', { name: 'Project' }).click();
  await page.getByRole('combobox', { name: 'Project' }).fill(data.projectA);
  await page.getByRole('option', { name: new RegExp(`^${escape(data.projectA)} ·`) }).click();
  await expect(count).toHaveText('1 storage unit');
  const projectChip = page.getByRole('group', { name: 'Filter Project' });
  await expect(projectChip).toContainText(data.projectA);

  // Back to All: the disposed unit shows, with no current location (MISC-12).
  await chooseStage(page, 'All');
  await expect(count).toHaveText('2 storage units');
  const disposedRow = table.locator('tbody tr').filter({ hasText: data.aDisposed });
  await expect(disposedRow).toContainText('Disposed');
  await expect(disposedRow).toContainText('No location');
  const filteredUrl = new URL(page.url());
  expect(filteredUrl.searchParams.get('projectId')).toBeTruthy();
  expect(filteredUrl.searchParams.get('search')).toBe(`TH26-01 warehouse ${data.tag}`);

  // Open the unit's page from its row.
  await openUnitPage(page, data.a1);
  await expect(page.getByRole('region', { name: 'Where it is' })).toContainText(data.warehouse);
  const receipt = page.getByRole('region', { name: 'Receipt' });
  await expect(receipt).toContainText('AT · Alex Tester');
  await expect(
    page
      .getByRole('table', { name: 'Test hole summaries' })
      .getByRole('row')
      .filter({ hasText: 'TH26-01' }),
  ).toContainText('G1–S12');
  await expect(page.getByRole('region', { name: 'Label' })).toBeVisible();

  // Back returns to the same filtered view.
  await page.goBack();
  await expect(page).toHaveURL(
    new RegExp(`projectId=${filteredUrl.searchParams.get('projectId')}`),
  );
  await expect(count).toHaveText('2 storage units');
  await expect(projectChip).toContainText(data.projectA);
  await expect(page.getByRole('searchbox', { name: 'Search storage units' })).toHaveValue(
    `TH26-01 warehouse ${data.tag}`,
  );

  // AC2 in the UI: received from/through are inclusive.
  await page.getByRole('button', { name: 'Add filter' }).click();
  await page.getByRole('menuitem', { name: 'Received' }).click();
  const received = page.getByRole('group', { name: 'Received between' });
  await received.getByLabel('Received from').fill('2026-10-01');
  await received.getByLabel('Received through').fill('2026-10-01');
  await expect(count).toHaveText('1 storage unit');
  await expect(table.getByText(data.a1)).toBeVisible();
  await page.keyboard.press('Escape');

  // Clear filters: search and every chip go; the tab stays All.
  await page
    .getByRole('group', { name: 'Filters' })
    .getByRole('button', { name: 'Clear filters' })
    .click();
  await expect(page.getByRole('group', { name: /^Filter / })).toHaveCount(0);
  await expect(page).not.toHaveURL(/projectId=|search=|receivedFrom=/);

  // No-match state.
  await searchFor(page, `${data.tag} nothing-matches-this`);
  await expect(count).toHaveText('0 storage units');
  await expect(
    page.getByText('No storage units match this search and these filters.'),
  ).toBeVisible();
});

test('AC4: a lower-case ID with a trailing space finds the unit, which opens', async ({ page }) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto('/sample-storage');

  await searchFor(page, 'bkt-1999-000001');
  await expect(
    page.getByText('No storage units match this search and these filters.'),
  ).toBeVisible();

  await searchFor(page, `${data.b1.toLowerCase()} `);
  const table = page.getByRole('table', { name: 'Storage units' });
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await openUnitPage(page, data.b1);
  await expect(page).toHaveURL(new RegExp(`/sample-storage/${data.b1}$`));
});

test('MM-T59 T3: a summary copied from the table finds its units', async ({ page }) => {
  const data = await insertInventoryFixture();
  await withDatabase((client) =>
    client.query(
      `UPDATE storage_unit_hole_summary
       SET summary_type = 'depth_range', sample_from = NULL, sample_to = NULL,
           depth_from = 3, depth_to = 5, depth_unit = 'ft'
       WHERE storage_unit_id = (SELECT id FROM storage_unit WHERE readable_id = $1)`,
      [data.aOtherHole],
    ),
  );
  await signInAs(page, 'at');
  await page.goto(`/sample-storage?search=${data.tag}`);
  const table = page.getByRole('table', { name: 'Storage units' });
  const row = (id: string) => table.locator('tbody tr').filter({ hasText: id });
  const search = (text: string) => searchFor(page, `${text} ${data.tag}`);

  // Copy both summaries exactly as the Test hole cell gives them (its title holds the full text,
  // en dash included), before any search narrows the table.
  const depth = await row(data.aOtherHole)
    .getByTitle(/^TH26-02: /)
    .getAttribute('title');
  const sample = await row(data.a1)
    .getByTitle(/^TH26-01: /)
    .getAttribute('title');
  expect(depth).toBe('TH26-02: 3–5 ft');
  expect(sample).toBe('TH26-01: G1–S12');

  await search(depth!);
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(row(data.aOtherHole)).toBeVisible();

  // MTR-57: a depth typed with trailing zeros finds the same unit.
  for (const typed of ['3.0–5.0 ft', '5.00 ft']) {
    await search(typed);
    await expect(table.locator('tbody tr')).toHaveCount(1);
    await expect(row(data.aOtherHole)).toBeVisible();
  }

  await search(sample!);
  // All: a1, b1, aReceiving and the disposed aDisposed hold TH26-01 G1–S12.
  await expect(table.locator('tbody tr')).toHaveCount(4);
  for (const id of [data.a1, data.b1, data.aReceiving, data.aDisposed]) {
    await expect(row(id)).toBeVisible();
  }
});

test('T7: at phone width the table keeps ID, project and stage with no horizontal scroll', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-chromium', 'phone layout only');
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto(`/sample-storage?search=${data.tag}`);
  const table = page.getByRole('table', { name: 'Storage units' });
  await expect(table.locator('tbody tr')).toHaveCount(5);
  // The list is under 40rem: the Stage select stands in for the tabs.
  await expect(page.getByRole('combobox', { name: 'Stage' })).toBeVisible();

  // Attribute columns hide by the list's width; ID, project (under the ID here) and stage stay.
  const row = table.locator('tbody tr').filter({ hasText: data.a1 });
  // Project folds under the ID on a phone (its column hides below 28rem); it's still shown.
  await expect(row.getByText(data.projectA).filter({ visible: true })).toBeVisible();
  await expect(row.getByText(data.a1)).toBeVisible();
  await expect(row.getByText('Short-term')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.goto(`/sample-storage/${data.a1}`);
  await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Test hole summaries' })).toBeVisible();
  const detailOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(detailOverflow).toBeLessThanOrEqual(0);
});

test('the dashboard receipt activity opens Sample Storage showing exactly that receipt', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await receiveThroughApi(page, { units: 3 }); // another receipt, which must not show
  const units = await receiveThroughApi(page, { units: 2 });
  const [first, second] = units.map((unit) => unit.suNumber) as [string, string];
  // A unit of the receipt that was later disposed still belongs to it.
  await withDatabase((client) =>
    client.query(`UPDATE storage_unit SET status = 'disposed' WHERE readable_id = $1`, [second]),
  );

  await page.goto('/');
  await page.getByRole('link', { name: new RegExp(`received ${first} and 1 more`) }).click();
  await expect(page).toHaveURL(/\/sample-storage\?receiptId=[\w-]+&status=all$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeAttached();
  const count = page.getByRole('status').filter({ hasText: 'storage unit' });
  await expect(count).toHaveText('2 storage units');
  const table = page.getByRole('table', { name: 'Storage units' });
  await expect(table.getByText(first)).toBeVisible();
  await expect(table.getByText(second)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Filter Receipt' })).toContainText('One receipt');
});

test('MM-T46 T2: with a search active, two quick changes are both kept (5 rounds)', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  const count = page.getByRole('status').filter({ hasText: 'storage unit' });

  for (let round = 1; round <= 5; round += 1) {
    await page.goto(`/sample-storage?search=${data.tag}&type=bucket`);
    await expect(count).toHaveText('5 storage units');
    await expect(page.getByRole('group', { name: 'Filter Type' })).toBeVisible();

    // Both in the same task, so the second lands before the first has re-rendered.
    await page.evaluate(() => {
      const sort = document.querySelector<HTMLButtonElement>('th [data-slot="table-sort-button"]')!;
      const remove = document.querySelector<HTMLButtonElement>(
        '[aria-label="Remove filter Type"]',
      )!;
      sort.click();
      remove.click();
    });

    await expect(page.getByRole('group', { name: 'Filter Type' })).toHaveCount(0);
    await expect(count).toHaveText('5 storage units');
    const url = new URL(page.url());
    expect(url.searchParams.get('search'), `round ${round}`).toBe(data.tag);
    expect(url.searchParams.get('sort'), `round ${round}`).toBe('id');
    expect(url.searchParams.get('dir'), `round ${round}`).toBe('asc');
    expect(url.searchParams.get('type'), `round ${round}`).toBeNull();
  }
});
