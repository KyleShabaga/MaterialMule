import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { insertInventoryFixture } from './support/inventory';
import { receiveThroughApi } from './support/receiving';

// MM-T12: storage unit inventory, search, filters and detail. Every row is fictional and tagged
// per test, so the desktop and phone runs never see each other's units.

test('T6: search, filter, open detail, Back keeps filters, then clear', async ({ page }) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto('/sample-storage');
  await expect(page.getByRole('heading', { level: 1, name: 'Sample Storage' })).toBeVisible();

  // AC1: every word must match somewhere; the disposed unit stays out of Current stock.
  await page.getByRole('searchbox', { name: 'Search' }).fill(`TH26-01 warehouse ${data.tag}`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const count = page.getByRole('status').filter({ hasText: 'storage unit' });
  await expect(count).toHaveText('2 storage units');
  const table = page.getByRole('table', { name: 'Storage units' });
  await expect(table.getByText(data.a1)).toBeVisible();
  await expect(table.getByText(data.b1)).toBeVisible();

  // Filter to project A, then include disposed units.
  await page.getByRole('searchbox', { name: 'Project' }).fill(data.projectA);
  await page.getByRole('button', { name: new RegExp(`^${data.projectA} ·`) }).click();
  await expect(count).toHaveText('1 storage unit');
  await page.getByRole('combobox', { name: 'Status' }).selectOption('all');
  await expect(count).toHaveText('2 storage units');
  await expect(table.getByText(data.aDisposed)).toBeVisible();
  await expect(table.getByText('Disposed')).toBeVisible();
  const chips = page.getByRole('list', { name: 'Active filters' });
  await expect(chips).toContainText(`Project: ${data.projectA}`);
  await expect(chips).toContainText('Status: All statuses');
  const filteredUrl = page.url();
  expect(filteredUrl).toContain('status=all');
  expect(filteredUrl).toContain('projectId=');

  // Open the detail page from the row.
  await page.getByRole('link', { name: data.a1, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Location and retention' })).toContainText(
    data.warehouse,
  );
  const receipt = page.getByRole('region', { name: 'Receipt' });
  await expect(receipt).toContainText('AT · Alex Tester');
  await expect(page.getByRole('list', { name: 'Test hole summaries' })).toContainText(
    'TH26-01: G1–S12',
  );
  await expect(page.getByRole('region', { name: 'Label' })).toBeVisible();

  // Back returns to the same filtered view.
  await page.goBack();
  await expect(page).toHaveURL(filteredUrl);
  await expect(count).toHaveText('2 storage units');
  await expect(chips).toContainText(`Project: ${data.projectA}`);
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue(
    `TH26-01 warehouse ${data.tag}`,
  );

  // AC2 in the UI: received from/through are inclusive.
  await page.getByLabel('Received from').fill('2026-10-01');
  await page.getByLabel('Received through').fill('2026-10-01');
  await expect(count).toHaveText('1 storage unit');
  await expect(table.getByText(data.a1)).toBeVisible();

  // Clear filters: back to Current stock with nothing narrowing it.
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(chips).toHaveCount(0);
  await expect(page).toHaveURL(/\/sample-storage$/);
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('');

  // No-match state.
  await page.getByRole('searchbox', { name: 'Search' }).fill(`${data.tag} nothing-matches-this`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(count).toHaveText('0 storage units');
  await expect(
    page.getByText('No storage units match this search and these filters.'),
  ).toBeVisible();
});

test('AC4: Look up ID opens a unit from a lower-case ID with a trailing space', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto('/sample-storage');
  const lookUp = page.getByRole('textbox', { name: 'Look up ID' });

  await lookUp.fill('BKT-1999-000001');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('alert')).toHaveText('No storage unit found');

  await lookUp.fill(`${data.b1.toLowerCase()} `);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/sample-storage/${data.b1}$`));
  await expect(page.getByRole('heading', { level: 1, name: data.b1 })).toBeVisible();
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
  const search = async (text: string) => {
    await page.getByRole('searchbox', { name: 'Search' }).fill(`${text} ${data.tag}`);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
  };

  // Copy both summaries exactly as shown, en dash included, before any search narrows the table.
  const depth = (
    await row(data.aOtherHole)
      .getByText(/^TH26-02: /)
      .innerText()
  ).trim();
  const sample = (
    await row(data.a1)
      .getByText(/^TH26-01: /)
      .innerText()
  ).trim();
  expect(depth).toBe('TH26-02: 3–5 ft');
  expect(sample).toBe('TH26-01: G1–S12');

  await search(depth);
  await expect(table.locator('tbody tr')).toHaveCount(1);
  await expect(row(data.aOtherHole)).toBeVisible();

  await search(sample);
  // Current stock: a1, b1 and aReceiving hold TH26-01 G1–S12; aDisposed is hidden.
  await expect(table.locator('tbody tr')).toHaveCount(3);
  for (const id of [data.a1, data.b1, data.aReceiving]) await expect(row(id)).toBeVisible();
});

test('T7: at phone width rows become cards with no horizontal scroll', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-chromium', 'phone layout only');
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto(`/sample-storage?search=${data.tag}&status=all`);
  const table = page.getByRole('table', { name: 'Storage units' });
  await expect(table.locator('tbody tr')).toHaveCount(5);

  // Header row hidden; each row is a card that shows ID, project, holes, location and status.
  await expect(table.locator('thead')).toBeHidden();
  const card = table.locator('tbody tr').filter({ hasText: data.a1 });
  await expect(card).toHaveCSS('display', 'block');
  for (const text of [data.a1, data.projectA, 'TH26-01: G1–S12', data.warehouse, 'In stock']) {
    await expect(card).toContainText(text);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.goto(`/sample-storage/${data.a1}`);
  await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Summaries' })).toBeVisible();
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
  await expect(page.getByRole('heading', { level: 1, name: 'Sample Storage' })).toBeVisible();
  const count = page.getByRole('status').filter({ hasText: 'storage unit' });
  await expect(count).toHaveText('2 storage units');
  const table = page.getByRole('table', { name: 'Storage units' });
  await expect(table.getByText(first)).toBeVisible();
  await expect(table.getByText(second)).toBeVisible();
  const chips = page.getByRole('list', { name: 'Active filters' });
  await expect(chips).toContainText('One receipt');
  await expect(chips).toContainText('Status: All statuses');
});

test('MM-T46 T2: with a search active, two quick filter picks are both kept (5 rounds)', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  const count = page.getByRole('status').filter({ hasText: 'storage unit' });
  const chips = page.getByRole('list', { name: 'Active filters' });

  for (let round = 1; round <= 5; round += 1) {
    await page.goto('/sample-storage');
    await page.getByRole('searchbox', { name: 'Search' }).fill(data.tag);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(count).toHaveText('4 storage units');
    await expect(
      page.getByRole('combobox', { name: 'Location' }).getByRole('option', {
        name: data.warehouse,
      }),
    ).toBeAttached();

    // Both picks in the same task, so the second lands before the first has re-rendered.
    await page.evaluate((warehouse) => {
      const pick = (label: string, matches: (option: HTMLOptionElement) => boolean) => {
        const labelEl = [...document.querySelectorAll('label')].find(
          (el) => el.textContent === label,
        )!;
        const select = document.getElementById(labelEl.htmlFor) as HTMLSelectElement;
        select.value = [...select.options].find(matches)!.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      pick('Location', (option) => option.text === warehouse);
      pick('Status', (option) => option.value === 'all');
    }, data.warehouse);

    await expect(chips).toContainText(`Search: ${data.tag}`);
    await expect(chips).toContainText(`Location: ${data.warehouse}`);
    await expect(chips).toContainText('Status: All statuses');
    await expect(count).toHaveText('4 storage units');
    const url = new URL(page.url());
    expect(url.searchParams.get('search'), `round ${round}`).toBe(data.tag);
    expect(url.searchParams.get('locationId'), `round ${round}`).toBeTruthy();
    expect(url.searchParams.get('status'), `round ${round}`).toBe('all');
  }
});
