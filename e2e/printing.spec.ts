import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket, withDatabase } from './support/db';

// TRP-T15: labels go through the backend print queue to the (fake) network Zebra printer.

test('print, confirm and reprint a storage unit label without changing the unit', async ({
  page,
}) => {
  const unit = await insertConfirmedBucket();
  const unitRow = () =>
    withDatabase(async (client) => {
      const { rows } = await client.query(
        `SELECT readable_id, current_location_id, receipt_id, status, version, updated_at
         FROM storage_unit WHERE id = $1`,
        [unit.id],
      );
      return rows[0];
    });
  const before = await unitRow();

  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${unit.readableId}`);
  await expect(page.getByRole('heading', { name: unit.readableId })).toBeVisible();
  const history = page.getByRole('table');
  await expect(page.getByText('No labels printed yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Print label' }).click();
  const label = page.getByRole('region', { name: 'Label' });
  // The status chip updates live (polling every 2 s) until the printer accepted every byte.
  await expect(label.getByText('Sent to printer')).toBeVisible({ timeout: 15_000 });

  await label.getByRole('button', { name: 'Labels came out OK' }).click();
  await expect(label.getByText('Printed (confirmed)')).toBeVisible();

  await label.getByRole('button', { name: 'Reprint' }).click();
  await expect(label.getByText('Sent to printer')).toBeVisible({ timeout: 15_000 });
  // Newest first: the reprint, then the confirmed initial print (rows stack as cards on phones).
  const rows = history.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Reprint');
  await expect(rows.nth(1)).toContainText('Initial');
  await expect(rows.nth(1)).toContainText('Printed (confirmed)');

  // Printing never changes the unit: same ID, receipt, location, status and version.
  expect(await unitRow()).toEqual(before);
});

test('admins see the configured label printer; others are told it is admin-only', async ({
  page,
}) => {
  await signInAs(page, 'admin');
  await page.goto('/settings/printers');
  const form = page.getByRole('form', { name: 'Receiving ZD621' });
  await expect(form.getByLabel('IP address or host name')).toHaveValue('127.0.0.1');

  await signInAs(page, 'at');
  await page.goto('/settings/printers');
  await expect(page.getByText('Only administrators can change printers.')).toBeVisible();
});
