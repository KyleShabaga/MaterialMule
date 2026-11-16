import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import {
  insertConfirmedBucket,
  insertLocation,
  withDatabase,
  type TestLocation,
  type TestUnit,
} from './support/db';

// MM-T81 test plan T2 and T3: Sample Storage shows an open location conflict (STRATA-79: the
// Conflicts tab and the Location conflict tag) and a move still queued on this device. A move
// scanned offline stays in this browser's queue (IndexedDB); the list shows "Pending" beside the
// saved location, which it never replaces. Fictional data only.

type Place = TestLocation;

/** A fictional location with a code unique to this run (both viewports share one database). */
const addLocation = (suffix: string, name: string): Promise<Place> =>
  insertLocation('IM', suffix, name);

/** An open conflict on the unit's saved location, as MM-T28 records one. */
async function openConflict(unit: TestUnit): Promise<void> {
  await withDatabase((client) =>
    client.query(
      `INSERT INTO location_conflict (storage_unit_id, saved_location_id, saved_version)
       SELECT id, current_location_id, version FROM storage_unit WHERE id = $1`,
      [unit.id],
    ),
  );
}

async function scan(page: Page, payload: string) {
  await page.getByRole('textbox', { name: 'Scan or type a label' }).focus();
  await page.keyboard.type(payload);
  await page.keyboard.press('Enter');
}

/** The phone project (390 px): rows are always comfortable there (DENSITY_PHONE_QUERY). */
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 640;

/** Chooses a row density from the table tools' View menu. */
async function chooseDensity(page: Page, density: 'Comfortable' | 'Compact') {
  await page
    .getByRole('toolbar', { name: 'Storage unit tools' })
    .getByRole('button', { name: /^View, / })
    .click();
  await page.getByRole('menuitemradio', { name: density }).click();
  await page.keyboard.press('Escape');
}

const compactRows = (page: Page) =>
  page.locator('[data-slot="data-table"][data-density="compact"] tbody tr');

const inventoryRow = (page: Page, unit: TestUnit) =>
  page.getByRole('row').filter({ has: page.getByRole('link', { name: unit.readableId }) });

test('T2/AC2/AC3: an offline move shows Pending beside the saved location on this device only', async ({
  browser,
  context,
  page,
}) => {
  const staging = await addLocation('S1', 'Staging');
  const c1 = await addLocation('C1', 'Warehouse');
  const u1 = await insertConfirmedBucket();
  await signInAs(page, 'at');
  // Online once, so this computer knows the unit and the locations.
  await page.goto('/sample-storage/move');
  await expect(page.getByRole('heading', { level: 1, name: 'Move storage units' })).toBeVisible();
  await scan(page, `LOC-${staging.code}`);
  await expect(page.getByTestId('move-destination')).toContainText(staging.name);
  await scan(page, u1.readableId);
  await page.getByRole('button', { name: 'Save 1 move' }).click();
  await expect(page.getByTestId('move-row').getByText(/^Moved \d/)).toBeVisible();
  await scan(page, `LOC-${c1.code}`);
  await expect(page.getByTestId('move-destination')).toContainText(c1.name);

  await context.setOffline(true);
  await scan(page, u1.readableId);
  await page.getByRole('button', { name: 'Save 1 move' }).click();
  await expect(
    page.getByTestId('move-row').filter({ hasText: c1.name }).getByText('Not moved yet'),
  ).toBeVisible();
  // Back online for the page loads, but the move still can't reach the server.
  await context.route('**/api/moves', (route) => route.abort('internetdisconnected'));
  await context.setOffline(false);

  await page.goto(`/sample-storage?search=${u1.readableId}`);
  const row = inventoryRow(page, u1);
  // The saved location stays; Pending sits beside it.
  await expect(row).toContainText(staging.name);
  const marker = row.getByTestId('pending-move');
  await expect(marker).toHaveText('Pending');
  await expect(marker).toHaveAttribute('title', new RegExp(c1.name));

  // T3: the compact row keeps the marker and stays short. Compact is a desktop (mouse) density;
  // phones always get comfortable rows.
  if (!isPhone(page)) {
    await chooseDensity(page, 'Compact');
    const compactRow = inventoryRow(page, u1).and(compactRows(page));
    await expect(compactRow.getByTestId('pending-move')).toBeVisible();
    expect((await compactRow.boundingBox())!.height).toBeLessThan(48);
    await chooseDensity(page, 'Comfortable');
  }

  // Another device (its own browser profile) signed in as the same person sees no marker.
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await signInAs(otherPage, 'at');
    await otherPage.goto(`/sample-storage?search=${u1.readableId}`);
    await expect(inventoryRow(otherPage, u1)).toContainText(staging.name);
    await expect(otherPage.getByTestId('pending-move')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('T1/AC1/T3: a unit with an open conflict shows Location conflict on the Conflicts tab, and its compact row stays short', async ({
  page,
}) => {
  const conflicted = await insertConfirmedBucket();
  await openConflict(conflicted);
  await signInAs(page, 'at');

  await page.goto('/sample-storage');
  // STRATA-79: the Conflicts tab (a Stage select when the list is narrow) replaces the filter.
  const tabs = page.getByRole('tablist', { name: 'Stage' });
  // Wait for whichever control this width shows before choosing (isVisible() doesn't wait).
  await expect(tabs.or(page.getByRole('combobox', { name: 'Stage' }))).toBeVisible();
  if (await tabs.isVisible()) {
    await tabs.getByRole('tab', { name: /^Conflicts [\d,]+$/ }).click();
  } else {
    await page.getByRole('combobox', { name: 'Stage' }).click();
    await page.getByRole('option', { name: /^Conflicts [\d,]+$/ }).click();
  }
  await expect(page).toHaveURL(/stage=conflicts/);
  const row = inventoryRow(page, conflicted);
  await expect(row.getByText('Location conflict', { exact: true })).toBeVisible();
  // Compact rows are desktop only; phones keep comfortable rows.
  if (isPhone(page)) return;

  await chooseDensity(page, 'Compact');
  const compactRow = compactRows(page).filter({
    has: page.getByRole('link', { name: conflicted.readableId }),
  });
  await expect(compactRow.getByText('Location conflict', { exact: true })).toBeVisible();
  expect((await compactRow.boundingBox())!.height).toBeLessThan(48);
  await chooseDensity(page, 'Comfortable');
});
