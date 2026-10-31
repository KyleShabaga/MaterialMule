import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { chooseDemoProject, openWizard, uniqueTag } from './support/receiving';

// MM-T36 receiving increment end to end (card T6, T8, T14, T15): bulk soil buckets sharing a bulk
// sample, Shelby tubes from a test hole and from a standalone location, a later receipt joining
// the bulk sample, then Sample Storage (Standard and Compact), search, detail and the label
// preview. Runs on Desktop Chrome (1280px) and Pixel 7; the wide review table (> 1280px) has its
// own test at 1440px. Fictional data only: DEMO-2601, TH26-01, made-up sampling locations.
// Tested-unit removal (AC9–AC11) is not here: it needs real T23/T24 completion evidence.

const STORAGE_ID = /^(BKT|ST)-\d{4}-\d{6}$/;
const RECEIVED = '2026-01-15';
const unitRegion = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

async function issued(page: Page): Promise<string[]> {
  const list = page.getByRole('list', { name: 'New storage units' });
  await expect(list).toBeVisible({ timeout: 15_000 });
  const ids = await list.getByRole('heading').allTextContents();
  for (const id of ids) expect(id).toMatch(STORAGE_ID);
  return ids;
}

/** Picks a test-hole sampling source with the keyboard (type, Enter). */
async function sourceHole(unit: Locator, name: string) {
  await unit.getByRole('radio', { name: 'Test hole' }).check();
  await unit.getByRole('combobox', { name: 'Find or add a test hole' }).fill(name);
  await expect(unit.getByRole('option', { name, exact: true })).toBeVisible();
  await unit.getByRole('combobox', { name: 'Find or add a test hole' }).press('Enter');
  await expect(unit.getByRole('list', { name: 'Selected test hole' })).toHaveText(name + '×');
}

async function standalone(unit: Locator, reference: string) {
  await unit.getByRole('radio', { name: 'Standalone sampling location' }).check();
  await unit.getByRole('textbox', { name: 'Location reference' }).fill(reference);
}

async function depth(unit: Locator, from: string, to: string, depthUnit: 'ft' | 'm') {
  await unit.getByLabel(/^Depth( \(optional\))?$/).fill(from);
  await unit.getByLabel(/^Depth to/).fill(to);
  await unit.getByRole('radio', { name: depthUnit, exact: true }).check();
}

/**
 * A past received date, so these receipts never crowd the dashboard's "Today" list that other
 * specs rely on when the projects run in parallel.
 */
async function useReceivedDate(page: Page) {
  await page.getByLabel(/^Received date/).fill(RECEIVED);
}

/**
 * Bucket 1 + Bucket 2: one new bulk sample B1 from a standalone pit at 1.5–2 m; Shelby tube 3
 * from TH26-01 (T5); Shelby tube 4 from a standalone embankment location at 10–12 ft.
 */
