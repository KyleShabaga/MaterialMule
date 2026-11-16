import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket, insertLocation, withDatabase } from './support/db';

// Field Ledger lane C: units chosen on Inventory wait on Move units until a shelf is scanned and
// the move is confirmed; the shelf page then shows them, its cells and its comings and goings.
// Fictional data only (DEMO-2601, TH26-01); the shelf and units are unique to this test.

async function scan(page: Page, payload: string) {
  await page.getByRole('textbox', { name: 'Scan or type a label' }).focus();
  await page.keyboard.type(payload);
  await page.keyboard.press('Enter');
}

test('Inventory selection → Move units here → the shelf page shows the arrivals', async ({
  page,
}) => {
  const shelf = await insertLocation('SH', 'C2', 'Bay C shelf');
  const first = await insertConfirmedBucket();
  const second = await insertConfirmedBucket();
  await signInAs(page, 'pe');

  await page.goto(`/sample-storage?search=${encodeURIComponent(first.readableId)}`);
  await page.getByRole('checkbox', { name: `Select ${first.readableId}` }).check();
  const bar = page.getByRole('group', { name: 'Selection' });
  await expect(bar).toContainText('1 selected');
  await bar.getByRole('button', { name: 'Move', exact: true }).click();

  // STRATA-80: one Move screen; units chosen before a shelf wait for the first shelf scanned.
  await expect(page.getByRole('heading', { level: 1, name: 'Move storage units' })).toBeVisible();
  const waiting = page.getByTestId('move-row').filter({ hasText: first.readableId });
  await expect(waiting).toContainText('Scan a shelf label to set where these go');
  await scan(page, `LOC-${shelf.code}`);
  await expect(page.getByTestId('move-destination')).toContainText(shelf.name);
  await expect(page.getByTestId('move-shelf-after')).toHaveText(
    'Shelf after this move: 1 unit · places not set',
  );
  await scan(page, second.readableId);
  await expect(page.getByTestId('move-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Save 2 moves' }).click();
  await expect(page.getByTestId('move-row').filter({ hasText: first.readableId })).toContainText(
    /Moved \d/,
  );
  await expect(page.getByTestId('move-row').filter({ hasText: second.readableId })).toContainText(
    /Moved \d/,
  );

  await page.goto(`/sample-storage/locations/${shelf.code}`);
  // STRATA-74: the code is the heading; one counted cell per unit (plus empty places when the
  // shelf has a capacity), and the units in the Units here table.
  await expect(page.getByRole('heading', { level: 1, name: shelf.code })).toBeVisible();
  await expect(page.getByText(shelf.name).first()).toBeVisible();
  const places = page.getByRole('list', { name: 'Places on this shelf' });
  await expect(places).toContainText(first.readableId);
  await expect(places).toContainText(second.readableId);
  const units = page.getByRole('table', { name: 'Units here' });
  await expect(units.getByRole('link', { name: first.readableId })).toBeVisible();
  await expect(units.getByRole('link', { name: second.readableId })).toBeVisible();
  const activity = page.getByRole('list', { name: 'Comings and goings' });
  await expect(activity).toContainText(`${first.readableId} arrived`);
  await expect(activity).toContainText('from Receiving lab');

  // The unit page links its location to the same shelf page; the ID never changes.
  await units.getByRole('link', { name: first.readableId }).click();
  await expect(page.getByRole('heading', { level: 1, name: first.readableId })).toBeVisible();
  await page
    .getByRole('region', { name: 'Where it is' })
    .getByRole('link', { name: `${shelf.name} (${shelf.code})` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/sample-storage/locations/${shelf.code}$`));

  const ids = await withDatabase(async (client) => {
    const { rows } = await client.query<{ readable_id: string }>(
      'SELECT readable_id FROM storage_unit WHERE id = ANY($1::uuid[]) ORDER BY readable_id',
      [[first.id, second.id]],
    );
    return rows.map((row) => row.readable_id);
  });
  expect(ids).toEqual([first.readableId, second.readableId].sort());
});
