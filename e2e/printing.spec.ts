import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { signInAsLabStation, STATION_PEOPLE } from './support/lab-station';
import { insertConfirmedBucket, withDatabase } from './support/db';
import { DEMO } from './support/receiving';

// MM-T15: labels go through the backend print queue to the (fake) network Zebra printer.

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
  const history = page.getByRole('table', { name: `Print history for ${unit.readableId}` });
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

test('MM-T61: print history says who marked an uncertain job printed and how often a failed one tried', async ({
  page,
}) => {
  const unit = await insertConfirmedBucket();
  await withDatabase(async (client) => {
    for (const [status, attempts, createdAt] of [
      ['failed', 3, '2026-10-26T15:00:00Z'],
      ['uncertain', 1, '2026-10-26T16:00:00Z'],
    ] as const) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id,
                                requested_by_name_snapshot, status, attempts, last_error,
                                created_at)
         SELECT 'initial', key, 'sticker-v1', $1, 'Alex Tester', $2, $3,
                'Printer dropped the connection', $4
         FROM printer WHERE is_default
         RETURNING id`,
        [DEMO.at, status, attempts, createdAt],
      );
      await client.query(
        'INSERT INTO print_job_item (print_job_id, storage_unit_id, position) VALUES ($1, $2, 1)',
        [rows[0]!.id, unit.id],
      );
    }
  });

  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${unit.readableId}`);
  const history = page.getByRole('table', { name: `Print history for ${unit.readableId}` });
  await expect(history.getByText('Tried 3 times. Fix the printer, then Reprint.')).toBeVisible();
  await history.getByRole('button', { name: 'Mark as printed' }).click();
  await expect(history.getByText('Marked as printed')).toBeVisible();
  await expect(
    history.getByText(/^The printer result was uncertain; AT · .+ marked it as printed\.$/),
  ).toBeVisible();
});

test('admins see the configured label printer; a technician has no Printers section', async ({
  page,
}) => {
  await signInAs(page, 'admin');
  await page.goto('/settings/printers');
  // STRATA-102: printers are a table; a row opens the printer in the drawer.
  await page
    .getByRole('table', { name: 'Printers' })
    .getByRole('row', { name: /Receiving ZD621/ })
    .click();
  const form = page.getByRole('form', { name: 'Receiving ZD621' });
  await expect(form.getByLabel('IP address or host name')).toHaveValue('127.0.0.1');

  await signInAs(page, 'at');
  await page.goto('/settings/printers');
  // STRATA-100: a hidden section has no page; Settings opens on My access with a notice.
  await expect(page).toHaveURL(/\/settings\/access$/);
  await expect(page.getByText('Printers isn’t available to you.')).toBeVisible();
});

test('STRATA-75: the label printing screen prints to the Zebra, credited to the recording person', async ({
  page,
}) => {
  const unit = await insertConfirmedBucket();
  const jobs = () =>
    withDatabase(async (client) => {
      const { rows } = await client.query<{ kind: string; receiver: string | null }>(
        `SELECT j.kind, j.receiver_name_snapshot AS receiver
         FROM print_job j JOIN print_job_item i ON i.print_job_id = j.id
         WHERE i.storage_unit_id = $1 ORDER BY j.created_at`,
        [unit.id],
      );
      return rows;
    });

  await signInAsLabStation(page, { person: STATION_PEOPLE.jordan });
  await page.goto(`/labels/print/unit/${unit.readableId}`);
  await expect(page.getByRole('heading', { name: 'Print label' })).toBeVisible();
  // STRATA-125: Printed by follows the Recording as chip and can't be edited here.
  const printedBy = page.getByLabel('Printed by');
  await expect(printedBy).toHaveValue('JS · Jordan Smith');
  await expect(printedBy).toHaveAttribute('readonly', '');

  // Save as PDF is never a print job.
  await page.evaluate(() => {
    window.print = () => undefined;
  });
  await page.getByRole('button', { name: 'Save as PDF' }).click();
  expect(await jobs()).toEqual([]);

  await page.getByRole('button', { name: 'Print 1 label' }).click();
  // Honest status: sent to the printer, never "Printed" until a person confirms.
  await expect(page.getByText('Sent to printer')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Printed (confirmed)')).toHaveCount(0);
  expect(await jobs()).toEqual([{ kind: 'reprint', receiver: 'Jordan Smith' }]);
});
