import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket, insertLocation, withDatabase } from './support/db';

// Field Ledger lane C: units chosen on Inventory wait on Move units until a shelf is scanned and
// the move is confirmed; the shelf page then shows them, its cells and its comings and goings.
// Fictional data only (DEMO-2601, TH26-01); the shelf and units are unique to this test.

async function scan(page: Page, payload: string) {
  await page.locator('.scan-field').focus();
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

  await expect(page.getByRole('heading', { level: 1, name: 'Move units' })).toBeVisible();
  const waiting = page.getByRole('region', { name: 'Chosen to move' });
  await expect(waiting).toContainText(first.readableId);
  await scan(page, `LOC-${shelf.code}`);
  await expect(page.getByTestId('move-destination')).toContainText(shelf.name);
  await expect(page.getByRole('img', { name: /0 units there now, 1 arriving/ })).toBeVisible();
  await page.getByRole('button', { name: 'Move 1 unit here' }).click();
  await scan(page, second.readableId);
  await expect(page.getByTestId('move-row')).toHaveCount(2);
  await expect(page.getByTestId('move-row').filter({ hasText: first.readableId })).toContainText(
    'Saved',
  );
  await expect(page.getByTestId('move-row').filter({ hasText: second.readableId })).toContainText(
    'Saved',
  );

  await page.goto(`/sample-storage/locations/${shelf.code}`);
  await expect(page.getByRole('heading', { level: 1, name: shelf.name })).toBeVisible();
  const units = page.getByRole('region', { name: 'On this shelf', exact: true });
  await expect(units.getByRole('link', { name: first.readableId })).toBeVisible();
  await expect(units.getByRole('link', { name: second.readableId })).toBeVisible();
  await expect(
    page.getByRole('img', { name: '2 units on this shelf, 0 due for retention' }),
  ).toBeVisible();
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