async function fillReceipt(page: Page, tag: string) {
  await chooseDemoProject(page);
  await useReceivedDate(page);
  const first = unitRegion(page, 'Bucket 1');
  await first.getByRole('checkbox', { name: 'Bulk soil sample' }).check();
  await standalone(first, `Pit ${tag}`);
  await first.getByLabel(/^Sample reference/).fill('B1');
  await depth(first, '1.5', '2', 'm');
  await first.getByRole('button', { name: 'Duplicate Bucket 1' }).click();
  await expect(unitRegion(page, 'Bucket 2').getByLabel('Bulk sample', { exact: true })).toHaveValue(
    /^same:/,
  );

  await page.getByRole('button', { name: 'Add bucket' }).click();
  await unitRegion(page, 'Bucket 3').getByLabel('Physical holder').selectOption('shelby_tube');
  const tube3 = unitRegion(page, 'Shelby tube 3');
  await sourceHole(tube3, 'TH26-01');
  await tube3.getByLabel(/^Sample reference/).fill('T5');

  await page.getByRole('button', { name: 'Add bucket' }).click();
  await unitRegion(page, 'Bucket 4').getByLabel('Physical holder').selectOption('shelby_tube');
  const tube4 = unitRegion(page, 'Shelby tube 4');
  await standalone(tube4, `Embankment ${tag}`);
  await depth(tube4, '10', '12', 'ft');
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('T6/T8/T14/T15: bulk buckets, both Shelby sources, a later join, inventory and label', async ({
  page,
}) => {
  const tag = uniqueTag('t36');
  await signInAs(page, 'at');
  await openWizard(page);
  await fillReceipt(page, tag);
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(page.getByRole('heading', { name: 'Bulk samples in this receipt' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  const ids = await issued(page);
  expect(ids.map((id) => id.split('-')[0])).toEqual(['BKT', 'BKT', 'ST', 'ST']);

  const groups = await withDatabase(async (client) => {
    const { rows } = await client.query<{ n: number; letters: number }>(
      `SELECT count(DISTINCT bulk_group_id)::int AS n,
              (SELECT count(*)::int FROM test_hole WHERE name ILIKE $2) AS letters
       FROM storage_unit WHERE readable_id = ANY($1::text[]) AND bulk_group_id IS NOT NULL`,
      [ids, `%${tag}%`],
    );
    return rows[0]!;
  });
  // One bulk group for both buckets; no placeholder test hole made for a standalone source.
  expect(groups).toEqual({ n: 1, letters: 0 });

  // AC2: a later receipt adds a third bucket to that bulk sample by choosing it explicitly.
  await page.getByRole('button', { name: 'Receive another' }).click();
  await chooseDemoProject(page);
  await useReceivedDate(page);
  const later = unitRegion(page, 'Bucket 1');
  await later.getByRole('checkbox', { name: 'Bulk soil sample' }).check();
  await later
    .getByLabel('Bulk sample', { exact: true })
    .selectOption({ label: `Pit ${tag} · B1 · 1.5–2 m — 2 buckets so far` });
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  const [third] = await issued(page);

  // Detail: bucket 3 of 3, siblings listed, own location; search by the displayed identity.
  await page.goto(`/sample-storage/${third}`);
  const bulk = page.getByRole('region', { name: /Bulk sample/ });
  await expect(bulk.getByText('Bulk sample · B1 · bucket 3 of 3')).toBeVisible();
  for (const id of [ids[0]!, ids[1]!]) {
    await expect(bulk.getByRole('link', { name: id })).toBeVisible();
  }
  await noHorizontalScroll(page);

  // T15: the sticker carries the BKT ID and the source name only, never B1 or the depth.
  const image = page
    .getByRole('group', { name: 'Preview label' })
    .getByRole('img', { name: `Label for storage unit ${third}` });
  await expect(image).toBeVisible();
  const src = (await image.getAttribute('src'))!;
  const svg = decodeURIComponent(src.slice(src.indexOf(',') + 1));
  // Exactly the approved sticker text: ID, project number and name, origin, received date.
  const lines = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  expect(lines).toEqual([
    third,
    'DEMO-2601',
    'Riverbank investigation',
    `Pit ${tag}`,
    'RECEIVED',
    RECEIVED,
  ]);

  // Search: the standalone tube by its origin as displayed, the bulk sample by its identity.
  await page.goto(`/sample-storage?search=${encodeURIComponent(`Embankment ${tag}: 10–12 ft`)}`);
  await expect(page.getByRole('link', { name: ids[3]! })).toBeVisible();
  await expect(page.getByText('1 storage unit', { exact: true })).toBeVisible();
  await page.goto(`/sample-storage?search=${encodeURIComponent(`Pit ${tag}: B1 at 1.5-2 m`)}`);
  await expect(page.getByText('3 storage units', { exact: true })).toBeVisible();
  await expect(page.getByText('Bulk sample · B1 · bucket 1 of 3')).toBeVisible();
});

test.describe('wide screens (> 1280px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('review shows one table with sources and the bulk samples; Compact keeps one line', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name === 'phone-chromium', 'Wide layout only on desktop.');
    const tag = uniqueTag('t36w');
    await signInAs(page, 'at');
    await openWizard(page);
    await fillReceipt(page, tag);
    await page.getByRole('button', { name: 'Next: Review' }).click();
    const table = page.getByRole('table', { name: 'Storage units in this receipt' });
    await expect(table).toBeVisible();
    const rows = table.getByRole('row');
    await expect(rows.nth(1)).toContainText(`Pit ${tag}: B1 at 1.5–2 m · bucket 1 of 2`);
    await expect(rows.nth(3)).toContainText('TH26-01: T5');
    await expect(rows.nth(4)).toContainText(`Embankment ${tag}: 10–12 ft`);
    const bulk = page.getByRole('table', { name: 'Bulk samples in this receipt' });
    await expect(bulk.getByRole('row').nth(1)).toContainText('2 buckets');
    await page.getByRole('button', { name: 'Confirm receipt' }).click();
    const ids = await issued(page);

    // The tag is in the two bulk buckets' and the standalone tube's sources (not the TH26-01 tube).
    await page.goto(`/sample-storage?search=${encodeURIComponent(tag)}`);
    await expect(page.getByText('3 storage units', { exact: true })).toBeVisible();
    await page
      .getByRole('group', { name: 'Table view' })
      .getByRole('button', { name: 'Compact' })
      .click();
    const compact = page.locator('.inventory-table-compact');
    await expect(compact).toBeVisible();
    // One line per record: each row is no taller than a single line of text plus padding.
    for (const id of [ids[0]!, ids[1]!, ids[3]!]) {
      const row = compact.getByRole('row').filter({ has: page.getByRole('link', { name: id }) });
      const box = (await row.boundingBox())!;
      expect(box.height).toBeLessThan(48);
    }
    await expect(compact.getByTitle(`Pit ${tag}: B1 at 1.5–2 m · bucket 2 of 2`)).toBeVisible();
    await page
      .getByRole('group', { name: 'Table view' })
      .getByRole('button', { name: 'Standard' })
      .click();
  });
});
