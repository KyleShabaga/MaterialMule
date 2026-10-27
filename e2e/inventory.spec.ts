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
  await page.getByRole('link', { name: `View ${data.a1}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();
  await expect(page.getByText(`Saved location: ${data.warehouse}`)).toBeVisible();
  const receipt = page.getByRole('region', { name: 'Receipt' });
  await expect(receipt).toContainText('AT — Alex Tester');
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
