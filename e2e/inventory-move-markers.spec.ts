import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket, withDatabase, type TestUnit } from './support/db';

// MM-T81 test plan T2 and T3: Sample Storage shows an open location conflict and a move still
// queued on this device. A move scanned offline stays in this browser's queue (IndexedDB); the
// list shows "Pending" beside the saved location, which it never replaces. Fictional data only.

interface Place {
  id: string;
  code: string;
  name: string;
}

async function addLocation(suffix: string, name: string): Promise<Place> {
  const code = `IM${randomInt(1000, 9999)}-${suffix}`;
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, $2, 'warehouse') RETURNING id`,
      [code, `${name} ${code}`],
    );
    return { id: rows[0]!.id, code, name: `${name} ${code}` };
  });
}

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
  await page.locator('.scan-field').focus();
  await page.keyboard.type(payload);
  await page.keyboard.press('Enter');
}

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
  await expect(page.getByTestId('move-row').getByText('Saved')).toBeVisible();
  await scan(page, `LOC-${c1.code}`);
  await expect(page.getByTestId('move-destination')).toContainText(c1.name);

  await context.setOffline(true);
  await scan(page, u1.readableId);
  await expect(
    page.getByTestId('move-row').filter({ hasText: c1.name }).getByText(`Pending → ${c1.name}`),
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

  // T3: the compact row keeps the marker and stays on one line, on the phone viewport too.
  await page
    .getByRole('group', { name: 'Table view' })
    .getByRole('button', { name: 'Compact' })
    .click();
  const compactRow = inventoryRow(page, u1).and(page.locator('.inventory-table-compact tr'));
  await expect(compactRow.getByTestId('pending-move')).toBeVisible();
  expect((await compactRow.boundingBox())!.height).toBeLessThan(48);
  await page
    .getByRole('group', { name: 'Table view' })
    .getByRole('button', { name: 'Standard' })
    .click();

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

test('T1/AC1/T3: a unit with an open conflict shows Conflict, appears under the filter, and its compact row stays on one line', async ({
  page,
}) => {
  const conflicted = await insertConfirmedBucket();
  await openConflict(conflicted);
  await signInAs(page, 'at');

  await page.goto('/sample-storage');
  await page.getByLabel('Location conflict').selectOption({ label: 'Open conflict' });
  await expect(page).toHaveURL(/conflict=open/);
  await expect(page.getByRole('list', { name: 'Active filters' })).toContainText(
    'Location conflict: Open',
  );
  const row = inventoryRow(page, conflicted);
  await expect(row.getByText('Conflict', { exact: true })).toBeVisible();

  await page
    .getByRole('group', { name: 'Table view' })
    .getByRole('button', { name: 'Compact' })
    .click();
  const compact = page.locator('.inventory-table-compact');
  await expect(compact).toBeVisible();
  const compactRow = compact
    .getByRole('row')
    .filter({ has: page.getByRole('link', { name: conflicted.readableId }) });
  await expect(compactRow.getByText('Conflict', { exact: true })).toBeVisible();
  // One line per record, on the phone viewport too.
  expect((await compactRow.boundingBox())!.height).toBeLessThan(48);
  await page
    .getByRole('group', { name: 'Table view' })
    .getByRole('button', { name: 'Standard' })
    .click();
});
